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

  subscribe(topic, listener) {
    invariant(typeof listener === "function", "REALTIME_LISTENER_INVALID", "Realtime listener 无效", { status: 500, expose: false });
    this.emitter.on(topic, listener);
    return () => this.emitter.off(topic, listener);
  }
}
