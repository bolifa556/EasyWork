import { EventEmitter } from "node:events";

import { invariant } from "./errors.mjs";

export class RealtimeBroker {
  constructor({ journal }) {
    invariant(journal?.append && journal?.replay, "REALTIME_JOURNAL_REQUIRED", "RealtimeBroker 需要 journal", { status: 500, expose: false });
    this.journal = journal;
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(1_000);
  }

  async append(topic, event) {
    const envelope = await this.journal.append(topic, event);
    this.emitter.emit(topic, structuredClone(envelope));
    return envelope;
  }

  replay(topic, options) {
    return this.journal.replay(topic, options);
  }

  async *replayPages(topic, options = {}) {
    if (this.journal.replayPages) {
      yield* this.journal.replayPages(topic, options);
      return;
    }
    // Non-persistent brokers (e.g. external producers) can still page through
    // the broker contract without a journal snapshot implementation.
    let afterSequence = options.afterSequence ?? 0;
    for (;;) {
      const page = await this.replay(topic, { ...options, afterSequence });
      yield page;
      const next = page.nextAfterSequence ?? page.events.at(-1)?.sequence ?? afterSequence;
      if (!page.hasMore || next <= afterSequence) return;
      afterSequence = next;
    }
  }

  details(topic, eventIds) {
    return this.journal.details(topic, eventIds);
  }

  subscribe(topic, listener) {
    invariant(typeof listener === "function", "REALTIME_LISTENER_INVALID", "Realtime listener 无效", { status: 500, expose: false });
    this.emitter.on(topic, listener);
    return () => this.emitter.off(topic, listener);
  }
}
