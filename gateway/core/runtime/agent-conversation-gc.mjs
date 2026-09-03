import crypto from "node:crypto";
import path from "node:path";

import { remoteAgentConfigurationPaths, remoteAgentPaths, runtimeAgentDefinition } from "../agent-runtime/contract.mjs";
import { invariant } from "../errors.mjs";
import { assertId, assertServerIdentity } from "../entities/common.mjs";
import { createAgentBindingKey } from "../scope.mjs";
import { versionDomainId } from "../versioning/contract.mjs";
import { WORKSPACE_SCHEMA_VERSION, createWorkspaceBindingKey } from "../workspaces/contract.mjs";

const VERSION_SCHEMA_VERSION = 3;
const PATH_HEAD_SCHEMA_VERSION = 2;

const shellQuote = (value) => `'${String(value).replace(/'/g, `'"'"'`)}'`;

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(String).filter(Boolean))];
}

async function mapConcurrent(values, limit, worker) {
  const source = [...values];
  if (!source.length) return [];
  const results = new Array(source.length);
  let cursor = 0;
  const consume = async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= source.length) return;
      results[index] = await worker(source[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, Number(limit) || 1), source.length) }, consume));
  return results;
}

function safeJson(value) {
  try {
    const parsed = JSON.parse(Buffer.from(value).toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function missingRemoteFile(error) {
  return ["ENOENT", "NO_SUCH_FILE", 2].includes(error?.code);
}

function exactRecord(value, keys) {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function workspaceBindingId(input) {
  const key = createWorkspaceBindingKey(input);
  return `wsb_${crypto.createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
}

function controlledTarget(target, parent) {
  const normalizedTarget = path.posix.normalize(String(target || ""));
  const normalizedParent = path.posix.normalize(String(parent || ""));
  invariant(
    normalizedTarget.startsWith("/")
      && normalizedParent.startsWith("/")
      && normalizedTarget !== normalizedParent
      && normalizedTarget.startsWith(`${normalizedParent}/`),
    "AGENT_GC_REMOTE_PATH_INVALID",
    "远端 Agent 清理路径不安全",
    { status: 500, expose: false },
  );
  return { target: normalizedTarget, parent: normalizedParent };
}

function remoteBindingRecord(record, { actor, serverIdentity, deletedConversationIds, sourcePath }) {
  const fields = [
    "schemaVersion", "bindingId", "conversationId", "branchId", "workspaceId", "versionDomainId",
    "agentId", "contextEpoch", "nativeSessionId", "lastDeliverySequence", "status",
  ];
  if (!exactRecord(record, fields) || record.schemaVersion !== WORKSPACE_SCHEMA_VERSION) return null;
  if (!deletedConversationIds.has(String(record.conversationId))) return null;
  try {
    const conversationId = assertId(record.conversationId, "conversationId");
    const branchId = assertId(record.branchId, "branchId");
    const workspaceId = assertId(record.workspaceId, "workspaceId");
    const agentId = assertId(record.agentId, "agentId");
    runtimeAgentDefinition(agentId);
    const contextEpoch = Number(record.contextEpoch);
    invariant(Number.isSafeInteger(contextEpoch) && contextEpoch >= 0, "WORKSPACE_CONTEXT_EPOCH_INVALID", "contextEpoch 无效", { status: 400 });
    const expectedWorkspaceBindingId = workspaceBindingId({
      actorId: actor.actorId,
      serverIdentity,
      conversationId,
      branchId,
      workspaceId,
      agentId,
      contextEpoch,
    });
    if (String(record.bindingId || "") !== expectedWorkspaceBindingId) return null;
    if (path.posix.basename(sourcePath) !== `${expectedWorkspaceBindingId}.json`) return null;
    return {
      agentId,
      conversationId,
      bindingId: createAgentBindingKey({
        actorType: actor.actorType,
        actorId: actor.actorId,
        serverIdentity,
        workspaceId,
        conversationId,
        branchId,
        contextEpoch,
      }, agentId),
      remoteBindingPath: sourcePath,
    };
  } catch {
    return null;
  }
}

export class RemoteAgentConversationGarbageCollector {
  constructor({ executor, transport = null, actor, serverIdentity } = {}) {
    invariant(executor && typeof executor.home === "function" && typeof executor.exec === "function" && typeof executor.readFile === "function", "AGENT_GC_EXECUTOR_REQUIRED", "缺少远端 Agent 清理执行器", { status: 500, expose: false });
    invariant(actor?.actorType && actor?.actorId, "AGENT_GC_ACTOR_REQUIRED", "缺少远端 Agent 清理 Actor", { status: 500, expose: false });
    this.executor = executor;
    this.transport = transport;
    this.actor = actor;
    this.serverIdentity = assertServerIdentity(serverIdentity);
  }

  async reconcile({ conversationIds = [], bindings = [], removedWorkspaces = [], retainedWorkspaces = [], protectedWorkspaceIds = [] } = {}) {
    const deletedConversationIds = new Set(uniqueStrings(conversationIds).map((id) => assertId(id, "conversationId")));
    if (!deletedConversationIds.size) return Object.freeze({ scannedBindings: 0, matchedBindings: 0, reconciledRuntimes: 0, removedBindingRecords: 0, reconciledConfigurations: 0, reconciledVersionDomains: 0, deferredVersionDomains: 0, removedWorkspaces: 0 });
    const home = await this.executor.home();
    const basePaths = remoteAgentPaths(home, "opencode");
    const protectedWorkspaces = new Set(uniqueStrings(protectedWorkspaceIds));
    const versions = await this.#reconcileVersionDomains(home, deletedConversationIds);
    const remoteRecords = await this.#scanRemoteBindings(basePaths, deletedConversationIds);
    const candidates = new Map();
    for (const binding of [...bindings, ...remoteRecords.matches]) {
      if (!deletedConversationIds.has(String(binding?.conversationId))) continue;
      try {
        const agentId = assertId(binding.agentId, "agentId");
        runtimeAgentDefinition(agentId);
        const bindingId = assertId(binding.bindingId, "agentBindingId");
        candidates.set(bindingId, { agentId, bindingId, conversationId: String(binding.conversationId), remoteBindingPath: binding.remoteBindingPath ?? null });
      } catch {
        // A malformed local/audit record is not authority to delete a remote directory.
      }
    }

    const candidateIds = new Set(candidates.keys());
    const referencedAgentIds = [...new Set([...candidates.values()].map((candidate) => candidate.agentId))];
    const runtimeReferences = (await Promise.all(referencedAgentIds.map((agentId) => this.#scanRuntimeReferences(home, agentId)))).flat();
    const referenceByBinding = new Map(runtimeReferences.map((entry) => [`${entry.agentId}\0${entry.bindingId}`, entry]));
    for (const candidate of candidates.values()) {
      candidate.nativeRuntimeBindingId = referenceByBinding.get(`${candidate.agentId}\0${candidate.bindingId}`)?.nativeRuntimeBindingId || candidate.bindingId;
    }
    const survivingNativeStoreIds = new Set(runtimeReferences
      .filter((entry) => !candidateIds.has(entry.bindingId))
      .map((entry) => `${entry.agentId}\0${entry.nativeRuntimeBindingId}`));
    const affectedNativeStores = new Map([...candidates.values()]
      .map((candidate) => [`${candidate.agentId}\0${candidate.nativeRuntimeBindingId}`, {
        agentId: candidate.agentId,
        bindingId: candidate.nativeRuntimeBindingId,
      }]));

    let removedBindingRecords = 0;
    const failures = [];
    await Promise.allSettled([...candidates.values()].map((candidate) => this.transport?.releaseBinding?.(candidate.bindingId)));
    const existingCandidates = await this.#existingRuntimeCandidates(home, [...candidates.values()]);
    await mapConcurrent(existingCandidates, 4, async (candidate) => {
      try {
        const retainedNativeOwner = candidate.bindingId === candidate.nativeRuntimeBindingId
          && survivingNativeStoreIds.has(`${candidate.agentId}\0${candidate.bindingId}`);
        if (retainedNativeOwner) await this.#retireRuntimeOwner(home, candidate);
        else await this.#removeRuntime(home, candidate);
        if (candidate.remoteBindingPath) {
          await this.#removeFile(candidate.remoteBindingPath, `${basePaths.easyworkRoot}/bindings/workspaces`);
          removedBindingRecords += 1;
        }
      } catch (error) {
        failures.push({ scope: "agent-runtime", id: candidate.bindingId, code: String(error?.code || "AGENT_GC_RUNTIME_FAILED"), message: String(error?.message || "远端 Agent runtime 清理失败") });
      }
    });
    const removedNativeStoreIds = new Set(existingCandidates
      .filter((candidate) => candidate.bindingId === candidate.nativeRuntimeBindingId
        && !survivingNativeStoreIds.has(`${candidate.agentId}\0${candidate.bindingId}`))
      .map((candidate) => `${candidate.agentId}\0${candidate.bindingId}`));
    const releasableRetainedStores = [...affectedNativeStores.entries()]
      .filter(([key]) => !survivingNativeStoreIds.has(key) && !removedNativeStoreIds.has(key))
      .map(([, candidate]) => ({ ...candidate, conversationId: null, remoteBindingPath: null }));
    const existingRetainedStores = await this.#existingRuntimeCandidates(home, releasableRetainedStores);
    await mapConcurrent(existingRetainedStores, 4, async (candidate) => {
      try {
        await this.#removeRuntime(home, candidate);
      } catch (error) {
        failures.push({ scope: "agent-native-store", id: candidate.bindingId, code: String(error?.code || "AGENT_GC_RUNTIME_FAILED"), message: String(error?.message || "Agent 原生会话仓库清理失败") });
      }
    });

    try {
      await this.#removeTrees([...deletedConversationIds].map((conversationId) => {
        const configuration = remoteAgentConfigurationPaths(home, "opencode", this.actor.actorId, conversationId);
        return { target: configuration.conversationRoot, parent: configuration.conversationsRoot };
      }));
    } catch (error) {
      failures.push({ scope: "agent-configuration", id: "batch", code: String(error?.code || "AGENT_GC_CONFIGURATION_FAILED"), message: String(error?.message || "远端 Agent 配置清理失败") });
    }

    let removedWorkspaceCount = 0;
    const removedWorkspaceIds = new Set();
    await mapConcurrent(Array.isArray(removedWorkspaces) ? removedWorkspaces : [], 4, async (workspace) => {
      try {
        const workspaceId = assertId(workspace?.id, "workspaceId");
        const canonicalPath = String(workspace?.canonicalPath ?? "");
        await this.#removeTree(canonicalPath, `${home}/.easywork/workspaces/${this.actor.actorId}`);
        await this.#removeFile(
          `${basePaths.easyworkRoot}/bindings/workspaces/workspace-${workspaceId}.json`,
          `${basePaths.easyworkRoot}/bindings/workspaces`,
        );
        removedWorkspaceIds.add(workspaceId);
      } catch (error) {
        failures.push({ scope: "virtual-workspace", id: String(workspace?.id ?? "unknown"), code: String(error?.code || "AGENT_GC_WORKSPACE_FAILED"), message: String(error?.message || "远端虚拟工作区清理失败") });
      }
    });
    const reconciledWorkspaces = await this.#reconcileVirtualWorkspaces({
      home,
      basePaths,
      deletedConversationIds,
      protectedWorkspaceIds: protectedWorkspaces,
      retainedWorkspaces,
    });
    for (const workspaceId of reconciledWorkspaces.removedWorkspaceIds) removedWorkspaceIds.add(workspaceId);
    failures.push(...reconciledWorkspaces.failures);
    removedWorkspaceCount = removedWorkspaceIds.size;

    const result = Object.freeze({
      scannedBindings: remoteRecords.scanned,
      matchedBindings: remoteRecords.matches.length,
      reconciledRuntimes: existingCandidates.length,
      removedBindingRecords,
      reconciledConfigurations: deletedConversationIds.size,
      reconciledVersionDomains: versions.removed,
      deferredVersionDomains: versions.deferred,
      removedWorkspaces: removedWorkspaceCount,
    });
    invariant(!failures.length, "AGENT_GC_PARTIAL_FAILURE", "部分已删除对话的远端内容清理失败，将在下次连接时重试", {
      status: 502,
      retryable: true,
      details: { failures, result },
    });
    return result;
  }

  async #reconcileVersionDomains(home, deletedConversationIds) {
    const versionRoot = `${home}/.easywork/versioning/${this.actor.actorId}/${this.serverIdentity}`;
    const registryPath = `${versionRoot}/ledgers.json`;
    const pathHeadsPath = `${versionRoot}/path-heads.json`;
    const targetDomainIds = new Set([...deletedConversationIds].map((conversationId) => versionDomainId({
      actorId: this.actor.actorId,
      serverIdentity: this.serverIdentity,
      conversationId,
    })));
    let registry = null;
    try {
      registry = safeJson(await this.executor.readFile(registryPath));
      invariant(registry, "AGENT_GC_VERSION_REGISTRY_INVALID", "远端版本账本注册表不是有效 JSON", { status: 502, retryable: false });
    }
    catch (error) { if (!missingRemoteFile(error)) throw error; }
    const registeredRemovedIds = new Set();
    if (registry !== null) {
      invariant(
        exactRecord(registry, ["schemaVersion", "revision", "actorId", "serverIdentity", "ledgers"])
          && registry.schemaVersion === VERSION_SCHEMA_VERSION
          && registry.actorId === this.actor.actorId
          && registry.serverIdentity === this.serverIdentity
          && Number.isSafeInteger(registry.revision)
          && registry.revision >= 0
          && Array.isArray(registry.ledgers)
          && registry.ledgers.every((entry) => exactRecord(entry, ["versionDomainId", "conversationId", "createdAt"])),
        "AGENT_GC_VERSION_REGISTRY_INVALID",
        "远端版本账本注册表不是当前格式",
        { status: 502, retryable: false },
      );
      for (const entry of registry.ledgers) {
        if (deletedConversationIds.has(String(entry.conversationId)) || targetDomainIds.has(String(entry.versionDomainId))) {
          registeredRemovedIds.add(String(entry.versionDomainId));
        }
      }
    }
    const removableIds = new Set([...targetDomainIds, ...registeredRemovedIds]);
    await this.#removeTrees([...removableIds].map((domainId) => ({
      target: `${versionRoot}/conversations/${domainId}`,
      parent: `${versionRoot}/conversations`,
    })));
    let retainedLedgers = registry?.ledgers || [];
    if (registry !== null && registeredRemovedIds.size) {
        invariant(typeof this.executor.writeAtomic === "function", "AGENT_GC_VERSION_REGISTRY_WRITE_UNAVAILABLE", "无法更新远端版本账本注册表", { status: 502, retryable: true });
        retainedLedgers = registry.ledgers.filter((entry) => !registeredRemovedIds.has(String(entry.versionDomainId)));
        const next = {
          ...registry,
          revision: registry.revision + 1,
          ledgers: retainedLedgers,
        };
        await this.executor.writeAtomic(registryPath, Buffer.from(`${JSON.stringify(next, null, 2)}\n`), { mode: 0o600 });
    }
    const pathHeads = await this.#removeVersionPathHeads(pathHeadsPath, removableIds);
    if (registry !== null || pathHeads !== null) {
      await this.#collectUnreferencedVersionObjects(versionRoot, retainedLedgers, pathHeads);
    }
    return { removed: registeredRemovedIds.size, deferred: 0 };
  }

  async #removeVersionPathHeads(pathHeadsPath, removedDomainIds) {
    let document = null;
    try {
      document = safeJson(await this.executor.readFile(pathHeadsPath));
      invariant(document, "AGENT_GC_PATH_HEADS_INVALID", "远端路径 HEAD 索引不是有效 JSON", { status: 502, retryable: false });
    } catch (error) {
      if (missingRemoteFile(error)) return null;
      throw error;
    }
    invariant(
      exactRecord(document, ["schemaVersion", "revision", "actorId", "serverIdentity", "paths", "updatedAt"])
        && document.schemaVersion === PATH_HEAD_SCHEMA_VERSION
        && document.actorId === this.actor.actorId
        && document.serverIdentity === this.serverIdentity
        && Number.isSafeInteger(document.revision)
        && document.revision >= 0
        && document.paths
        && typeof document.paths === "object"
        && !Array.isArray(document.paths),
      "AGENT_GC_PATH_HEADS_INVALID",
      "远端路径 HEAD 索引不是当前格式",
      { status: 502, retryable: false },
    );
    const paths = {};
    let changed = false;
    for (const [absolutePath, entry] of Object.entries(document.paths)) {
      invariant(
        absolutePath.startsWith("/")
          && exactRecord(entry, ["current", "domains"])
          && exactRecord(entry.current, ["versionDomainId", "snapshot", "updatedAt"])
          && entry.domains
          && typeof entry.domains === "object"
          && !Array.isArray(entry.domains),
        "AGENT_GC_PATH_HEADS_INVALID",
        "远端路径 HEAD 条目不是当前格式",
        { status: 502, retryable: false },
      );
      const domains = Object.fromEntries(Object.entries(entry.domains).filter(([domainId, head]) => {
        invariant(/^vl_[A-Za-z0-9._-]{1,252}$/.test(domainId)
          && exactRecord(head, ["checkpointId", "snapshot", "updatedAt"]),
        "AGENT_GC_PATH_HEADS_INVALID", "远端路径 HEAD 域不是当前格式", { status: 502, retryable: false });
        return !removedDomainIds.has(domainId);
      }));
      if (Object.keys(domains).length !== Object.keys(entry.domains).length) changed = true;
      if (!Object.keys(domains).length) {
        changed = true;
        continue;
      }
      const currentDomainId = String(entry.current.versionDomainId || "");
      const current = removedDomainIds.has(currentDomainId)
        ? { ...entry.current, versionDomainId: null }
        : entry.current;
      if (current !== entry.current) changed = true;
      invariant(current.versionDomainId === null || Object.hasOwn(domains, current.versionDomainId),
        "AGENT_GC_PATH_HEADS_INVALID", "远端路径当前归属缺少对应 HEAD", { status: 502, retryable: false });
      paths[absolutePath] = { current, domains };
    }
    if (!changed) return document;
    const next = {
      ...document,
      revision: document.revision + 1,
      paths,
      updatedAt: new Date().toISOString(),
    };
    await this.executor.writeAtomic(pathHeadsPath, Buffer.from(`${JSON.stringify(next, null, 2)}\n`), { mode: 0o600 });
    return next;
  }

  async #collectUnreferencedVersionObjects(versionRoot, ledgers, pathHeads = null) {
    const liveObjects = new Set();
    const collectSnapshot = (snapshot) => {
      const objectId = String(snapshot?.objectId || "");
      if (/^[a-f0-9]{64}$/.test(objectId)) liveObjects.add(objectId);
    };
    await mapConcurrent(ledgers, 4, async (entry) => {
      const versionDomainId = String(entry?.versionDomainId || "");
      invariant(/^vl_[A-Za-z0-9._-]{1,252}$/.test(versionDomainId), "AGENT_GC_VERSION_REGISTRY_INVALID", "版本账本 ID 无效", { status: 502 });
      const state = safeJson(await this.executor.readFile(`${versionRoot}/conversations/${versionDomainId}/ledger.json`));
      invariant(
        exactRecord(state, [
          "schemaVersion", "revision", "actorId", "serverIdentity", "conversationId", "versionDomainId", "storage",
          "workspaces", "sequence", "checkpoints", "branches", "pending", "rewinds", "switches", "forkedFrom",
          "createdAt", "updatedAt",
        ])
          && state.schemaVersion === VERSION_SCHEMA_VERSION
          && state.actorId === this.actor.actorId
          && state.serverIdentity === this.serverIdentity
          && state.versionDomainId === versionDomainId
          && Array.isArray(state.checkpoints)
          && state.pending
          && typeof state.pending === "object"
          && !Array.isArray(state.pending),
        "AGENT_GC_VERSION_LEDGER_INVALID",
        "远端版本账本不是当前格式",
        { status: 502 },
      );
      for (const checkpoint of state.checkpoints) {
        invariant(Array.isArray(checkpoint?.changes), "AGENT_GC_VERSION_LEDGER_INVALID", "远端版本账本变更记录无效", { status: 502 });
        for (const change of checkpoint.changes) {
          collectSnapshot(change?.before);
          collectSnapshot(change?.after);
        }
      }
      for (const pending of Object.values(state.pending)) {
        invariant(pending?.paths && typeof pending.paths === "object" && !Array.isArray(pending.paths), "AGENT_GC_VERSION_LEDGER_INVALID", "远端版本账本待提交记录无效", { status: 502 });
        for (const record of Object.values(pending.paths)) collectSnapshot(record?.before);
      }
    });
    for (const entry of Object.values(pathHeads?.paths || {})) {
      for (const head of Object.values(entry?.domains || {})) collectSnapshot(head?.snapshot);
    }
    const keepFile = `${versionRoot}/.gc-live-objects-${crypto.randomBytes(8).toString("hex")}`;
    await this.executor.writeAtomic(keepFile, Buffer.from([...liveObjects].sort().join("\n") + (liveObjects.size ? "\n" : "")), { mode: 0o600 });
    const objectsRoot = `${versionRoot}/objects`;
    const script = String.raw`
set -euo pipefail
root=$1
keep=$2
if [ -d "$root" ] && [ ! -L "$root" ]; then
  while IFS= read -r -d '' object; do
    name=$(basename -- "$object")
    if ! grep -qxF -- "$name" "$keep"; then rm -f -- "$object"; fi
  done < <(find "$root" -type f -print0)
  find "$root" -depth -type d -empty -delete
fi
rm -f -- "$keep"
`;
    const result = await this.executor.exec(`bash -c ${shellQuote(script)} easywork-version-gc ${shellQuote(objectsRoot)} ${shellQuote(keepFile)}`, { maxOutputBytes: 128 * 1024 });
    invariant(result.code === 0, "AGENT_GC_VERSION_OBJECTS_FAILED", "无法清理未引用的远端版本对象", { status: 502, retryable: true, details: { exitCode: result.code } });
  }

  async #scanRemoteBindings(basePaths, deletedConversationIds) {
    const root = `${basePaths.easyworkRoot}/bindings/workspaces`;
    const scanScript = String.raw`
set -e
root=$1
if [ -d "$root" ] && [ ! -L "$root" ]; then
  while IFS= read -r -d '' file; do
    printf '%s\0' "$file"
    base64 -w0 -- "$file"
    printf '\0'
  done < <(find "$root" -mindepth 1 -maxdepth 1 -type f -name 'wsb_*.json' -print0)
fi
`;
    const listed = await this.executor.exec(
      `bash -c ${shellQuote(scanScript)} easywork-agent-gc ${shellQuote(root)}`,
      { maxOutputBytes: 8 * 1024 * 1024 },
    );
    invariant(listed.code === 0, "AGENT_GC_BINDING_SCAN_FAILED", "无法扫描远端 Agent 对话绑定", { status: 502, retryable: true, details: { exitCode: listed.code } });
    const fields = String(listed.stdout || "").split("\0");
    if (fields.at(-1) === "") fields.pop();
    invariant(fields.length % 2 === 0, "AGENT_GC_BINDING_SCAN_FAILED", "远端 Agent 绑定批量读取结果不完整", { status: 502, retryable: true });
    const records = [];
    for (let index = 0; index < fields.length; index += 2) records.push({ path: fields[index], encoded: fields[index + 1] });
    const matches = records.flatMap(({ path: value, encoded }) => {
      const sourcePath = path.posix.normalize(value.startsWith("/") ? value : `${root}/${value}`);
      if (path.posix.dirname(sourcePath) !== root || !/^wsb_[A-Za-z0-9._-]+\.json$/.test(path.posix.basename(sourcePath))) return [];
      const record = /^[A-Za-z0-9+/]*={0,2}$/.test(encoded) ? safeJson(Buffer.from(encoded, "base64")) : null;
      const match = remoteBindingRecord(record, {
        actor: this.actor,
        serverIdentity: this.serverIdentity,
        deletedConversationIds,
        sourcePath,
      });
      return match ? [match] : [];
    });
    return { scanned: records.length, matches };
  }

  async #scanRuntimeReferences(home, agentIdInput) {
    const agentId = assertId(agentIdInput, "agentId");
    runtimeAgentDefinition(agentId);
    const root = `${remoteAgentPaths(home, agentId).easyworkRoot}/runtime/agents/${agentId}`;
    const scanScript = String.raw`
set -e
root=$1
if [ -e "$root" ]; then
  [ -d "$root" ] && [ ! -L "$root" ] || exit 73
  while IFS= read -r -d '' file; do
    printf '%s\0' "$file"
    base64 -w0 -- "$file"
    printf '\0'
  done < <(find "$root" -mindepth 3 -maxdepth 3 -type f -path '*/state/active.json' -print0)
fi
`;
    const listed = await this.executor.exec(
      `bash -c ${shellQuote(scanScript)} easywork-agent-gc-native-references ${shellQuote(root)}`,
      { maxOutputBytes: 8 * 1024 * 1024 },
    );
    invariant(listed.code === 0, "AGENT_GC_NATIVE_REFERENCE_SCAN_FAILED", "无法扫描 Agent 原生会话仓库引用", { status: 502, retryable: true, details: { agentId, exitCode: listed.code } });
    const fields = String(listed.stdout || "").split("\0");
    if (fields.at(-1) === "") fields.pop();
    invariant(fields.length % 2 === 0, "AGENT_GC_NATIVE_REFERENCE_SCAN_FAILED", "Agent 原生会话仓库引用读取不完整", { status: 502, retryable: true });
    const references = [];
    for (let index = 0; index < fields.length; index += 2) {
      const sourcePath = path.posix.normalize(fields[index]);
      const encoded = fields[index + 1];
      const record = /^[A-Za-z0-9+/]*={0,2}$/.test(encoded) ? safeJson(Buffer.from(encoded, "base64")) : null;
      invariant(record?.schemaVersion === 1 && record.agentId === agentId, "AGENT_GC_NATIVE_REFERENCE_INVALID", "Agent runtime 引用记录无效", { status: 502, retryable: false });
      const bindingId = assertId(record.agentBindingId, "agentBindingId");
      const nativeRuntimeBindingId = assertId(record.nativeRuntimeBindingId || bindingId, "nativeRuntimeBindingId");
      const expectedPath = `${remoteAgentPaths(home, agentId, bindingId).runtimeState}/active.json`;
      invariant(sourcePath === expectedPath, "AGENT_GC_NATIVE_REFERENCE_INVALID", "Agent runtime 引用路径无效", { status: 502, retryable: false });
      references.push({ agentId, bindingId, nativeRuntimeBindingId, sourcePath });
    }
    return references;
  }

  async #reconcileVirtualWorkspaces({ home, basePaths, deletedConversationIds, protectedWorkspaceIds, retainedWorkspaces }) {
    const actorWorkspaceRoot = `${home}/.easywork/workspaces/${this.actor.actorId}`;
    const metadataRoot = `${basePaths.easyworkRoot}/bindings/workspaces`;
    const protectedPaths = new Set((Array.isArray(retainedWorkspaces) ? retainedWorkspaces : [])
      .map((entry) => path.posix.normalize(String(entry?.canonicalPath || "")))
      .filter((entry) => entry.startsWith(`${actorWorkspaceRoot}/`)));
    const failures = [];
    const removedWorkspaceIds = new Set();
    const listed = await this.executor.exec(
      `if [ -d ${shellQuote(metadataRoot)} ] && [ ! -L ${shellQuote(metadataRoot)} ]; then find ${shellQuote(metadataRoot)} -mindepth 1 -maxdepth 1 -type f -name 'workspace-*.json' -print; fi`,
      { maxOutputBytes: 8 * 1024 * 1024 },
    );
    if (listed.code !== 0) {
      failures.push({ scope: "virtual-workspace-scan", id: this.actor.actorId, code: "AGENT_GC_WORKSPACE_SCAN_FAILED", message: "无法扫描远端虚拟工作区记录" });
    } else {
      const obsoleteMetadata = [];
      for (const value of uniqueStrings(String(listed.stdout || "").split(/\r?\n/))) {
        const sourcePath = path.posix.normalize(value.startsWith("/") ? value : `${metadataRoot}/${value}`);
        const record = path.posix.dirname(sourcePath) === metadataRoot
          ? await this.executor.readFile(sourcePath).then(safeJson).catch(() => null)
          : null;
        try {
          if (!(exactRecord(record, ["schemaVersion", "workspaceId", "kind", "canonicalPath", "actorId", "serverIdentity"])
            && record.schemaVersion === WORKSPACE_SCHEMA_VERSION)) {
            // EasyWork only reads the current workspace schema. Obsolete
            // metadata is a disposable control file under the verified
            // EasyWork parent; deterministic conversation roots below are the
            // authority for deleting any corresponding virtual files.
            obsoleteMetadata.push({ target: sourcePath, parent: metadataRoot });
            continue;
          }
          const workspaceId = assertId(record.workspaceId, "workspaceId");
          if (path.posix.basename(sourcePath) !== `workspace-${workspaceId}.json`) continue;
          if (String(record?.actorId || "") !== this.actor.actorId || String(record?.serverIdentity || "") !== this.serverIdentity || record?.kind !== "virtual") continue;
          const canonicalPath = path.posix.normalize(String(record?.canonicalPath || ""));
          const relative = path.posix.relative(actorWorkspaceRoot, canonicalPath);
          const segments = relative.split("/").filter(Boolean);
          if (relative.startsWith("../") || segments.length !== 2 || segments[1] !== workspaceId || !deletedConversationIds.has(segments[0])) continue;
          if (protectedWorkspaceIds.has(workspaceId)) {
            protectedPaths.add(canonicalPath);
            continue;
          }
          await this.#removeTree(canonicalPath, actorWorkspaceRoot);
          await this.#removeFile(sourcePath, metadataRoot);
          removedWorkspaceIds.add(workspaceId);
        } catch (error) {
          failures.push({ scope: "virtual-workspace", id: String(record?.workspaceId ?? path.posix.basename(sourcePath)), code: String(error?.code || "AGENT_GC_WORKSPACE_FAILED"), message: String(error?.message || "远端虚拟工作区清理失败") });
        }
      }
      try { await this.#removeFiles(obsoleteMetadata); }
      catch (error) {
        failures.push({ scope: "virtual-workspace-metadata", id: "obsolete", code: String(error?.code || "AGENT_GC_WORKSPACE_METADATA_FAILED"), message: String(error?.message || "远端旧工作区元数据清理失败") });
      }
    }

    // The directory layout is deterministic. Removing the conversation root
    // also recovers from a crash that deleted its local/remote metadata before
    // deleting the actual files. A root is retained only while a surviving
    // branched conversation still references a workspace below it.
    const removableConversationRoots = [...deletedConversationIds]
      .map((conversationId) => ({ conversationId, target: `${actorWorkspaceRoot}/${conversationId}`, parent: actorWorkspaceRoot }))
      .filter((entry) => ![...protectedPaths].some((value) => value.startsWith(`${entry.target}/`)));
    try { await this.#removeTrees(removableConversationRoots); }
    catch (error) {
      failures.push({ scope: "virtual-workspace-root", id: "batch", code: String(error?.code || "AGENT_GC_WORKSPACE_ROOT_FAILED"), message: String(error?.message || "远端虚拟工作区根目录清理失败") });
    }
    return { removedWorkspaceIds, failures };
  }

  async #removeRuntime(home, candidate) {
    const paths = remoteAgentPaths(home, candidate.agentId, candidate.bindingId);
    const active = await this.executor.readFile(`${paths.runtimeState}/active.json`).then(safeJson).catch(() => null);
    const processId = active?.agentId === candidate.agentId && active?.agentBindingId === candidate.bindingId
      ? String(active.processId || "")
      : "";
    const pid = processId.match(/^remote-(\d+)$/)?.[1] || "";
    if (pid) await this.#stopOwnedProcess(pid, paths.runtimeHome);
    // Releasing a live transport can remove active.json before the detached
    // service has actually exited.  On NFS that process keeps its log as an
    // undeletable .nfs file, so rm -rf fails forever and the deletion ledger
    // can never be consumed.  Sweep only processes owned by the current SSH
    // user whose exact HOME is this binding's isolated runtime HOME.  This is
    // both narrower than command-line matching and able to recover orphaned
    // services after a Gateway restart.
    await this.#stopRuntimeHomeProcesses(paths.runtimeHome);
    await this.#removeTree(paths.runtimeRoot, paths.agentRuntimeRoot);
  }

  async #retireRuntimeOwner(home, candidate) {
    const paths = remoteAgentPaths(home, candidate.agentId, candidate.bindingId);
    const activePath = `${paths.runtimeState}/active.json`;
    const active = await this.executor.readFile(activePath).then(safeJson).catch(() => null);
    const processId = active?.agentId === candidate.agentId && active?.agentBindingId === candidate.bindingId
      ? String(active.processId || "")
      : "";
    const pid = processId.match(/^remote-(\d+)$/)?.[1] || "";
    if (pid) await this.#stopOwnedProcess(pid, paths.runtimeHome);
    await this.#removeFile(activePath, paths.runtimeState);
  }

  async #existingRuntimeCandidates(home, candidates) {
    if (!candidates.length) return [];
    const indexed = candidates.map((candidate, index) => {
      const paths = remoteAgentPaths(home, candidate.agentId, candidate.bindingId);
      controlledTarget(paths.runtimeRoot, paths.agentRuntimeRoot);
      return { index, path: paths.runtimeRoot };
    });
    const script = String.raw`
set -euo pipefail
while [ "$#" -ge 2 ]; do
  index=$1
  target=$2
  shift 2
  if [ -e "$target" ] || [ -L "$target" ]; then printf '%s\n' "$index"; fi
done
`;
    const result = await this.executor.exec([
      "bash -c", shellQuote(script), "easywork-agent-gc-existing",
      ...indexed.flatMap((entry) => [String(entry.index), entry.path].map(shellQuote)),
    ].join(" "), { maxOutputBytes: Math.max(16 * 1024, candidates.length * 16) });
    invariant(result.code === 0, "AGENT_GC_RUNTIME_SCAN_FAILED", "无法批量确认远端 Agent runtime", { status: 502, retryable: true });
    const existing = new Set(String(result.stdout || "").split(/\r?\n/).filter(Boolean).map(Number));
    return candidates.filter((_, index) => existing.has(index));
  }

  async #stopOwnedProcess(pid, runtimeHome) {
    const command = [
      `gc_pid=${shellQuote(pid)}`,
      `gc_home=${shellQuote(runtimeHome)}`,
      `gc_owned() { [ -r "/proc/$gc_pid/environ" ] && tr '\\000' '\\n' < "/proc/$gc_pid/environ" | grep -Fqx -- "HOME=$gc_home"; }`,
      `if kill -0 "$gc_pid" 2>/dev/null && gc_owned; then kill -TERM "$gc_pid" 2>/dev/null || true; for gc_wait in 1 2 3 4 5; do kill -0 "$gc_pid" 2>/dev/null || break; sleep 0.1; done; if kill -0 "$gc_pid" 2>/dev/null && gc_owned; then kill -KILL "$gc_pid" 2>/dev/null || true; fi; fi`,
    ].join("; ");
    const stopped = await this.executor.exec(command, { maxOutputBytes: 16 * 1024 });
    invariant(stopped.code === 0, "AGENT_GC_PROCESS_STOP_FAILED", "无法停止已删除对话的远端 Agent 进程", { status: 502, retryable: true, details: { exitCode: stopped.code } });
  }

  async #stopRuntimeHomeProcesses(runtimeHome) {
    const script = String.raw`
set -euo pipefail
runtime_home=$1
own_uid=$(id -u)
owned_by_runtime() {
  candidate_pid=$1
  [ -r "/proc/$candidate_pid/status" ] && [ -r "/proc/$candidate_pid/environ" ] || return 1
  candidate_uid=$(awk '$1 == "Uid:" { print $2; exit }' "/proc/$candidate_pid/status") || return 1
  [ "$candidate_uid" = "$own_uid" ] || return 1
  tr '\000' '\n' < "/proc/$candidate_pid/environ" 2>/dev/null | grep -Fqx -- "HOME=$runtime_home"
}
pids=""
for environment in /proc/[0-9]*/environ; do
  candidate_pid=$(basename -- "$(dirname -- "$environment")")
  case "$candidate_pid" in *[!0-9]*|'') continue ;; esac
  if owned_by_runtime "$candidate_pid"; then pids="$pids $candidate_pid"; fi
done
for candidate_pid in $pids; do
  if owned_by_runtime "$candidate_pid"; then kill -TERM "$candidate_pid" 2>/dev/null || true; fi
done
for wait_step in 1 2 3 4 5 6 7 8 9 10; do
  remaining=""
  for candidate_pid in $pids; do
    if owned_by_runtime "$candidate_pid"; then remaining="$remaining $candidate_pid"; fi
  done
  [ -n "$remaining" ] || break
  sleep 0.1
done
for candidate_pid in $pids; do
  if owned_by_runtime "$candidate_pid"; then kill -KILL "$candidate_pid" 2>/dev/null || true; fi
done
`;
    const stopped = await this.executor.exec(
      `bash -c ${shellQuote(script)} easywork-agent-gc-runtime-home ${shellQuote(runtimeHome)}`,
      { maxOutputBytes: 16 * 1024 },
    );
    invariant(stopped.code === 0, "AGENT_GC_PROCESS_STOP_FAILED", "无法停止已删除对话的残留 Agent 进程", {
      status: 502,
      retryable: true,
      details: { exitCode: stopped.code },
    });
  }

  async #removeTree(value, parentValue) {
    return this.#removeTrees([{ target: value, parent: parentValue }]);
  }

  async #removeTrees(entries) {
    const targets = entries.map((entry) => controlledTarget(entry.target, entry.parent));
    if (!targets.length) return;
    const script = String.raw`
set -euo pipefail
while [ "$#" -ge 2 ]; do
  target=$1
  parent=$2
  shift 2
  if [ -e "$target" ] || [ -L "$target" ]; then
    [ ! -L "$target" ] || exit 73
    resolved=$(readlink -f -- "$target") || exit 74
    [ "$resolved" = "$target" ] || exit 73
    case "$target" in "$parent"/*) ;; *) exit 72 ;; esac
    rm -rf -- "$target"
  fi
done
`;
    const command = [
      "bash -c", shellQuote(script), "easywork-agent-gc-remove-trees",
      ...targets.flatMap(({ target, parent }) => [target, parent].map(shellQuote)),
    ].join(" ");
    const removed = await this.executor.exec(command, { maxOutputBytes: Math.max(16 * 1024, targets.length * 64) });
    invariant(removed.code === 0, "AGENT_GC_REMOTE_DELETE_FAILED", "无法删除已失效的远端 Agent 对话目录", { status: 502, retryable: true, details: { exitCode: removed.code } });
  }

  async #removeFile(value, parentValue) {
    return this.#removeFiles([{ target: value, parent: parentValue }]);
  }

  async #removeFiles(entries) {
    const targets = entries.map((entry) => controlledTarget(entry.target, entry.parent));
    if (!targets.length) return;
    const script = String.raw`
set -euo pipefail
while [ "$#" -ge 2 ]; do
  target=$1
  parent=$2
  shift 2
  if [ -e "$target" ] || [ -L "$target" ]; then
    [ ! -L "$target" ] || exit 73
    resolved=$(readlink -f -- "$target") || exit 74
    [ "$resolved" = "$target" ] || exit 73
    case "$target" in "$parent"/*) ;; *) exit 72 ;; esac
    rm -f -- "$target"
  fi
done
`;
    const command = [
      "bash -c", shellQuote(script), "easywork-agent-gc-remove-files",
      ...targets.flatMap(({ target, parent }) => [target, parent].map(shellQuote)),
    ].join(" ");
    const removed = await this.executor.exec(command, { maxOutputBytes: Math.max(16 * 1024, targets.length * 64) });
    invariant(removed.code === 0, "AGENT_GC_REMOTE_BINDING_DELETE_FAILED", "无法删除已失效的远端 Agent 绑定记录", { status: 502, retryable: true, details: { exitCode: removed.code } });
  }
}
