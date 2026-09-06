import type {
  RealtimeCommand,
  RealtimeEnvelope,
  RealtimeSubscribe,
  RealtimeUnsubscribe,
} from "../contracts";
import { prefixedIdentifier } from "../identifiers";

type EventListener = (event: RealtimeEnvelope, context: { initialReplay: boolean }) => void;
type StateListener = (state: "connecting" | "open" | "closed") => void;

const randomRequestId = () => prefixedIdentifier("req");

export class RealtimeClient {
  private socket: WebSocket | null = null;
  private state: "connecting" | "open" | "closed" = "closed";
  private readonly listeners = new Map<string, Set<EventListener>>();
  private readonly stateListeners = new Set<StateListener>();
  private readonly lastSequence = new Map<string, number>();
  private readonly seenEventIds = new Set<string>();
  private readonly initialReplayTopics = new Set<string>();
  private reconnectTimer: number | null = null;
  private reconnectAttempt = 0;
  private explicitlyClosed = false;

  private authenticated = false;

  constructor(
    private readonly url: () => string,
    private readonly token: () => string | null,
  ) {}

  connect() {
    if (this.socket || this.state === "connecting") return;
    this.explicitlyClosed = false;
    this.setState("connecting");
    const socket = new WebSocket(this.url());
    this.socket = socket;
    socket.addEventListener("open", () => {
      this.reconnectAttempt = 0;
      const token = this.token();
      if (!token) {
        // Browsers only let applications send close codes from 3000-4999.
        // Using the protocol-reserved 1008 here threw in Chromium exactly
        // while logout/session rotation was trying to clean up the socket.
        socket.close(4001, "missing session");
        return;
      }
      socket.send(JSON.stringify({ type: "authenticate", token, requestId: randomRequestId() }));
    });
    socket.addEventListener("message", (message) => this.receive(message.data));
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.authenticated = false;
      this.setState("closed");
      if (!this.explicitlyClosed && this.listeners.size) this.scheduleReconnect();
    });
  }

  close() {
    this.explicitlyClosed = true;
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.authenticated = false;
    this.setState("closed");
  }

  reconnectIfSubscribed() {
    const subscribed = this.listeners.size > 0;
    this.close();
    if (subscribed) this.connect();
  }

  subscribe(topic: string, listener: EventListener) {
    const topicListeners = this.listeners.get(topic) ?? new Set<EventListener>();
    const first = topicListeners.size === 0;
    if (first) this.initialReplayTopics.add(topic);
    topicListeners.add(listener);
    this.listeners.set(topic, topicListeners);
    if (first && this.state === "open" && this.authenticated) this.sendSubscription([topic]);
    if (this.state === "closed") this.connect();
    return () => this.unsubscribe(topic, listener);
  }

  onState(listener: StateListener) {
    this.stateListeners.add(listener);
    listener(this.state);
    return () => this.stateListeners.delete(listener);
  }

  send<T>(command: RealtimeCommand<T>) {
    if (this.socket?.readyState !== WebSocket.OPEN || !this.authenticated) throw new Error("实时连接尚未就绪");
    this.socket.send(JSON.stringify(command));
  }

  private unsubscribe(topic: string, listener: EventListener) {
    const topicListeners = this.listeners.get(topic);
    if (!topicListeners) return;
    topicListeners.delete(listener);
    if (topicListeners.size) return;
    this.listeners.delete(topic);
    this.initialReplayTopics.delete(topic);
    if (this.socket?.readyState === WebSocket.OPEN) {
      const message: RealtimeUnsubscribe = { type: "unsubscribe", requestId: randomRequestId(), topics: [topic] };
      this.socket.send(JSON.stringify(message));
    }
  }

  private sendSubscription(topics: string[]) {
    if (!topics.length || this.socket?.readyState !== WebSocket.OPEN) return;
    const resume = Object.fromEntries(topics.map((topic) => [topic, this.lastSequence.get(topic) ?? 0]));
    const message: RealtimeSubscribe = {
      type: "subscribe",
      requestId: randomRequestId(),
      topics,
      resume,
      replayView: "summary",
    };
    this.socket.send(JSON.stringify(message));
  }

  private receive(raw: unknown) {
    if (typeof raw !== "string") return;
    let message: { type?: string; event?: RealtimeEnvelope; replay?: boolean; topics?: string[] };
    try {
      message = JSON.parse(raw) as { type?: string; event?: RealtimeEnvelope };
    } catch {
      return;
    }
    if (message.type === "authenticated") {
      this.authenticated = true;
      this.setState("open");
      this.sendSubscription([...this.listeners.keys()]);
      return;
    }
    if (message.type === "subscribed") {
      for (const topic of message.topics || []) this.initialReplayTopics.delete(topic);
      return;
    }
    if (message.type !== "event" || !message.event) return;
    const event = message.event;
    if (!event.eventId || !event.topic || !Number.isSafeInteger(event.sequence)) return;
    if (this.seenEventIds.has(event.eventId)) return;
    const previous = this.lastSequence.get(event.topic) ?? 0;
    if (event.sequence <= previous) return;
    // Sequence numbers are monotonic cursors, not a promise that every value
    // is retained.  The journal deliberately compacts adjacent token deltas
    // into the newest envelope, so a valid replay commonly contains gaps.
    // Re-subscribing on such a gap replays the same next event forever and can
    // eventually exhaust both the socket buffer and the Gateway heap.
    this.seenEventIds.add(event.eventId);
    if (this.seenEventIds.size > 20_000) this.seenEventIds.clear();
    this.lastSequence.set(event.topic, event.sequence);
    // Opening a topic replays history; reconnecting an existing topic catches
    // up on new changes and must retain their normal refresh side effects.
    const context = { initialReplay: Boolean(message.replay && this.initialReplayTopics.has(event.topic)) };
    for (const listener of this.listeners.get(event.topic) ?? []) listener(event, context);
  }

  private scheduleReconnect() {
    if (this.reconnectTimer !== null) return;
    const delay = Math.min(15_000, 500 * 2 ** this.reconnectAttempt) + Math.random() * 250;
    this.reconnectAttempt += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private setState(next: "connecting" | "open" | "closed") {
    this.state = next;
    for (const listener of this.stateListeners) listener(next);
  }
}
