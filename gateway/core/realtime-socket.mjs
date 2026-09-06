import crypto from "node:crypto";

import { apiFailure, invariant } from "./errors.mjs";

const TOPIC_PATTERN = /^[a-z][a-z0-9._:-]{0,191}$/;

function parseMessage(value) {
  let parsed;
  try { parsed = JSON.parse(Buffer.isBuffer(value) ? value.toString("utf8") : String(value)); } catch {
    invariant(false, "REALTIME_MESSAGE_INVALID", "Realtime 消息不是有效 JSON", { status: 400 });
  }
  invariant(parsed && typeof parsed === "object" && !Array.isArray(parsed), "REALTIME_MESSAGE_INVALID", "Realtime 消息结构无效", { status: 400 });
  return parsed;
}

function send(socket, value, maxBufferedBytes) {
  invariant(socket.bufferedAmount <= maxBufferedBytes, "REALTIME_CLIENT_TOO_SLOW", "Realtime 客户端消费过慢", { status: 429, retryable: true });
  socket.send(JSON.stringify(value));
}

export class RealtimeSocketServer {
  constructor({ auth, brokerForActor, authorizeTopic, authenticationTimeoutMs = 10_000, heartbeatIntervalMs = 25_000, maxBufferedBytes = 2 * 1024 * 1024 }) {
    invariant(auth?.resolveSession && typeof brokerForActor === "function" && typeof authorizeTopic === "function", "REALTIME_SERVER_DEPENDENCY_INVALID", "Realtime server 缺少依赖", { status: 500, expose: false });
    this.auth = auth;
    this.brokerForActor = brokerForActor;
    this.authorizeTopic = authorizeTopic;
    this.authenticationTimeoutMs = authenticationTimeoutMs;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.maxBufferedBytes = maxBufferedBytes;
  }

  attach(socket) {
    const state = { session: null, token: null, broker: null, subscriptions: new Map(), alive: true, closed: false };
    let expiryTimer;
    let unsubscribeRevocation;
    let commandTail = Promise.resolve();
    const cleanup = () => {
      if (state.closed) return;
      state.closed = true;
      clearTimeout(authenticationTimer);
      clearInterval(heartbeatTimer);
      clearTimeout(expiryTimer);
      unsubscribeRevocation?.();
      for (const unsubscribe of state.subscriptions.values()) unsubscribe();
      state.subscriptions.clear();
    };
    const fail = (error, requestId = null) => {
      const failure = apiFailure(error, { requestId: requestId || `req_${crypto.randomUUID()}` }).body;
      try { send(socket, { type: "error", ...failure }, this.maxBufferedBytes); } catch { /* close below */ }
      if (["SESSION_TOKEN_REQUIRED", "SESSION_INVALID", "SESSION_EXPIRED", "SESSION_REVOKED", "REALTIME_CLIENT_TOO_SLOW"].includes(failure.error.code)) {
        socket.close?.(1008, failure.error.code);
        cleanup();
      }
    };
    const authenticationTimer = setTimeout(() => {
      if (!state.session) fail(Object.assign(new Error("Realtime 认证超时"), { code: "SESSION_TOKEN_REQUIRED", status: 401 }));
    }, this.authenticationTimeoutMs);
    authenticationTimer.unref?.();
    const heartbeatTimer = setInterval(() => {
      if (state.closed) return;
      if (!state.alive) {
        socket.close?.(1001, "heartbeat timeout");
        cleanup();
        return;
      }
      state.alive = false;
      socket.ping?.();
      if (state.token) void this.auth.resolveSession(state.token).catch(fail);
    }, this.heartbeatIntervalMs);
    heartbeatTimer.unref?.();

    socket.on?.("pong", () => { state.alive = true; });
    socket.on?.("close", cleanup);
    socket.on?.("error", cleanup);
    const handleMessage = async (raw) => {
      if (state.closed) return;
      let message;
      try {
        message = parseMessage(raw);
        if (!state.session) {
          invariant(message.type === "authenticate" && typeof message.token === "string", "SESSION_TOKEN_REQUIRED", "Realtime 首条消息必须认证", { status: 401 });
          state.session = await this.auth.resolveSession(message.token);
          state.token = message.token;
          if (state.closed) return;
          unsubscribeRevocation = this.auth.onSessionRevoked?.(({ actorId, sessionId }) => {
            if (state.session.actor.actorId === actorId && state.session.actor.sessionId === sessionId) fail(Object.assign(new Error("登录会话已退出"), { code: "SESSION_REVOKED", status: 401 }));
          });
          const expire = () => {
            const remaining = Date.parse(state.session.expiresAt) - Date.now();
            if (!Number.isFinite(remaining)) return;
            if (remaining <= 0) { fail(Object.assign(new Error("登录会话已过期"), { code: "SESSION_EXPIRED", status: 401 })); return; }
            expiryTimer = setTimeout(expire, Math.min(remaining, 2_147_483_647));
            expiryTimer.unref?.();
          };
          expire();
          state.broker = await this.brokerForActor(state.session.actor, state.session);
          if (state.closed) return;
          clearTimeout(authenticationTimer);
          send(socket, { type: "authenticated", requestId: message.requestId || null, actor: state.session.profile }, this.maxBufferedBytes);
          return;
        }
        if (message.type === "subscribe") {
          state.session = await this.auth.resolveSession(state.token);
          if (state.closed) return;
          invariant(Array.isArray(message.topics) && message.topics.length <= 100, "REALTIME_TOPICS_INVALID", "订阅 topic 无效", { status: 400 });
          for (const topic of [...new Set(message.topics.map(String))]) {
            invariant(TOPIC_PATTERN.test(topic), "REALTIME_TOPIC_INVALID", "Realtime topic 无效", { status: 400 });
            const authorizedTopic = await this.authorizeTopic({ actor: state.session.actor, session: state.session, topic });
            const brokerTopic = typeof authorizedTopic === "string" ? authorizedTopic : topic;
            invariant(TOPIC_PATTERN.test(brokerTopic), "REALTIME_TOPIC_INVALID", "Realtime 内部 topic 无效", { status: 500, expose: false });
            const afterSequence = Number(message.resume?.[topic] || 0);
            invariant(Number.isSafeInteger(afterSequence) && afterSequence >= 0, "REALTIME_CURSOR_INVALID", "afterSequence 无效", { status: 400 });
            if (state.closed) return;
            state.subscriptions.get(topic)?.();
            let replaying = true;
            let bufferedBytes = 0;
            let cursor = afterSequence;
            const buffer = [];
            const deliver = (event, summary = false) => {
              if (state.closed || event.sequence <= cursor) return;
              send(socket, { type: "event", event: { ...(summary ? summarizeTimelineEvent(event) : event), topic } }, this.maxBufferedBytes);
              cursor = event.sequence;
            };
            const unsubscribe = state.broker.subscribe(brokerTopic, (event) => {
              try {
                if (replaying) {
                  bufferedBytes += Buffer.byteLength(JSON.stringify(event));
                  invariant(bufferedBytes <= this.maxBufferedBytes, "REALTIME_CLIENT_TOO_SLOW", "Realtime 回放缓冲已满，请重连", { status: 429, retryable: true });
                  buffer.push(event);
                } else deliver(event);
              } catch (error) { fail(error, message.requestId); }
            });
            state.subscriptions.set(topic, unsubscribe);
            try {
              let upperBound;
              for (;;) {
                const replay = await state.broker.replay(brokerTopic, { afterSequence: cursor });
                if (state.closed) return;
                upperBound ??= replay.lastSequence ?? replay.events.at(-1)?.sequence ?? cursor;
                const before = cursor;
                for (const event of replay.events) if (event.sequence <= upperBound) deliver(event, message.replayView === "summary");
                if (!replay.hasMore || cursor >= upperBound || cursor === before) break;
              }
              for (const event of buffer.sort((a, b) => a.sequence - b.sequence)) deliver(event);
              replaying = false;
            } catch (error) {
              unsubscribe();
              state.subscriptions.delete(topic);
              throw error;
            }
          }
          send(socket, { type: "subscribed", requestId: message.requestId || null, topics: [...state.subscriptions.keys()] }, this.maxBufferedBytes);
          return;
        }
        if (message.type === "unsubscribe") {
          for (const topic of message.topics || []) {
            state.subscriptions.get(topic)?.();
            state.subscriptions.delete(topic);
          }
          send(socket, { type: "unsubscribed", requestId: message.requestId || null, topics: [...state.subscriptions.keys()] }, this.maxBufferedBytes);
          return;
        }
        if (message.type === "heartbeat") {
          state.alive = true;
          send(socket, { type: "heartbeat", occurredAt: new Date().toISOString() }, this.maxBufferedBytes);
          return;
        }
        invariant(false, "REALTIME_COMMAND_INVALID", "Realtime 命令无效", { status: 400 });
      } catch (error) {
        fail(error, message?.requestId);
      }
    };
    socket.on?.("message", (raw) => {
      commandTail = commandTail.then(() => handleMessage(raw)).catch(fail);
    });
    return cleanup;
  }
}
import { summarizeTimelineEvent } from "../../shared/timeline-projection.mjs";
