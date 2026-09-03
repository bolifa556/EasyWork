import { invariant } from "../errors.mjs";

const actorKey = (actor) => `${actor.actorType}:${actor.actorId}`;
const currentMs = (clock) => Number((clock || Date.now)());
const currentIso = (clock) => new Date(currentMs(clock)).toISOString();

class ActorSshWorker {
  constructor({ actor, registry, transportFactory, clock, keepAliveIntervalMs, inactiveTtlMs, reserveConnection }) {
    this.actor = actor;
    this.registry = registry;
    this.transportFactory = transportFactory;
    this.clock = clock;
    this.keepAliveIntervalMs = keepAliveIntervalMs;
    this.inactiveTtlMs = inactiveTtlMs;
    this.reserveConnection = reserveConnection;
    this.sessions = new Map();
    this.connecting = new Map();
    this.connectingWithTwoFactor = new Map();
  }

  async connect(serverId, options = {}) {
    const existing = this.sessions.get(serverId);
    if (existing?.session && await existing.session.isAlive?.() !== false) {
      const current = await this.registry.get(serverId);
      if (current.connection.status === "connected" && !current.connection.lastError) return structuredClone(existing.summary);
      const summary = await this.registry.setConnection(serverId, {
        ...current.connection,
        status: "connected",
        desiredConnection: true,
        disconnectedAt: null,
        lastError: null,
      });
      existing.summary = summary;
      return structuredClone(summary);
    }
    if (this.connecting.has(serverId)) {
      const active = this.connecting.get(serverId);
      const activeUsedTwoFactor = Boolean(this.connectingWithTwoFactor.get(serverId));
      try {
        return await active;
      } catch (error) {
        // Gateway startup may still be restoring a desired connection without
        // an interactive code when the user submits a fresh 2FA value.  The
        // user's request must retry with that code instead of inheriting the
        // background attempt's authentication failure.
        if (String(options.twoFactorCode || "").trim() && !activeUsedTwoFactor) {
          return this.connect(serverId, options);
        }
        throw error;
      }
    }
    const promise = this.#connect(serverId, options).finally(() => {
      if (this.connecting.get(serverId) === promise) {
        this.connecting.delete(serverId);
        this.connectingWithTwoFactor.delete(serverId);
      }
    });
    this.connecting.set(serverId, promise);
    this.connectingWithTwoFactor.set(serverId, Boolean(String(options.twoFactorCode || "").trim()));
    return promise;
  }

  async #connect(serverId, options) {
    const releaseReservation = this.reserveConnection ? await this.reserveConnection(serverId) : (() => undefined);
    try {
      const { profile, connection } = await this.registry.get(serverId);
      const network = await this.registry.networkPolicy?.assertAllowed?.(profile);
      await this.registry.setConnection(serverId, { ...connection, status: "connecting", desiredConnection: true, lastError: null });
      let session;
      try {
        const credential = await this.registry.vault.get(serverId);
        session = await this.transportFactory.connect({
          actor: this.actor,
          profile,
          credential,
          twoFactorCode: options.twoFactorCode || null,
          expectedFingerprint: profile.fingerprint,
          acceptedFingerprint: options.acceptedFingerprint || null,
          resolvedAddress: network?.resolvedAddress || null,
          keepAliveIntervalMs: this.keepAliveIntervalMs,
        });
        invariant(session && typeof session.exec === "function" && typeof session.close === "function", "SSH_TRANSPORT_INVALID", "SSH transport 未返回有效 session", { status: 500, expose: false });
        const fingerprint = String(session.fingerprint || "");
        if (!profile.fingerprint) {
          invariant(options.acceptedFingerprint === fingerprint, "SSH_HOST_KEY_CONFIRMATION_REQUIRED", "请确认 SSH 主机指纹后重新连接", {
            status: 409,
            details: { serverId, fingerprint },
          });
        }
        const identifiedProfile = await this.registry.setFingerprint(serverId, fingerprint);
        const connectedAt = currentIso(this.clock);
        const summary = await this.registry.setConnection(serverId, {
          status: "connected",
          desiredConnection: true,
          connectedAt,
          disconnectedAt: null,
          lastActiveAt: connectedAt,
          lastKeepAliveAt: connectedAt,
          generation: Number(connection.generation || 0) + 1,
          lastError: null,
        });
        this.sessions.set(serverId, { session, profile: identifiedProfile, summary });
        session.onClose?.((error) => this.#unexpectedClose(serverId, session, error));
        return structuredClone(summary);
      } catch (error) {
        await session?.close?.().catch(() => undefined);
        const confirmationRequired = error?.code === "SSH_HOST_KEY_CONFIRMATION_REQUIRED";
        await this.registry.setConnection(serverId, {
          status: confirmationRequired ? "disconnected" : "failed",
          desiredConnection: confirmationRequired ? false : Boolean(options.preserveIntentOnFailure),
          connectedAt: null,
          disconnectedAt: currentIso(this.clock),
          lastError: confirmationRequired ? null : { code: error?.code || "SSH_CONNECTION_FAILED", message: error?.message || "SSH 连接失败" },
        });
        throw error;
      }
    } finally {
      releaseReservation();
    }
  }

  async #unexpectedClose(serverId, session, error) {
    const runtime = this.sessions.get(serverId);
    // A delayed close event from a replaced session must never tear down the
    // newer live session or temporarily publish a failed connection state.
    if (!runtime || runtime.session !== session) return;
    this.sessions.delete(serverId);
    const current = await this.registry.get(serverId).catch(() => null);
    if (!current) return;
    await this.registry.setConnection(serverId, {
      ...current.connection,
      status: error ? "failed" : "disconnected",
      desiredConnection: true,
      disconnectedAt: currentIso(this.clock),
      lastError: error ? { code: error.code || "SSH_CONNECTION_LOST", message: error.message || "SSH 连接已中断" } : null,
    });
  }

  async disconnect(serverId) {
    if (this.connecting.has(serverId)) {
      await this.connecting.get(serverId).catch(() => undefined);
    }
    const runtime = this.sessions.get(serverId);
    this.sessions.delete(serverId);
    const current = await this.registry.get(serverId);
    if (!runtime && current.connection.status === "disconnected" && current.connection.desiredConnection === false) {
      return structuredClone(current.connection);
    }
    await runtime?.session.close();
    return this.registry.setConnection(serverId, {
      ...current.connection,
      status: "disconnected",
      desiredConnection: false,
      disconnectedAt: currentIso(this.clock),
      lastError: null,
    });
  }

  async execute(serverId, command, options = {}) {
    invariant(typeof command === "string" && command.trim(), "SSH_COMMAND_REQUIRED", "SSH command 不能为空", { status: 400 });
    return this.withSession(serverId, (session) => session.exec(command, options));
  }

  async withSession(serverId, operation) {
    invariant(typeof operation === "function", "SSH_SESSION_OPERATION_REQUIRED", "SSH session 操作无效", { status: 500, expose: false });
    let runtime = this.sessions.get(serverId);
    if (runtime && await runtime.session.isAlive?.() === false) {
      await this.#unexpectedClose(serverId, runtime.session, Object.assign(new Error("SSH 连接已关闭"), { code: "SSH_CONNECTION_CLOSED" }));
      runtime = null;
    }
    if (!runtime) {
      const current = await this.registry.get(serverId);
      invariant(current.connection.desiredConnection, "SSH_NOT_CONNECTED", "SSH 尚未连接", { status: 409 });
      await this.connect(serverId, { preserveIntentOnFailure: true });
      runtime = this.sessions.get(serverId);
    }
    invariant(runtime, "SSH_NOT_CONNECTED", "SSH 尚未连接", { status: 409 });
    return operation(runtime.session, structuredClone(runtime.profile));
  }

  async touch(serverId) {
    const runtime = this.sessions.get(serverId);
    invariant(runtime, "SSH_NOT_CONNECTED", "SSH 尚未连接", { status: 409 });
    const current = await this.registry.get(serverId);
    const summary = await this.registry.setConnection(serverId, {
      ...current.connection,
      lastActiveAt: currentIso(this.clock),
      lastError: null,
    });
    runtime.summary = summary;
    return structuredClone(summary);
  }

  async restore() {
    const profiles = await this.registry.list();
    return Promise.all(profiles.filter((entry) => entry.connection.desiredConnection || entry.connection.status !== "disconnected").map(async (item) => ({
      serverId: item.profile.id,
      status: "disconnected",
      connection: await this.registry.setConnection(item.profile.id, {
        ...item.connection,
        status: "disconnected",
        desiredConnection: false,
        disconnectedAt: currentIso(this.clock),
        lastError: null,
      }),
    })));
  }

  async maintain() {
    const now = currentMs(this.clock);
    const results = [];
    const desiredWithoutSession = (await this.registry.list()).filter((entry) => (
      entry.connection.desiredConnection
      && !this.sessions.has(entry.profile.id)
      && !this.connecting.has(entry.profile.id)
    ));
    const reconnectResults = await Promise.all(desiredWithoutSession.map(async (entry) => {
      const lastActive = Date.parse(entry.connection.lastActiveAt || entry.connection.connectedAt || 0);
      if (Number.isFinite(lastActive) && now - lastActive >= this.inactiveTtlMs) {
        await this.registry.setConnection(entry.profile.id, {
          ...entry.connection,
          status: "disconnected",
          desiredConnection: false,
          disconnectedAt: currentIso(this.clock),
          lastError: null,
        });
        return { serverId: entry.profile.id, action: "expired" };
      }
      try {
        await this.connect(entry.profile.id, { preserveIntentOnFailure: true });
        return { serverId: entry.profile.id, action: "reconnected" };
      } catch {
        return { serverId: entry.profile.id, action: "reconnect-failed" };
      }
    }));
    results.push(...reconnectResults);
    for (const [serverId, runtime] of [...this.sessions.entries()]) {
      const state = await this.registry.get(serverId);
      const lastActive = Date.parse(state.connection.lastActiveAt || state.connection.connectedAt || 0);
      if (Number.isFinite(lastActive) && now - lastActive >= this.inactiveTtlMs) {
        await this.disconnect(serverId);
        results.push({ serverId, action: "expired" });
        continue;
      }
      const lastKeepAlive = Date.parse(state.connection.lastKeepAliveAt || 0);
      if (!Number.isFinite(lastKeepAlive) || now - lastKeepAlive >= this.keepAliveIntervalMs) {
        try {
          await runtime.session.keepAlive?.();
          const summary = await this.registry.setConnection(serverId, { ...state.connection, lastKeepAliveAt: currentIso(this.clock) });
          runtime.summary = summary;
          results.push({ serverId, action: "kept-alive" });
        } catch (error) {
          await this.#unexpectedClose(serverId, runtime.session, error);
          results.push({ serverId, action: "lost" });
        }
      }
    }
    return results;
  }

  async close() {
    for (const [serverId] of [...this.sessions]) await this.disconnect(serverId);
    const disconnected = new Set(this.sessions.keys());
    for (const entry of await this.registry.list()) {
      if (!disconnected.has(entry.profile.id) && entry.connection.desiredConnection) await this.disconnect(entry.profile.id);
    }
  }

  snapshot() {
    return [...this.sessions.entries()].map(([serverId, runtime]) => ({
      actorType: this.actor.actorType,
      actorId: this.actor.actorId,
      serverId,
      live: true,
      summary: structuredClone(runtime.summary),
    }));
  }

  isIdle() {
    return this.sessions.size === 0 && this.connecting.size === 0;
  }

  async shutdown() {
    for (const [serverId, runtime] of [...this.sessions.entries()]) {
      this.sessions.delete(serverId);
      await runtime.session.close();
      const current = await this.registry.get(serverId);
      await this.registry.setConnection(serverId, {
        ...current.connection,
        status: "disconnected",
        desiredConnection: false,
        disconnectedAt: currentIso(this.clock),
        lastError: null,
      });
    }
  }
}

export class SshWorkerPool {
  constructor({ registryFactory, transportFactory, clock = Date.now, keepAliveIntervalMs = 5 * 60_000, inactiveTtlMs = 30 * 24 * 60 * 60_000, maintenanceIntervalMs = 60_000, maxConnectionsPerUser = 8, maxTotalConnections = 256, limitsProvider = null }) {
    invariant(typeof registryFactory === "function" && transportFactory?.connect, "SSH_POOL_DEPENDENCY_INVALID", "SSH worker pool 缺少依赖", { status: 500, expose: false });
    this.registryFactory = registryFactory;
    this.transportFactory = transportFactory;
    this.clock = clock;
    this.keepAliveIntervalMs = keepAliveIntervalMs;
    this.inactiveTtlMs = inactiveTtlMs;
    this.maintenanceIntervalMs = maintenanceIntervalMs;
    this.maxConnectionsPerUser = Number(maxConnectionsPerUser);
    this.maxTotalConnections = Number(maxTotalConnections);
    this.limitsProvider = limitsProvider;
    invariant(Number.isSafeInteger(this.maxConnectionsPerUser) && this.maxConnectionsPerUser > 0 && Number.isSafeInteger(this.maxTotalConnections) && this.maxTotalConnections >= this.maxConnectionsPerUser, "SSH_CONNECTION_LIMIT_INVALID", "SSH worker pool 连接上限无效", { status: 500, expose: false });
    this.workers = new Map();
    this.reservations = new Set();
    this.timer = null;
  }

  workerFor(actor) {
    const key = actorKey(actor);
    if (!this.workers.has(key)) {
      this.workers.set(key, new ActorSshWorker({
        actor,
        registry: this.registryFactory(actor),
        transportFactory: this.transportFactory,
        clock: this.clock,
        keepAliveIntervalMs: this.keepAliveIntervalMs,
        inactiveTtlMs: this.inactiveTtlMs,
        reserveConnection: (serverId) => this.#reserve(key, serverId),
      }));
    }
    return this.workers.get(key);
  }

  async #reserve(key, serverId) {
    const reservation = `${key}:${String(serverId)}`;
    if (this.reservations.has(reservation)) return () => undefined;
    const limits = this.limitsProvider ? await this.limitsProvider() : { maxConnectionsPerUser: this.maxConnectionsPerUser, maxTotalConnections: this.maxTotalConnections };
    const maxConnectionsPerUser = Number(limits.maxConnectionsPerUser);
    const maxTotalConnections = Number(limits.maxTotalConnections);
    invariant(Number.isSafeInteger(maxConnectionsPerUser) && maxConnectionsPerUser > 0 && Number.isSafeInteger(maxTotalConnections) && maxTotalConnections >= maxConnectionsPerUser, "SSH_CONNECTION_LIMIT_INVALID", "SSH worker pool 动态连接上限无效", { status: 500, expose: false });
    const worker = this.workers.get(key);
    const perUser = (worker?.sessions.size || 0) + [...this.reservations].filter((entry) => entry.startsWith(`${key}:`)).length;
    const total = [...this.workers.values()].reduce((count, entry) => count + entry.sessions.size, 0) + this.reservations.size;
    invariant(perUser < maxConnectionsPerUser, "SSH_USER_CONNECTION_LIMIT", "已达到当前用户的 SSH 连接上限", { status: 429, retryable: true, details: { limit: maxConnectionsPerUser } });
    invariant(total < maxTotalConnections, "SSH_TOTAL_CONNECTION_LIMIT", "已达到平台 SSH 连接上限", { status: 503, retryable: true, details: { limit: maxTotalConnections } });
    this.reservations.add(reservation);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.reservations.delete(reservation);
    };
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.maintain().catch(() => undefined), this.maintenanceIntervalMs);
    this.timer.unref?.();
  }

  async maintain() {
    return (await Promise.all([...this.workers.values()].map((worker) => worker.maintain()))).flat();
  }

  snapshot() {
    return [...this.workers.values()].flatMap((worker) => worker.snapshot());
  }

  canReleaseActor(actor) {
    const worker = this.workers.get(actorKey(actor));
    return !worker || worker.isIdle();
  }

  async releaseActor(actor) {
    const key = actorKey(actor);
    const worker = this.workers.get(key);
    if (!worker) return true;
    if (!worker.isIdle()) return false;
    this.workers.delete(key);
    return true;
  }

  async forceReleaseActor(actor) {
    const key = actorKey(actor);
    const worker = this.workers.get(key) || this.workerFor(actor);
    await worker.close();
    this.workers.delete(key);
    for (const reservation of [...this.reservations]) if (reservation.startsWith(`${key}:`)) this.reservations.delete(reservation);
    return true;
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.all([...this.workers.values()].map((worker) => worker.shutdown()));
    this.workers.clear();
    this.reservations.clear();
  }
}
