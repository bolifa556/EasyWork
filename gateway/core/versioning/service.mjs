import path from "node:path";

import { invariant } from "../errors.mjs";
import {
  WORKSPACE_MODES,
  assertServerIdentity,
  assertVersionId,
  assertVersioningDependencies,
  assertWorkspaceAbsolutePath,
  normalizeChanges,
  relationshipBetweenRoots,
  storageLayout,
  validateSnapshot,
  versionDomainId as deriveVersionDomainId,
} from "./contract.mjs";

const SCHEMA_VERSION = 1;
const EXCLUDED_WORKSPACE_ENTRIES = Object.freeze([".git", ".easywork"]);

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function isoTime(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  invariant(!Number.isNaN(date.valueOf()), "VERSION_CLOCK_INVALID", "版本服务时钟返回值无效", { status: 500, expose: false });
  return date.toISOString();
}

function snapshotEquals(left, right) {
  const a = validateSnapshot(left, "leftSnapshot");
  const b = validateSnapshot(right, "rightSnapshot");
  return a.exists === b.exists && (!a.exists || (a.sha256 === b.sha256 && a.size === b.size));
}

function latestRetainedCheckpoint(state) {
  return [...state.checkpoints].reverse().find((checkpoint) => checkpoint.status === "retained") || null;
}

function checkpointById(state, checkpointId, field = "checkpointId") {
  const id = assertVersionId(checkpointId, field);
  const checkpoint = state.checkpoints.find((entry) => entry.id === id);
  invariant(checkpoint, "VERSION_CHECKPOINT_NOT_FOUND", `Checkpoint 不存在: ${id}`, { status: 404, details: { checkpointId: id } });
  return checkpoint;
}

function normalizeLocator(input) {
  const actorId = assertVersionId(input?.actorId, "actorId");
  const serverIdentity = assertServerIdentity(input?.serverIdentity);
  const domainId = assertVersionId(input?.versionDomainId, "versionDomainId");
  return { actorId, serverIdentity, versionDomainId: domainId };
}

function validateRegistry(value, locator) {
  if (value === null || value === undefined) {
    return {
      schemaVersion: SCHEMA_VERSION,
      revision: 0,
      actorId: locator.actorId,
      serverIdentity: locator.serverIdentity,
      domains: [],
    };
  }
  invariant(value?.schemaVersion === SCHEMA_VERSION, "VERSION_REGISTRY_SCHEMA_INVALID", "版本域注册表格式无效", { status: 500, expose: false });
  invariant(value.actorId === locator.actorId && value.serverIdentity === locator.serverIdentity, "VERSION_REGISTRY_SCOPE_MISMATCH", "版本域注册表作用域不一致", { status: 500, expose: false });
  invariant(Number.isSafeInteger(value.revision) && value.revision >= 0 && Array.isArray(value.domains), "VERSION_REGISTRY_INVALID", "版本域注册表内容无效", { status: 500, expose: false });
  const domains = value.domains.map((entry, index) => ({
    versionDomainId: assertVersionId(entry?.versionDomainId, `domains[${index}].versionDomainId`),
    rootPath: assertWorkspaceAbsolutePath(entry?.rootPath, `domains[${index}].rootPath`),
    mode: (() => {
      invariant(WORKSPACE_MODES.includes(entry?.mode), "VERSION_REGISTRY_MODE_INVALID", `domains[${index}].mode 无效`, { status: 500, expose: false });
      return entry.mode;
    })(),
    createdAt: String(entry?.createdAt || ""),
  }));
  return { ...clone(value), domains };
}

function validateDomainState(value, locator) {
  invariant(value?.schemaVersion === SCHEMA_VERSION, "VERSION_STATE_SCHEMA_INVALID", "版本域状态格式无效", { status: 500, expose: false });
  invariant(value.actorId === locator.actorId && value.serverIdentity === locator.serverIdentity && value.versionDomainId === locator.versionDomainId, "VERSION_STATE_SCOPE_MISMATCH", "版本域状态作用域不一致", { status: 500, expose: false });
  invariant(Number.isSafeInteger(value.revision) && value.revision >= 0, "VERSION_STATE_REVISION_INVALID", "版本域 revision 无效", { status: 500, expose: false });
  invariant(Number.isSafeInteger(value.sequence) && value.sequence >= 0, "VERSION_STATE_SEQUENCE_INVALID", "版本域 sequence 无效", { status: 500, expose: false });
  invariant(value.workspace && WORKSPACE_MODES.includes(value.workspace.mode), "VERSION_WORKSPACE_MODE_INVALID", "工作区模式无效", { status: 500, expose: false });
  const workspaceRoot = assertWorkspaceAbsolutePath(value.workspace.rootPath);
  invariant(Array.isArray(value.workspace.dynamicPaths), "VERSION_DYNAMIC_PATHS_INVALID", "动态写入路径无效", { status: 500, expose: false });
  for (const dynamicPath of value.workspace.dynamicPaths) {
    const normalized = assertWorkspaceAbsolutePath(dynamicPath, "dynamicPath");
    invariant(normalized === workspaceRoot || normalized.startsWith(`${workspaceRoot}/`), "VERSION_DYNAMIC_PATH_OUTSIDE_ROOT", "动态写入路径超出工作区", { status: 500, expose: false });
  }
  invariant(Array.isArray(value.checkpoints) && value.branches && typeof value.branches === "object" && !Array.isArray(value.branches) && Array.isArray(value.rewinds), "VERSION_STATE_CONTENT_INVALID", "版本域状态内容无效", { status: 500, expose: false });
  return clone(value);
}

function overlapRisk(rootPath, entries) {
  const relationships = entries
    .map((entry) => ({
      versionDomainId: entry.versionDomainId,
      rootPath: entry.rootPath,
      mode: entry.mode,
      relationship: relationshipBetweenRoots(rootPath, entry.rootPath),
    }))
    .filter((entry) => entry.relationship !== "disjoint" && entry.relationship !== "exact");
  if (!relationships.length) return null;
  return {
    code: "WORKSPACE_DOMAIN_OVERLAP",
    level: "high",
    rootPath,
    relationships,
    message: "工作区与已有版本域嵌套或重叠，不能创建独立版本域",
  };
}

function normalizeGitResult(result) {
  if (typeof result === "string") return { stdout: result, stderr: "", code: 0 };
  invariant(result && typeof result === "object", "VERSION_GIT_RESULT_INVALID", "remoteExec.git 返回值无效", { status: 500, expose: false });
  invariant(!Number.isInteger(result.code) || result.code === 0, "VERSION_GIT_FAILED", "EasyWork 隔离版本仓库操作失败", {
    status: 409,
    details: { code: result.code, stderr: String(result.stderr || "").slice(0, 4096) },
  });
  return { stdout: String(result.stdout || ""), stderr: String(result.stderr || ""), code: result.code ?? 0 };
}

export class VersioningService {
  #locks = new Map();

  constructor(dependencies) {
    assertVersioningDependencies(dependencies);
    this.remoteFs = dependencies.remoteFs;
    this.remoteExec = dependencies.remoteExec;
    this.clock = dependencies.clock || (() => new Date());
    this.baseRoot = String(dependencies.baseRoot || "~/.easywork/versioning").replace(/\\/g, "/").replace(/\/$/, "");
    invariant(this.baseRoot.endsWith("/.easywork/versioning") || this.baseRoot === "~/.easywork/versioning", "VERSION_STORAGE_ROOT_INVALID", "版本数据必须位于 .easywork/versioning", { status: 500, expose: false });
  }

  async assessWorkspace(input) {
    const actorId = assertVersionId(input?.actorId, "actorId");
    const serverIdentity = assertServerIdentity(input?.serverIdentity);
    const rootPath = assertWorkspaceAbsolutePath(input?.rootPath);
    const candidateId = deriveVersionDomainId({ actorId, serverIdentity, rootPath });
    const layout = storageLayout({ baseRoot: this.baseRoot, actorId, serverIdentity, versionDomainId: candidateId });
    const registry = await this.#readRegistry({ actorId, serverIdentity, registryFile: layout.registryFile });
    const exact = registry.domains.find((entry) => entry.rootPath === rootPath) || null;
    const risk = overlapRisk(rootPath, registry.domains);
    return {
      rootPath,
      exact: exact ? clone(exact) : null,
      risk,
      canCreate: !exact && !risk,
    };
  }

  async openDomain(input, options = {}) {
    const actorId = assertVersionId(input?.actorId, "actorId");
    const serverIdentity = assertServerIdentity(input?.serverIdentity);
    const rootPath = assertWorkspaceAbsolutePath(input?.rootPath);
    const mode = String(input?.mode || "");
    invariant(WORKSPACE_MODES.includes(mode), "VERSION_WORKSPACE_MODE_INVALID", "工作区模式必须是 real 或 virtual", { status: 400 });
    const domainId = input?.versionDomainId
      ? assertVersionId(input.versionDomainId, "versionDomainId")
      : deriveVersionDomainId({ actorId, serverIdentity, rootPath });
    const locator = { actorId, serverIdentity, versionDomainId: domainId };
    const layout = storageLayout({ baseRoot: this.baseRoot, ...locator });
    const registryLock = `registry:${actorId}:${serverIdentity}`;

    return this.#withLock(registryLock, async () => {
      const registry = await this.#readRegistry({ actorId, serverIdentity, registryFile: layout.registryFile });
      const exact = registry.domains.find((entry) => entry.rootPath === rootPath) || null;
      if (exact) {
        const state = await this.getDomain({ actorId, serverIdentity, versionDomainId: exact.versionDomainId });
        return { created: false, reused: true, state, risk: null };
      }

      const risk = overlapRisk(rootPath, registry.domains);
      if (risk) {
        if (options.overlapPolicy === "reuse-containing") {
          const containing = risk.relationships.filter((entry) => entry.relationship === "contained_by");
          invariant(containing.length === 1, "VERSION_DOMAIN_OVERLAP_AMBIGUOUS", "无法唯一确定可复用的父版本域", { status: 409, details: risk });
          const state = await this.getDomain({ actorId, serverIdentity, versionDomainId: containing[0].versionDomainId });
          return { created: false, reused: true, state, risk };
        }
        return { created: false, reused: false, state: null, risk };
      }

      invariant(!registry.domains.some((entry) => entry.versionDomainId === domainId), "VERSION_DOMAIN_ID_COLLISION", "版本域 ID 已被其他工作区占用", { status: 409 });
      await this.remoteFs.mkdir(layout.root);
      await this.remoteFs.mkdir(layout.repositoryGit);
      await this.remoteFs.mkdir(layout.workTree);
      await this.remoteFs.writeTextAtomic(layout.configFile, [
        "[core]",
        "\tbare = false",
        "\tfilemode = true",
        "\tlogallrefupdates = false",
        "[user]",
        "\tname = EasyWork Versioning",
        "\temail = easywork@localhost",
        "",
      ].join("\n"));
      await this.#git(layout, ["init", "--bare"]);
      await this.remoteFs.syncTree({
        sourceRoot: rootPath,
        shadowRoot: layout.workTree,
        exclude: [...EXCLUDED_WORKSPACE_ENTRIES],
      });
      const baselineCommitId = await this.#commitShadow(layout, "EasyWork baseline");
      const now = isoTime(this.clock);
      const state = {
        schemaVersion: SCHEMA_VERSION,
        revision: 0,
        actorId,
        serverIdentity,
        versionDomainId: domainId,
        workspace: { mode, rootPath, dynamicPaths: [] },
        storage: {
          root: layout.root,
          repositoryGit: layout.repositoryGit,
          workTree: layout.workTree,
          indexFile: layout.indexFile,
          configFile: layout.configFile,
        },
        sequence: 0,
        baselineCommitId,
        checkpoints: [],
        branches: {},
        rewinds: [],
        createdAt: now,
        updatedAt: now,
      };
      await this.remoteFs.writeJsonAtomic(layout.stateFile, state, { expectedRevision: null });
      const nextRegistry = {
        ...registry,
        revision: registry.revision + 1,
        domains: [...registry.domains, { versionDomainId: domainId, rootPath, mode, createdAt: now }],
      };
      const expectedRegistryRevision = registry.revision === 0 && registry.domains.length === 0 ? null : registry.revision;
      await this.remoteFs.writeJsonAtomic(layout.registryFile, nextRegistry, { expectedRevision: expectedRegistryRevision });
      return { created: true, reused: false, state: clone(state), risk: null };
    });
  }

  async getDomain(input) {
    const locator = normalizeLocator(input);
    const layout = storageLayout({ baseRoot: this.baseRoot, ...locator });
    const state = await this.remoteFs.readJson(layout.stateFile);
    invariant(state, "VERSION_DOMAIN_NOT_FOUND", "版本域不存在", { status: 404, details: { versionDomainId: locator.versionDomainId } });
    const validated = validateDomainState(state, locator);
    const expectedStorage = {
      root: layout.root,
      repositoryGit: layout.repositoryGit,
      workTree: layout.workTree,
      indexFile: layout.indexFile,
      configFile: layout.configFile,
    };
    invariant(
      validated.storage && Object.entries(expectedStorage).every(([key, value]) => validated.storage[key] === value),
      "VERSION_STORAGE_MISMATCH",
      "版本域隔离存储路径无效",
      { status: 500, expose: false },
    );
    return validated;
  }

  async resolveDynamicWrite(input) {
    const actorId = assertVersionId(input?.actorId, "actorId");
    const serverIdentity = assertServerIdentity(input?.serverIdentity);
    const targetPath = assertWorkspaceAbsolutePath(input?.targetPath, "targetPath");
    const seedId = deriveVersionDomainId({ actorId, serverIdentity, rootPath: targetPath });
    const seedLayout = storageLayout({ baseRoot: this.baseRoot, actorId, serverIdentity, versionDomainId: seedId });
    const registry = await this.#readRegistry({ actorId, serverIdentity, registryFile: seedLayout.registryFile });
    const containing = registry.domains
      .filter((entry) => targetPath === entry.rootPath || targetPath.startsWith(`${entry.rootPath}/`))
      .sort((left, right) => right.rootPath.length - left.rootPath.length);
    if (containing.length > 1 && containing[0].rootPath.length === containing[1].rootPath.length) {
      return {
        state: null,
        created: false,
        reused: false,
        risk: {
          code: "DYNAMIC_WRITE_DOMAIN_AMBIGUOUS",
          level: "high",
          targetPath,
          versionDomainIds: containing.filter((entry) => entry.rootPath.length === containing[0].rootPath.length).map((entry) => entry.versionDomainId),
        },
      };
    }
    if (containing.length) {
      const state = await this.#recordDynamicPath(
        { actorId, serverIdentity, versionDomainId: containing[0].versionDomainId },
        targetPath,
      );
      return { state, created: false, reused: true, risk: null };
    }

    const rootPath = input?.workspaceRootPath
      ? assertWorkspaceAbsolutePath(input.workspaceRootPath, "workspaceRootPath")
      : input?.targetKind === "directory"
        ? targetPath
        : path.posix.dirname(targetPath);
    invariant(targetPath === rootPath || targetPath.startsWith(`${rootPath}/`), "DYNAMIC_WRITE_OUTSIDE_ROOT", "动态写入路径不在指定工作区内", { status: 400 });
    const opened = await this.openDomain({ actorId, serverIdentity, rootPath, mode: "virtual" });
    if (!opened.state) return opened;
    const state = await this.#recordDynamicPath(
      { actorId, serverIdentity, versionDomainId: opened.state.versionDomainId },
      targetPath,
    );
    return { ...opened, state };
  }

  async createLogicalBranch(input, branchInput) {
    const locator = normalizeLocator(input);
    const branchId = assertVersionId(branchInput?.branchId, "branchId");
    const conversationId = assertVersionId(branchInput?.conversationId, "conversationId");
    return this.#mutateState(locator, async (state) => {
      invariant(!state.branches[branchId], "VERSION_BRANCH_EXISTS", "逻辑分支已存在", { status: 409, details: { branchId } });
      const fallback = latestRetainedCheckpoint(state);
      const from = branchInput?.fromCheckpointId
        ? checkpointById(state, branchInput.fromCheckpointId, "fromCheckpointId")
        : fallback;
      invariant(!from || from.status === "retained", "VERSION_BRANCH_SOURCE_REWOUND", "不能从已回退的 Checkpoint 建立分支", { status: 409 });
      const now = isoTime(this.clock);
      state.branches[branchId] = {
        id: branchId,
        conversationId,
        fromCheckpointId: from?.id || null,
        headCheckpointId: from?.id || null,
        createdAt: now,
      };
      return { state, result: clone(state.branches[branchId]) };
    });
  }

  async checkpoint(input, checkpointInput) {
    const locator = normalizeLocator(input);
    const checkpointId = assertVersionId(checkpointInput?.checkpointId, "checkpointId");
    const branchId = assertVersionId(checkpointInput?.branchId, "branchId");
    const conversationId = assertVersionId(checkpointInput?.conversationId, "conversationId");
    return this.#mutateState(locator, async (state) => {
      invariant(!state.checkpoints.some((entry) => entry.id === checkpointId), "VERSION_CHECKPOINT_EXISTS", "Checkpoint 已存在", { status: 409 });
      const branch = state.branches[branchId];
      invariant(branch, "VERSION_BRANCH_NOT_FOUND", "逻辑分支不存在", { status: 404, details: { branchId } });
      invariant(branch.conversationId === conversationId, "VERSION_BRANCH_CONVERSATION_MISMATCH", "逻辑分支不属于该对话", { status: 409 });
      const changes = normalizeChanges(await this.remoteFs.diffTree({
        sourceRoot: state.workspace.rootPath,
        shadowRoot: state.storage.workTree,
        exclude: [...EXCLUDED_WORKSPACE_ENTRIES],
      }));
      await this.remoteFs.syncTree({
        sourceRoot: state.workspace.rootPath,
        shadowRoot: state.storage.workTree,
        exclude: [...EXCLUDED_WORKSPACE_ENTRIES],
      });
      const commitId = await this.#commitShadow(state.storage, `EasyWork checkpoint ${checkpointId}`);
      const checkpoint = {
        id: checkpointId,
        sequence: state.sequence + 1,
        conversationId,
        logicalBranchId: branchId,
        parentCheckpointId: branch.headCheckpointId,
        commitId,
        status: "retained",
        changes,
        message: String(checkpointInput?.message || "").slice(0, 4096),
        createdAt: isoTime(this.clock),
        rewoundAt: null,
      };
      state.sequence = checkpoint.sequence;
      state.checkpoints.push(checkpoint);
      branch.headCheckpointId = checkpoint.id;
      return { state, result: clone(checkpoint) };
    });
  }

  async rewind(input, rewindInput) {
    const locator = normalizeLocator(input);
    const branchId = assertVersionId(rewindInput?.branchId, "branchId");
    const targetCheckpointId = assertVersionId(rewindInput?.targetCheckpointId, "targetCheckpointId");
    const rewindId = assertVersionId(rewindInput?.rewindId, "rewindId");
    const lockKey = `domain:${locator.actorId}:${locator.serverIdentity}:${locator.versionDomainId}`;
    return this.#withLock(lockKey, async () => {
      const state = await this.getDomain(locator);
      invariant(!state.rewinds.some((entry) => entry.id === rewindId), "VERSION_REWIND_EXISTS", "Rewind ID 已存在", { status: 409 });
      const branch = state.branches[branchId];
      invariant(branch, "VERSION_BRANCH_NOT_FOUND", "逻辑分支不存在", { status: 404 });
      const target = checkpointById(state, targetCheckpointId, "targetCheckpointId");
      invariant(target.logicalBranchId === branchId && target.status === "retained", "VERSION_REWIND_TARGET_INVALID", "目标 Checkpoint 不属于该分支或已失效", { status: 409 });
      const candidates = state.checkpoints.filter((checkpoint) => checkpoint.logicalBranchId === branchId && checkpoint.status === "retained" && checkpoint.sequence > target.sequence);
      const candidateIds = new Set(candidates.map((checkpoint) => checkpoint.id));
      const dependentBranches = Object.values(state.branches).filter((entry) => entry.id !== branchId && candidateIds.has(entry.fromCheckpointId));
      const dependentCheckpoints = state.checkpoints.filter((entry) => entry.status === "retained" && !candidateIds.has(entry.id) && candidateIds.has(entry.parentCheckpointId));
      if (dependentBranches.length || dependentCheckpoints.length) {
        return {
          applied: false,
          conflict: {
            code: "VERSION_REWIND_DEPENDENT_BRANCH",
            message: "待撤销 Checkpoint 已被保留分支引用",
            branchIds: dependentBranches.map((entry) => entry.id),
            checkpointIds: dependentCheckpoints.map((entry) => entry.id),
          },
          plan: null,
          state,
        };
      }

      const plan = this.#buildRewindPlan(state, candidates);
      const fingerprintConflicts = [];
      for (const operation of plan.operations) {
        const actual = validateSnapshot(await this.remoteFs.fingerprint({ root: state.workspace.rootPath, path: operation.path }), `fingerprint(${operation.path})`);
        if (!snapshotEquals(actual, operation.expected)) {
          fingerprintConflicts.push({ path: operation.path, expected: operation.expected, actual });
        }
      }
      if (fingerprintConflicts.length) {
        return {
          applied: false,
          conflict: {
            code: "VERSION_REWIND_WORKSPACE_CONFLICT",
            message: "工作区已被未记录的写入修改，回退已停止",
            paths: fingerprintConflicts,
          },
          plan,
          state,
        };
      }

      for (const operation of plan.operations) {
        if (operation.action === "remove") {
          await this.remoteFs.removePath({ root: state.workspace.rootPath, path: operation.path });
        } else {
          await this.remoteFs.restorePath({
            gitDir: state.storage.repositoryGit,
            commitId: operation.commitId,
            relativePath: operation.path,
            destinationRoot: state.workspace.rootPath,
          });
        }
      }
      await this.remoteFs.syncTree({
        sourceRoot: state.workspace.rootPath,
        shadowRoot: state.storage.workTree,
        exclude: [...EXCLUDED_WORKSPACE_ENTRIES],
      });
      const rewindCommitId = await this.#commitShadow(state.storage, `EasyWork rewind ${rewindId}`);
      const now = isoTime(this.clock);
      for (const checkpoint of state.checkpoints) {
        if (candidateIds.has(checkpoint.id)) {
          checkpoint.status = "rewound";
          checkpoint.rewoundAt = now;
        }
      }
      branch.headCheckpointId = target.id;
      const rewind = {
        id: rewindId,
        logicalBranchId: branchId,
        targetCheckpointId: target.id,
        removedCheckpointIds: candidates.map((entry) => entry.id),
        operations: plan.operations.map((entry) => ({ action: entry.action, path: entry.path, sourceCheckpointId: entry.sourceCheckpointId })),
        commitId: rewindCommitId,
        createdAt: now,
      };
      state.rewinds.push(rewind);
      state.revision += 1;
      state.updatedAt = now;
      const layout = storageLayout({ baseRoot: this.baseRoot, ...locator });
      await this.remoteFs.writeJsonAtomic(layout.stateFile, state, { expectedRevision: state.revision - 1 });
      return { applied: true, conflict: null, plan, rewind: clone(rewind), state: clone(state) };
    });
  }

  #buildRewindPlan(state, candidates) {
    const candidateIds = new Set(candidates.map((entry) => entry.id));
    const touchedPaths = [...new Set(candidates.flatMap((checkpoint) => checkpoint.changes.map((change) => change.path)))].sort();
    const operations = [];
    for (const relativePath of touchedPaths) {
      const events = state.checkpoints
        .filter((checkpoint) => checkpoint.status === "retained")
        .flatMap((checkpoint) => checkpoint.changes.filter((change) => change.path === relativePath).map((change) => ({ checkpoint, change })))
        .sort((left, right) => left.checkpoint.sequence - right.checkpoint.sequence);
      const latest = events.at(-1);
      if (!latest || !candidateIds.has(latest.checkpoint.id)) continue;
      const retained = [...events].reverse().find((entry) => !candidateIds.has(entry.checkpoint.id)) || null;
      const firstRemoved = events.find((entry) => candidateIds.has(entry.checkpoint.id));
      const desired = retained?.change.after || firstRemoved.change.before;
      operations.push({
        action: desired.exists ? "restore" : "remove",
        path: relativePath,
        expected: clone(latest.change.after),
        desired: clone(desired),
        commitId: retained?.checkpoint.commitId || state.baselineCommitId,
        sourceCheckpointId: retained?.checkpoint.id || null,
      });
    }
    return {
      removedCheckpointIds: candidates.map((entry) => entry.id),
      operations,
    };
  }

  async #recordDynamicPath(locator, targetPath) {
    return this.#mutateState(locator, async (state) => {
      invariant(targetPath === state.workspace.rootPath || targetPath.startsWith(`${state.workspace.rootPath}/`), "DYNAMIC_WRITE_OUTSIDE_DOMAIN", "动态写入路径不属于该版本域", { status: 409 });
      if (!state.workspace.dynamicPaths.includes(targetPath)) state.workspace.dynamicPaths.push(targetPath);
      state.workspace.dynamicPaths.sort();
      return { state, result: clone(state) };
    });
  }

  async #mutateState(locator, mutation) {
    const lockKey = `domain:${locator.actorId}:${locator.serverIdentity}:${locator.versionDomainId}`;
    return this.#withLock(lockKey, async () => {
      const current = await this.getDomain(locator);
      const originalRevision = current.revision;
      const outcome = await mutation(current);
      const next = outcome?.state || current;
      next.revision = originalRevision + 1;
      next.updatedAt = isoTime(this.clock);
      const layout = storageLayout({ baseRoot: this.baseRoot, ...locator });
      await this.remoteFs.writeJsonAtomic(layout.stateFile, next, { expectedRevision: originalRevision });
      return clone(outcome?.result ?? next);
    });
  }

  async #readRegistry({ actorId, serverIdentity, registryFile }) {
    const value = await this.remoteFs.readJson(registryFile);
    return validateRegistry(value, { actorId, serverIdentity });
  }

  async #git(storage, args) {
    const root = String(storage.root || "");
    for (const candidate of [storage.repositoryGit, storage.workTree, storage.indexFile, storage.configFile]) {
      invariant(String(candidate || "").startsWith(`${root}/`), "VERSION_GIT_STORAGE_ESCAPE", "Git 隔离路径越界", { status: 500, expose: false });
    }
    return normalizeGitResult(await this.remoteExec.git({
      gitDir: storage.repositoryGit,
      workTree: storage.workTree,
      indexFile: storage.indexFile,
      configFile: storage.configFile,
      args: [...args],
    }));
  }

  async #commitShadow(storage, message) {
    await this.#git(storage, ["add", "--all", "--", "."]);
    await this.#git(storage, ["commit", "--allow-empty", "-m", message]);
    const result = await this.#git(storage, ["rev-parse", "HEAD"]);
    return assertVersionId(result.stdout.trim(), "commitId");
  }

  async #withLock(key, operation) {
    const previous = this.#locks.get(key) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.#locks.set(key, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#locks.get(key) === queued) this.#locks.delete(key);
    }
  }
}

export { EXCLUDED_WORKSPACE_ENTRIES };
