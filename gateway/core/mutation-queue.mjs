import { AsyncLocalStorage } from "node:async_hooks";

import { invariant } from "./errors.mjs";

export class ActorMutationQueue {
  #tails = new Map();
  #context = new AsyncLocalStorage();

  #key(actor) {
    invariant(actor?.actorType && actor?.actorId, "ACTOR_CONTEXT_REQUIRED", "写队列需要 ActorContext", { status: 500, expose: false });
    return `${actor.actorType}:${actor.actorId}`;
  }

  async run(actor, operation) {
    invariant(typeof operation === "function", "MUTATION_OPERATION_INVALID", "写队列操作必须是函数", { status: 500, expose: false });
    const key = this.#key(actor);
    if (this.#context.getStore() === key) return operation();
    const previous = this.#tails.get(key) || Promise.resolve();
    let release;
    const turn = new Promise((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => turn);
    this.#tails.set(key, tail);
    await previous.catch(() => undefined);
    try {
      return await this.#context.run(key, operation);
    } finally {
      release();
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    }
  }

  get pendingActors() {
    return this.#tails.size;
  }
}

export const defaultActorMutationQueue = new ActorMutationQueue();
