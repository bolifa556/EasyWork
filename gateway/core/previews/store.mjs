export class MemoryPreviewSessionStore {
  #sessions = new Map();

  get(previewId) {
    return this.#sessions.get(previewId) || null;
  }

  set(session) {
    this.#sessions.set(session.id, session);
    return session;
  }

  delete(previewId) {
    return this.#sessions.delete(previewId);
  }

  values() {
    return this.#sessions.values();
  }

  get size() {
    return this.#sessions.size;
  }
}
