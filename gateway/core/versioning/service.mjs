import crypto from "node:crypto";

import { invariant } from "../errors.mjs";
import { withVersionScope, inVersionScope, versionScopeEpoch, bumpVersionScopeEpoch, versionScopeKey } from "./publication-gate.mjs";
import {
  WORKSPACE_MODES,
  assertServerIdentity,
  assertVersionId,
  assertVersionedAbsolutePath,
  assertVersioningDependencies,
  assertWorkspaceAbsolutePath,
  normalizeChanges,
  storageLayout,
  validateSnapshot,
  versionDomainId as deriveVersionDomainId,
} from "./contract.mjs";

const SCHEMA_VERSION = 3;
const MATERIALIZATION_SCHEMA_VERSION = 2;

function exactRecord(value, keys, code, message) {
  invariant(
    value !== null
      && typeof value === "object"
      && !Array.isArray(value)
      && Object.keys(value).length === keys.length
      && keys.every((key) => Object.hasOwn(value, key)),
    code,
    message,
    { status: 500, expose: false },
  );
  return value;
}

function currentTimestamp(value, field) {
  const parsed = typeof value === "string" ? new Date(value) : null;
  invariant(parsed && !Number.isNaN(parsed.valueOf()) && value.length > 0 && parsed.toISOString() === value,
    "VERSION_TIMESTAMP_INVALID", `${field} 无效`, { status: 500, expose: false });
  return value;
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function isoTime(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  invariant(!Number.isNaN(date.valueOf()), "VERSION_CLOCK_INVALID", "版本服务时钟返回值无效", { status: 500, expose: false });
  return date.toISOString();
}

function normalizeLocator(input) {
  return {
    actorId: assertVersionId(input?.actorId, "actorId"),
    serverIdentity: assertServerIdentity(input?.serverIdentity),
    versionDomainId: assertVersionId(input?.versionDomainId, "versionDomainId"),
  };
}

function normalizeDomainInput(input) {
  const mode = String(input?.mode || "");
  invariant(WORKSPACE_MODES.includes(mode), "VERSION_WORKSPACE_MODE_INVALID", "工作区模式必须是 real 或 virtual", { status: 400 });
  return {
    actorId: assertVersionId(input?.actorId, "actorId"),
    serverIdentity: assertServerIdentity(input?.serverIdentity),
    conversationId: assertVersionId(input?.conversationId, "conversationId"),
    workspaceId: assertVersionId(input?.workspaceId, "workspaceId"),
    rootPath: assertWorkspaceAbsolutePath(input?.rootPath),
    mode,
  };
}

function snapshotsEqual(leftValue, rightValue) {
  const left = validateSnapshot(leftValue, "leftSnapshot");
  const right = validateSnapshot(rightValue, "rightSnapshot");
  return left.exists === right.exists
    && (!left.exists || (left.type === right.type && left.sha256 === right.sha256 && left.size === right.size && left.mode === right.mode));
}

function isSameOrDescendantPath(candidateValue, ancestorValue) {
  const candidate = assertVersionedAbsolutePath(candidateValue, "candidatePath");
  const ancestor = assertVersionedAbsolutePath(ancestorValue, "ancestorPath");
  return candidate === ancestor || candidate.startsWith(ancestor === "/" ? "/" : `${ancestor}/`);
}

function nearestTrackedAncestor(entries, candidate) {
  return entries
    .filter((entry) => isSameOrDescendantPath(candidate, entry.path))
    .sort((left, right) => left.path.length - right.path.length || left.path.localeCompare(right.path))[0] || null;
}

function checkpointById(state, checkpointId, field = "checkpointId") {
  const id = assertVersionId(checkpointId, field);
  const checkpoint = state.checkpoints.find((entry) => entry.id === id);
  invariant(checkpoint, "VERSION_CHECKPOINT_NOT_FOUND", `Checkpoint 不存在: ${id}`, { status: 404, details: { checkpointId: id } });
  return checkpoint;
}

function checkpointMap(state) {
  return new Map(state.checkpoints.map((entry) => [entry.id, entry]));
}

function lineageTo(state, checkpointValue) {
  const byId = checkpointMap(state);
  const selected = [];
  const seen = new Set();
  let checkpoint = typeof checkpointValue === "string" ? byId.get(checkpointValue) || null : checkpointValue;
  while (checkpoint && !seen.has(checkpoint.id)) {
    seen.add(checkpoint.id);
    selected.push(checkpoint);
    checkpoint = checkpoint.parentCheckpointId ? byId.get(checkpoint.parentCheckpointId) || null : null;
  }
  return selected.reverse();
}

function retainedBranchLineage(state, branch) {
  return lineageTo(state, branch?.headCheckpointId || null).filter((entry) => entry.status === "retained");
}

function latestRetainedCheckpoint(state) {
  return [...state.checkpoints].reverse().find((entry) => entry.status === "retained") || null;
}

function normalizeWorkspace(entry, index = 0) {
  exactRecord(entry, ["id", "rootPath", "mode", "createdAt", "lastSeenAt"], "VERSION_WORKSPACE_FORMAT_INVALID", `workspaces[${index}] 不是当前格式`);
  const mode = String(entry?.mode || "");
  invariant(WORKSPACE_MODES.includes(mode), "VERSION_WORKSPACE_MODE_INVALID", `workspaces[${index}].mode 无效`, { status: 500, expose: false });
  return {
    id: assertVersionId(entry?.id, `workspaces[${index}].id`),
    rootPath: assertWorkspaceAbsolutePath(entry?.rootPath, `workspaces[${index}].rootPath`),
    mode,
    createdAt: currentTimestamp(entry.createdAt, `workspaces[${index}].createdAt`),
    lastSeenAt: currentTimestamp(entry.lastSeenAt, `workspaces[${index}].lastSeenAt`),
  };
}

function validateRegistry(value, locator) {
  if (value == null) {
    return {
      schemaVersion: SCHEMA_VERSION,
      revision: 0,
      actorId: locator.actorId,
      serverIdentity: locator.serverIdentity,
      ledgers: [],
    };
  }
  exactRecord(value, ["schemaVersion", "revision", "actorId", "serverIdentity", "ledgers"], "VERSION_REGISTRY_INVALID", "版本账本注册表不是当前格式");
  invariant(value?.schemaVersion === SCHEMA_VERSION, "VERSION_REGISTRY_SCHEMA_INVALID", "对话版本账本注册表格式无效", { status: 500, expose: false });
  invariant(value.actorId === locator.actorId && value.serverIdentity === locator.serverIdentity, "VERSION_REGISTRY_SCOPE_MISMATCH", "版本账本注册表作用域不一致", { status: 500, expose: false });
  invariant(Number.isSafeInteger(value.revision) && value.revision >= 0 && Array.isArray(value.ledgers), "VERSION_REGISTRY_INVALID", "版本账本注册表内容无效", { status: 500, expose: false });
  const seen = new Set();
  const ledgers = value.ledgers.map((entry, index) => {
    exactRecord(entry, ["versionDomainId", "conversationId", "createdAt"], "VERSION_REGISTRY_INVALID", `ledgers[${index}] 不是当前格式`);
    const normalized = {
      versionDomainId: assertVersionId(entry?.versionDomainId, `ledgers[${index}].versionDomainId`),
      conversationId: assertVersionId(entry?.conversationId, `ledgers[${index}].conversationId`),
      createdAt: currentTimestamp(entry.createdAt, `ledgers[${index}].createdAt`),
    };
    invariant(!seen.has(normalized.versionDomainId), "VERSION_REGISTRY_INVALID", "版本账本注册表包含重复域", { status: 500, expose: false });
    seen.add(normalized.versionDomainId);
    return normalized;
  });
  return { ...clone(value), ledgers };
}

function validateMaterializations(value, locator) {
  if (value == null) {
    return {
      schemaVersion: MATERIALIZATION_SCHEMA_VERSION,
      revision: 0,
      actorId: locator.actorId,
      serverIdentity: locator.serverIdentity,
      paths: {},
      updatedAt: null,
    };
  }
  exactRecord(value, ["schemaVersion", "revision", "actorId", "serverIdentity", "paths", "updatedAt"], "VERSION_MATERIALIZATION_INVALID", "版本物化索引不是当前格式");
  invariant(value?.schemaVersion === MATERIALIZATION_SCHEMA_VERSION, "VERSION_MATERIALIZATION_SCHEMA_INVALID", "版本物化索引格式无效", { status: 500, expose: false });
  invariant(value.actorId === locator.actorId && value.serverIdentity === locator.serverIdentity, "VERSION_MATERIALIZATION_SCOPE_MISMATCH", "版本物化索引作用域不一致", { status: 500, expose: false });
  invariant(Number.isSafeInteger(value.revision) && value.revision >= 0 && value.paths && typeof value.paths === "object" && !Array.isArray(value.paths), "VERSION_MATERIALIZATION_INVALID", "版本物化索引内容无效", { status: 500, expose: false });
  invariant(value.updatedAt === null || typeof value.updatedAt === "string", "VERSION_MATERIALIZATION_INVALID", "版本物化索引 updatedAt 无效", { status: 500, expose: false });
  if (value.updatedAt === null) invariant(value.revision === 0 && Object.keys(value.paths).length === 0, "VERSION_MATERIALIZATION_INVALID", "版本物化索引缺少更新时间", { status: 500, expose: false });
  else currentTimestamp(value.updatedAt, "materializations.updatedAt");
  const paths = {};
  for (const [candidate, entry] of Object.entries(value.paths)) {
    const absolutePath = assertVersionedAbsolutePath(candidate, "materializations.path");
    exactRecord(entry, ["current", "domains"], "VERSION_MATERIALIZATION_INVALID", `materializations[${absolutePath}] 不是当前格式`);
    invariant(entry.current && typeof entry.current === "object" && !Array.isArray(entry.current)
      && entry.domains && typeof entry.domains === "object" && !Array.isArray(entry.domains),
    "VERSION_MATERIALIZATION_INVALID", `materializations[${absolutePath}] 内容无效`, { status: 500, expose: false });
    const normalizeHead = (head, field) => {
      exactRecord(head, ["checkpointId", "snapshot", "updatedAt"], "VERSION_MATERIALIZATION_INVALID", `${field} 不是当前格式`);
      return {
        checkpointId: head?.checkpointId === null ? null : assertVersionId(head?.checkpointId, `${field}.checkpointId`),
        snapshot: validateSnapshot(head?.snapshot, `${field}.snapshot`),
        updatedAt: currentTimestamp(head.updatedAt, `${field}.updatedAt`),
      };
    };
    const domains = {};
    for (const [domainIdValue, head] of Object.entries(entry.domains)) {
      const domainId = assertVersionId(domainIdValue, `materializations[${absolutePath}].domains`);
      domains[domainId] = normalizeHead(head, `materializations[${absolutePath}].domains.${domainId}`);
    }
    exactRecord(entry.current, ["versionDomainId", "snapshot", "updatedAt"], "VERSION_MATERIALIZATION_INVALID", `materializations[${absolutePath}].current 不是当前格式`);
    const currentDomainId = entry.current.versionDomainId === null
      ? null
      : assertVersionId(entry.current.versionDomainId, `materializations[${absolutePath}].current.versionDomainId`);
    const currentSnapshot = validateSnapshot(entry.current.snapshot, `materializations[${absolutePath}].current.snapshot`);
    const currentUpdatedAt = currentTimestamp(entry.current.updatedAt, `materializations[${absolutePath}].current.updatedAt`);
    invariant(currentDomainId === null || (domains[currentDomainId] && snapshotsEqual(domains[currentDomainId].snapshot, currentSnapshot)),
      "VERSION_MATERIALIZATION_INVALID", `materializations[${absolutePath}] 当前归属与对话 HEAD 不一致`, { status: 500, expose: false });
    paths[absolutePath] = { current: { versionDomainId: currentDomainId, snapshot: currentSnapshot, updatedAt: currentUpdatedAt }, domains };
  }
  return { ...clone(value), paths };
}

function validateCheckpoint(entry, index) {
  exactRecord(entry, [
    "id", "sequence", "conversationId", "logicalBranchId", "parentCheckpointId", "taskId", "boundary",
    "status", "changes", "message", "createdAt", "rewoundAt",
  ], "VERSION_CHECKPOINT_INVALID", `checkpoints[${index}] 不是当前格式`);
  const status = String(entry?.status || "");
  invariant(["retained", "rewound"].includes(status), "VERSION_CHECKPOINT_INVALID", `checkpoints[${index}].status 无效`, { status: 500, expose: false });
  invariant(Number.isSafeInteger(entry.sequence) && entry.sequence > 0, "VERSION_CHECKPOINT_INVALID", `checkpoints[${index}].sequence 无效`, { status: 500, expose: false });
  invariant(["before", "after", "manual"].includes(entry.boundary), "VERSION_CHECKPOINT_INVALID", `checkpoints[${index}].boundary 无效`, { status: 500, expose: false });
  invariant(entry.taskId === null || typeof entry.taskId === "string", "VERSION_CHECKPOINT_INVALID", `checkpoints[${index}].taskId 无效`, { status: 500, expose: false });
  if (entry.taskId !== null) assertVersionId(entry.taskId, `checkpoints[${index}].taskId`);
  invariant(typeof entry.message === "string", "VERSION_CHECKPOINT_INVALID", `checkpoints[${index}].message 无效`, { status: 500, expose: false });
  currentTimestamp(entry.createdAt, `checkpoints[${index}].createdAt`);
  invariant(entry.rewoundAt === null || typeof entry.rewoundAt === "string", "VERSION_CHECKPOINT_INVALID", `checkpoints[${index}].rewoundAt 无效`, { status: 500, expose: false });
  if (entry.rewoundAt !== null) currentTimestamp(entry.rewoundAt, `checkpoints[${index}].rewoundAt`);
  invariant(Array.isArray(entry.changes), "VERSION_CHECKPOINT_INVALID", `checkpoints[${index}].changes 无效`, { status: 500, expose: false });
  for (const [changeIndex, change] of entry.changes.entries()) {
    exactRecord(change, ["path", "workspaceId", "before", "after"], "VERSION_CHECKPOINT_INVALID", `checkpoints[${index}].changes[${changeIndex}] 不是当前格式`);
  }
  return {
    ...clone(entry),
    id: assertVersionId(entry?.id, `checkpoints[${index}].id`),
    sequence: entry.sequence,
    conversationId: assertVersionId(entry?.conversationId, `checkpoints[${index}].conversationId`),
    logicalBranchId: assertVersionId(entry?.logicalBranchId, `checkpoints[${index}].logicalBranchId`),
    parentCheckpointId: entry?.parentCheckpointId == null ? null : assertVersionId(entry.parentCheckpointId, `checkpoints[${index}].parentCheckpointId`),
    status,
    boundary: entry.boundary,
    changes: normalizeChanges(entry.changes),
  };
}

function validatePendingTask(entry, key) {
  invariant(entry && typeof entry === "object" && !Array.isArray(entry)
    && Object.keys(entry).length === 8
    && ["taskId", "branchId", "beforeCheckpointId", "agentId", "agentBindingId", "workspaceId", "paths", "createdAt"].every((field) => Object.hasOwn(entry, field)),
  "VERSION_STATE_PENDING_INVALID", `pending(${key}) 格式无效`, { status: 500, expose: false });
  const taskId = assertVersionId(entry.taskId, `pending(${key}).taskId`);
  invariant(taskId === key, "VERSION_STATE_PENDING_INVALID", `pending(${key}) taskId 不一致`, { status: 500, expose: false });
  const paths = {};
  invariant(entry.paths && typeof entry.paths === "object" && !Array.isArray(entry.paths),
    "VERSION_STATE_PENDING_INVALID", `pending(${key}).paths 无效`, { status: 500, expose: false });
  for (const [candidate, record] of Object.entries(entry.paths)) {
    const absolutePath = assertVersionedAbsolutePath(candidate, `pending(${key}).path`);
    invariant(record && typeof record === "object" && !Array.isArray(record)
      && Object.keys(record).length === 4
      && ["path", "workspaceId", "before", "stagedAt"].every((field) => Object.hasOwn(record, field))
      && record.path === absolutePath,
    "VERSION_STATE_PENDING_INVALID", `pending(${key}).paths(${absolutePath}) 无效`, { status: 500, expose: false });
    paths[absolutePath] = {
      path: absolutePath,
      workspaceId: assertVersionId(record.workspaceId, `pending(${key}).paths(${absolutePath}).workspaceId`),
      before: validateSnapshot(record.before, `pending(${key}).paths(${absolutePath}).before`),
      stagedAt: currentTimestamp(record.stagedAt, `pending(${key}).paths(${absolutePath}).stagedAt`),
    };
  }
  return {
    taskId,
    branchId: assertVersionId(entry.branchId, `pending(${key}).branchId`),
    beforeCheckpointId: assertVersionId(entry.beforeCheckpointId, `pending(${key}).beforeCheckpointId`),
    agentId: assertVersionId(entry.agentId, `pending(${key}).agentId`),
    agentBindingId: assertVersionId(entry.agentBindingId, `pending(${key}).agentBindingId`),
    workspaceId: assertVersionId(entry.workspaceId, `pending(${key}).workspaceId`),
    paths,
    createdAt: currentTimestamp(entry.createdAt, `pending(${key}).createdAt`),
  };
}

function validateHookOperations(operations) {
  invariant(Array.isArray(operations), "VERSION_AGENT_OPERATIONS_INVALID", "执行前版本清单查询结果无效", { status: 502 });
  return operations.map((operation, index) => {
    invariant(operation && typeof operation === "object" && !Array.isArray(operation)
      && Object.keys(operation).every((key) => ["operationId", "createdAtNs"].includes(key))
      && /^op_[a-f0-9]{24}$/.test(String(operation.operationId || ""))
      && /^\d{16,24}$/.test(String(operation.createdAtNs || "")),
    "VERSION_AGENT_OPERATIONS_INVALID", `执行前版本清单查询结果[${index}]无效`, { status: 502 });
    return { operationId: String(operation.operationId), createdAtNs: String(operation.createdAtNs) };
  });
}

function validateDomainState(value, locator) {
  exactRecord(value, [
    "schemaVersion", "revision", "actorId", "serverIdentity", "conversationId", "versionDomainId", "storage",
    "workspaces", "sequence", "checkpoints", "branches", "pending", "rewinds", "switches", "forkedFrom",
    "createdAt", "updatedAt",
  ], "VERSION_STATE_SCHEMA_INVALID", "对话版本账本不是当前格式");
  invariant(value?.schemaVersion === SCHEMA_VERSION, "VERSION_STATE_SCHEMA_INVALID", "对话版本账本格式无效", { status: 500, expose: false });
  invariant(value.actorId === locator.actorId && value.serverIdentity === locator.serverIdentity && value.versionDomainId === locator.versionDomainId, "VERSION_STATE_SCOPE_MISMATCH", "版本账本作用域不一致", { status: 500, expose: false });
  invariant(Number.isSafeInteger(value.revision) && value.revision >= 0, "VERSION_STATE_REVISION_INVALID", "版本账本 revision 无效", { status: 500, expose: false });
  invariant(Number.isSafeInteger(value.sequence) && value.sequence >= 0, "VERSION_STATE_SEQUENCE_INVALID", "版本账本 sequence 无效", { status: 500, expose: false });
  assertVersionId(value.conversationId, "conversationId");
  invariant(Array.isArray(value.workspaces) && Array.isArray(value.checkpoints) && value.branches && typeof value.branches === "object" && !Array.isArray(value.branches), "VERSION_STATE_CONTENT_INVALID", "版本账本内容无效", { status: 500, expose: false });
  invariant(value.pending && typeof value.pending === "object" && !Array.isArray(value.pending), "VERSION_STATE_PENDING_INVALID", "版本账本待提交事务无效", { status: 500, expose: false });
  invariant(Array.isArray(value.rewinds) && Array.isArray(value.switches), "VERSION_STATE_CONTENT_INVALID", "版本账本操作记录无效", { status: 500, expose: false });
  exactRecord(value.storage, ["root", "stateFile", "objectsRoot"], "VERSION_STORAGE_MISMATCH", "版本账本存储描述不是当前格式");
  currentTimestamp(value.createdAt, "createdAt");
  currentTimestamp(value.updatedAt, "updatedAt");
  const workspaces = value.workspaces.map(normalizeWorkspace);
  const checkpoints = value.checkpoints.map(validateCheckpoint);
  const ids = new Set(checkpoints.map((entry) => entry.id));
  invariant(ids.size === checkpoints.length, "VERSION_STATE_CONTENT_INVALID", "版本账本包含重复 Checkpoint", { status: 500, expose: false });
  for (const [branchKey, branch] of Object.entries(value.branches)) {
    exactRecord(branch, ["id", "conversationId", "fromCheckpointId", "headCheckpointId", "createdAt"], "VERSION_BRANCH_INVALID", `branches.${branchKey} 不是当前格式`);
    assertVersionId(branch?.id, "branch.id");
    invariant(branchKey === branch.id && branch.conversationId === value.conversationId, "VERSION_BRANCH_INVALID", "版本分支作用域无效", { status: 500, expose: false });
    if (branch.fromCheckpointId !== null) invariant(ids.has(branch.fromCheckpointId), "VERSION_BRANCH_SOURCE_INVALID", "版本分支起点不存在", { status: 500, expose: false });
    if (branch?.headCheckpointId != null) invariant(ids.has(branch.headCheckpointId), "VERSION_BRANCH_HEAD_INVALID", "版本分支 HEAD 不存在", { status: 500, expose: false });
    currentTimestamp(branch.createdAt, `branches.${branchKey}.createdAt`);
  }
  for (const [index, rewind] of value.rewinds.entries()) {
    exactRecord(rewind, ["id", "logicalBranchId", "targetCheckpointId", "removedCheckpointIds", "operations", "createdAt"], "VERSION_REWIND_INVALID", `rewinds[${index}] 不是当前格式`);
    assertVersionId(rewind.id, `rewinds[${index}].id`);
    assertVersionId(rewind.logicalBranchId, `rewinds[${index}].logicalBranchId`);
    assertVersionId(rewind.targetCheckpointId, `rewinds[${index}].targetCheckpointId`);
    invariant(Array.isArray(rewind.removedCheckpointIds) && Array.isArray(rewind.operations), "VERSION_REWIND_INVALID", `rewinds[${index}] 内容无效`, { status: 500, expose: false });
    rewind.removedCheckpointIds.forEach((id, removedIndex) => assertVersionId(id, `rewinds[${index}].removedCheckpointIds[${removedIndex}]`));
    rewind.operations.forEach((operation, operationIndex) => {
      exactRecord(operation, ["path", "workspaceId"], "VERSION_REWIND_INVALID", `rewinds[${index}].operations[${operationIndex}] 不是当前格式`);
      assertVersionedAbsolutePath(operation.path, `rewinds[${index}].operations[${operationIndex}].path`);
      if (operation.workspaceId !== null) assertVersionId(operation.workspaceId, `rewinds[${index}].operations[${operationIndex}].workspaceId`);
    });
    currentTimestamp(rewind.createdAt, `rewinds[${index}].createdAt`);
  }
  for (const [index, record] of value.switches.entries()) {
    exactRecord(record, ["id", "targetCheckpointId", "preserveDomainHead", "operations", "createdAt"], "VERSION_SWITCH_INVALID", `switches[${index}] 不是当前格式`);
    assertVersionId(record.id, `switches[${index}].id`);
    assertVersionId(record.targetCheckpointId, `switches[${index}].targetCheckpointId`);
    invariant(typeof record.preserveDomainHead === "boolean" && Array.isArray(record.operations), "VERSION_SWITCH_INVALID", `switches[${index}] 内容无效`, { status: 500, expose: false });
    record.operations.forEach((operation, operationIndex) => {
      exactRecord(operation, ["path", "workspaceId"], "VERSION_SWITCH_INVALID", `switches[${index}].operations[${operationIndex}] 不是当前格式`);
      assertVersionedAbsolutePath(operation.path, `switches[${index}].operations[${operationIndex}].path`);
      if (operation.workspaceId !== null) assertVersionId(operation.workspaceId, `switches[${index}].operations[${operationIndex}].workspaceId`);
    });
    currentTimestamp(record.createdAt, `switches[${index}].createdAt`);
  }
  invariant(value.forkedFrom === null || (value.forkedFrom && typeof value.forkedFrom === "object" && !Array.isArray(value.forkedFrom)), "VERSION_FORK_SOURCE_INVALID", "forkedFrom 无效", { status: 500, expose: false });
  if (value.forkedFrom !== null) {
    exactRecord(value.forkedFrom, ["versionDomainId", "conversationId", "checkpointId"], "VERSION_FORK_SOURCE_INVALID", "forkedFrom 不是当前格式");
    assertVersionId(value.forkedFrom.versionDomainId, "forkedFrom.versionDomainId");
    assertVersionId(value.forkedFrom.conversationId, "forkedFrom.conversationId");
    assertVersionId(value.forkedFrom.checkpointId, "forkedFrom.checkpointId");
  }
  const pending = Object.fromEntries(Object.entries(value.pending).map(([key, entry]) => [key, validatePendingTask(entry, key)]));
  return { ...clone(value), workspaces, checkpoints, pending, forkedFrom: clone(value.forkedFrom) };
}

function workspaceRecord(scope, now) {
  return { id: scope.workspaceId, rootPath: scope.rootPath, mode: scope.mode, createdAt: now, lastSeenAt: now };
}

function checkpointRecord({ state, id, branchId, parentCheckpointId, boundary, changes, message, taskId = null, now }) {
  return {
    id,
    sequence: state.sequence + 1,
    conversationId: state.conversationId,
    logicalBranchId: branchId,
    parentCheckpointId,
    taskId,
    boundary,
    status: "retained",
    changes: normalizeChanges(changes || []),
    message: String(message || "").slice(0, 4096),
    createdAt: now,
    rewoundAt: null,
  };
}

function changedPathsAfter(lineage, targetIndex) {
  const prefix = lineage.slice(0, targetIndex + 1);
  const candidates = lineage.slice(targetIndex + 1);
  const paths = [...new Set(candidates.flatMap((checkpoint) => checkpoint.changes.map((change) => change.path)))].sort();
  const operations = [];
  for (const absolutePath of paths) {
    const prior = prefix.flatMap((checkpoint) => checkpoint.changes.filter((change) => change.path === absolutePath)).at(-1) || null;
    const later = candidates.flatMap((checkpoint) => checkpoint.changes.filter((change) => change.path === absolutePath));
    const latest = later.at(-1);
    if (!latest) continue;
    // A shared workspace may have changed between two Tasks in this web
    // conversation. The first removed Task's native preimage is the real state
    // immediately before that Task; an older checkpoint in this ledger is not.
    const desired = later[0].before;
    if (snapshotsEqual(latest.after, desired)) continue;
    operations.push({
      path: absolutePath,
      workspaceId: latest.workspaceId || prior?.workspaceId || null,
      expected: clone(latest.after),
      desired: clone(desired),
    });
  }
  return { candidates, operations };
}

function desiredSnapshotsAt(state, targetCheckpoint) {
  const lineage = lineageTo(state, targetCheckpoint);
  const lineageIds = new Set(lineage.map((entry) => entry.id));
  const desired = new Map();
  const setDesired = (change, snapshot) => {
    for (const existingPath of [...desired.keys()]) {
      if (existingPath !== change.path && isSameOrDescendantPath(existingPath, change.path)) desired.delete(existingPath);
    }
    desired.set(change.path, { path: change.path, workspaceId: change.workspaceId, desired: clone(snapshot) });
  };
  for (const checkpoint of lineage) {
    for (const change of checkpoint.changes) setDesired(change, change.after);
  }
  // A rewind may leave descendant checkpoints outside the retained lineage.
  // Their first `before` snapshot is still the correct state at the target.
  for (const checkpoint of [...state.checkpoints].sort((left, right) => left.sequence - right.sequence)) {
    if (lineageIds.has(checkpoint.id) || !lineageTo(state, checkpoint).some((entry) => entry.id === targetCheckpoint.id)) continue;
    for (const change of checkpoint.changes) {
      if (!desired.has(change.path)) setDesired(change, change.before);
    }
  }
  return [...desired.values()].sort((left, right) => left.path.localeCompare(right.path));
}

export class VersioningService {
  #locks = new Map();
  #domainCache = new Map();
  #missingDomains = new Set();
  #registryCache = new Map();
  #materializationCache = new Map();
  #lineageCache = new Map();
  #scopeEpochs = new Map();
  #pendingRecovery = new Set();

  constructor(dependencies) {
    assertVersioningDependencies(dependencies);
    this.remoteFs = dependencies.remoteFs;
    this.clock = dependencies.clock || (() => new Date());
    this.baseRoot = String(dependencies.baseRoot || "~/.easywork/versioning").replace(/\\/g, "/").replace(/\/$/, "");
    invariant(this.baseRoot.endsWith("/.easywork/versioning") || this.baseRoot === "~/.easywork/versioning", "VERSION_STORAGE_ROOT_INVALID", "版本数据必须位于 .easywork/versioning", { status: 500, expose: false });
  }

  invalidateRemoteState() {
    this.#domainCache.clear();
    this.#missingDomains.clear();
    this.#registryCache.clear();
    this.#materializationCache.clear();
    this.#lineageCache.clear();
  }

  async openDomain(input) {
    const scope = normalizeDomainInput(input);
    const domainId = input?.versionDomainId ? assertVersionId(input.versionDomainId, "versionDomainId") : deriveVersionDomainId(scope);
    const locator = { actorId: scope.actorId, serverIdentity: scope.serverIdentity, versionDomainId: domainId };
    const layout = storageLayout({ baseRoot: this.baseRoot, ...locator });
    const result = await this.#withLock(`registry:${scope.actorId}:${scope.serverIdentity}`, async () => {
      const registry = await this.#readRegistry(scope, layout.registryFile);
      const exact = registry.ledgers.find((entry) => entry.versionDomainId === domainId) || null;
      if (exact) {
        const state = await this.#registerWorkspace(locator, scope);
        invariant(state.conversationId === scope.conversationId, "VERSION_DOMAIN_SCOPE_COLLISION", "版本账本已被其他网页对话占用", { status: 409 });
        return { created: false, reused: true, state, risk: null };
      }
      const now = isoTime(this.clock);
      await this.remoteFs.mkdir(layout.objectsRoot);
      const state = {
        schemaVersion: SCHEMA_VERSION,
        revision: 0,
        actorId: scope.actorId,
        serverIdentity: scope.serverIdentity,
        conversationId: scope.conversationId,
        versionDomainId: domainId,
        storage: { root: layout.root, stateFile: layout.stateFile, objectsRoot: layout.objectsRoot },
        workspaces: [workspaceRecord(scope, now)],
        sequence: 0,
        checkpoints: [],
        branches: {},
        pending: {},
        rewinds: [],
        switches: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      };
      await this.remoteFs.writeJsonAtomic(layout.stateFile, state, { expectedRevision: null });
      const nextRegistry = {
        ...registry,
        revision: registry.revision + 1,
        ledgers: [...registry.ledgers, { versionDomainId: domainId, conversationId: scope.conversationId, createdAt: now }],
      };
      await this.remoteFs.writeJsonAtomic(layout.registryFile, nextRegistry, { expectedRevision: registry.revision === 0 && !registry.ledgers.length ? null : registry.revision });
      this.#domainCache.set(this.#domainCacheKey(locator), clone(state));
      this.#missingDomains.delete(this.#domainCacheKey(locator));
      this.#registryCache.set(this.#registryCacheKey(scope), clone(nextRegistry));
      return { created: true, reused: false, state: clone(state), risk: null };
    });
    if (result.created) this.#rememberRelatedDomainIds(locator, [result.state.versionDomainId]);
    return result;
  }

  async ensureConversationDomain(input) {
    const scope = normalizeDomainInput(input);
    const desiredId = deriveVersionDomainId(scope);
    try {
      const state = await this.#registerWorkspace({ actorId: scope.actorId, serverIdentity: scope.serverIdentity, versionDomainId: desiredId }, scope);
      return { created: false, reused: true, state, risk: null };
    } catch (error) {
      if (error?.code !== "VERSION_DOMAIN_NOT_FOUND") throw error;
    }
    return this.openDomain(scope);
  }

  async getDomain(input) {
    const locator = normalizeLocator(input);
    return this.#withScope(locator, () => this.#getDomain(locator), false);
  }

  async #getDomain(locator) {
    const cacheKey = this.#domainCacheKey(locator);
    const cached = this.#domainCache.get(cacheKey);
    if (cached) return clone(cached);
    invariant(!this.#missingDomains.has(cacheKey), "VERSION_DOMAIN_NOT_FOUND", "对话版本账本不存在", { status: 404, details: { versionDomainId: locator.versionDomainId } });
    const layout = storageLayout({ baseRoot: this.baseRoot, ...locator });
    const state = await this.remoteFs.readJson(layout.stateFile);
    if (!state) this.#missingDomains.add(cacheKey);
    invariant(state, "VERSION_DOMAIN_NOT_FOUND", "对话版本账本不存在", { status: 404, details: { versionDomainId: locator.versionDomainId } });
    const validated = validateDomainState(state, locator);
    invariant(validated.storage?.root === layout.root && validated.storage?.stateFile === layout.stateFile && validated.storage?.objectsRoot === layout.objectsRoot, "VERSION_STORAGE_MISMATCH", "版本账本隔离存储路径无效", { status: 500, expose: false });
    this.#domainCache.set(cacheKey, clone(validated));
    return clone(validated);
  }

  async createLogicalBranch(input, branchInput) {
    const locator = normalizeLocator(input);
    const branchId = assertVersionId(branchInput?.branchId, "branchId");
    const conversationId = assertVersionId(branchInput?.conversationId, "conversationId");
    return this.#mutateState(locator, async (state) => {
      if (state.branches[branchId]) return { state, result: clone(state.branches[branchId]), unchanged: true };
      invariant(state.conversationId === conversationId, "VERSION_BRANCH_CONVERSATION_MISMATCH", "逻辑分支不属于该版本账本", { status: 409 });
      const fallback = latestRetainedCheckpoint(state);
      const from = branchInput?.fromCheckpointId ? checkpointById(state, branchInput.fromCheckpointId, "fromCheckpointId") : fallback;
      invariant(!from || from.status === "retained", "VERSION_BRANCH_SOURCE_REWOUND", "不能从已回退的 Checkpoint 建立分支", { status: 409 });
      const now = isoTime(this.clock);
      state.branches[branchId] = { id: branchId, conversationId, fromCheckpointId: from?.id || null, headCheckpointId: from?.id || null, createdAt: now };
      return { state, result: clone(state.branches[branchId]) };
    });
  }

  async beginTask(input, taskInput) {
    const locator = normalizeLocator(input);
    invariant(taskInput && typeof taskInput === "object" && !Array.isArray(taskInput)
      && Object.keys(taskInput).every((key) => ["taskId", "branchId", "conversationId", "beforeCheckpointId", "message", "agentId", "agentBindingId", "workspaceId"].includes(key)),
    "VERSION_TASK_INPUT_INVALID", "Task 文件事务输入无效", { status: 400 });
    const taskId = assertVersionId(taskInput?.taskId, "taskId");
    const branchId = assertVersionId(taskInput?.branchId, "branchId");
    const conversationId = assertVersionId(taskInput?.conversationId, "conversationId");
    const agentId = assertVersionId(taskInput?.agentId, "agentId");
    const agentBindingId = assertVersionId(taskInput?.agentBindingId, "agentBindingId");
    const workspaceId = assertVersionId(taskInput?.workspaceId, "workspaceId");
    const recoveredOperations = [];
    const materializations = await this.#readMaterializations(locator);
    const result = await this.#mutateState(locator, async (state) => {
      invariant(state.conversationId === conversationId, "VERSION_TASK_CONVERSATION_MISMATCH", "Task 不属于该版本账本", { status: 409 });
      let recovered = false;
      for (const pendingTaskId of Object.keys(state.pending).filter((value) => value !== taskId).sort()) {
        const pending = state.pending[pendingTaskId];
        const operationIds = await this.#drainPendingAgentOperationsIntoState(state, pending, materializations);
        await this.#finishPendingInState(state, pendingTaskId, {
          checkpointId: `checkpoint_${pendingTaskId}_after`,
          message: `Task ${pendingTaskId} 恢复边界`,
        });
        recoveredOperations.push({ pending: clone(pending), operationIds });
        recovered = true;
      }
      let branch = state.branches[branchId] || null;
      if (!branch) {
        const from = latestRetainedCheckpoint(state);
        const createdAt = isoTime(this.clock);
        branch = {
          id: branchId,
          conversationId,
          fromCheckpointId: from?.id || null,
          headCheckpointId: from?.id || null,
          createdAt,
        };
        state.branches[branchId] = branch;
        recovered = true;
      }
      const existingPending = state.pending[taskId] || null;
      if (existingPending) {
        invariant(existingPending.branchId === branchId
          && existingPending.agentId === agentId
          && existingPending.agentBindingId === agentBindingId
          && existingPending.workspaceId === workspaceId,
        "VERSION_TASK_TRANSACTION_MISMATCH", "Task 文件事务与当前 Agent 路由不一致", { status: 409 });
        const checkpoint = checkpointById(state, existingPending.beforeCheckpointId);
        return { state, result: clone(checkpoint), unchanged: !recovered };
      }
      const checkpointId = assertVersionId(taskInput?.beforeCheckpointId || `checkpoint_${taskId}_before`, "beforeCheckpointId");
      const existingCheckpoint = state.checkpoints.find((entry) => entry.id === checkpointId) || null;
      if (existingCheckpoint) return { state, result: clone(existingCheckpoint), unchanged: !recovered };
      const now = isoTime(this.clock);
      const checkpoint = checkpointRecord({
        state,
        id: checkpointId,
        branchId,
        parentCheckpointId: branch.headCheckpointId,
        boundary: "before",
        changes: [],
        message: taskInput?.message,
        taskId,
        now,
      });
      state.sequence = checkpoint.sequence;
      state.checkpoints.push(checkpoint);
      branch.headCheckpointId = checkpoint.id;
      state.pending[taskId] = {
        taskId,
        branchId,
        beforeCheckpointId: checkpoint.id,
        agentId,
        agentBindingId,
        workspaceId,
        paths: {},
        createdAt: now,
      };
      return { state, result: clone(checkpoint) };
    });
    for (const recovered of recoveredOperations) {
      await this.#removeCommittedAgentOperations(recovered.pending, recovered.operationIds);
    }
    return result;
  }

  async agentOperationCount(input, operationInput) {
    normalizeLocator(input);
    const taskId = assertVersionId(operationInput?.taskId, "taskId");
    const agentId = assertVersionId(operationInput?.agentId, "agentId");
    const agentBindingId = assertVersionId(operationInput?.agentBindingId, "agentBindingId");
    const operations = validateHookOperations(await this.remoteFs.listAgentHookOperations({ agentId, agentBindingId, taskId }));
    return operations.length;
  }

  async #drainPendingAgentOperationsIntoState(state, pending, materializations = null) {
    const captured = await this.remoteFs.captureAgentHookOperations({
      agentId: pending.agentId,
      agentBindingId: pending.agentBindingId,
      taskId: pending.taskId,
      objectsRoot: state.storage.objectsRoot,
    });
    invariant(captured && typeof captured === "object" && !Array.isArray(captured)
      && Object.keys(captured).length === 2
      && Array.isArray(captured.operations) && Array.isArray(captured.entries),
    "VERSION_AGENT_OPERATION_INVALID", "执行前版本批量结果无效", { status: 502 });
    const operations = validateHookOperations(captured.operations);
    const operationIds = new Set(operations.map((operation) => operation.operationId));
    const beforeCheckpoint = checkpointById(state, pending.beforeCheckpointId, "beforeCheckpointId");
    const trackedAtStart = desiredSnapshotsAt(state, beforeCheckpoint);
    for (const [index, entry] of captured.entries.entries()) {
      invariant(entry && typeof entry === "object" && !Array.isArray(entry)
        && Object.keys(entry).length === 3
        && ["operationId", "path", "snapshot"].every((key) => Object.hasOwn(entry, key))
        && operationIds.has(String(entry.operationId || "")),
      "VERSION_AGENT_OPERATION_INVALID", `执行前版本批量结果 entries[${index}] 无效`, { status: 502 });
      const capturedPath = assertVersionedAbsolutePath(entry.path, `hook.entries[${index}].path`);
      const trackedAncestor = nearestTrackedAncestor(trackedAtStart, capturedPath);
      const absolutePath = trackedAncestor?.path || capturedPath;
      const sharedAncestorSnapshot = trackedAncestor && trackedAncestor.path !== capturedPath
        ? materializations?.paths?.[absolutePath]?.current?.snapshot || null
        : null;
      const pendingAncestor = nearestTrackedAncestor(Object.values(pending.paths), absolutePath);
      if (pendingAncestor) continue;
      for (const stagedPath of Object.keys(pending.paths)) {
        if (stagedPath !== absolutePath && isSameOrDescendantPath(stagedPath, absolutePath)) delete pending.paths[stagedPath];
      }
      pending.paths[absolutePath] = {
        path: absolutePath,
        workspaceId: pending.workspaceId,
        before: trackedAncestor && trackedAncestor.path !== capturedPath
          ? validateSnapshot(sharedAncestorSnapshot || trackedAncestor.desired, `tracked(${absolutePath}).before`)
          : validateSnapshot(entry.snapshot, `hook(${absolutePath}).before`),
        stagedAt: isoTime(this.clock),
      };
    }
    return operations.map((operation) => operation.operationId);
  }

  async #removeCommittedAgentOperations(pending, operationIds) {
    if (!operationIds.length) return;
    await this.remoteFs.removeAgentHookOperations({
      agentId: pending.agentId,
      agentBindingId: pending.agentBindingId,
      taskId: pending.taskId,
      operationIds,
    });
  }

  async finishTask(input, finishInput) {
    const locator = normalizeLocator(input);
    const taskId = assertVersionId(finishInput?.taskId, "taskId");
    const checkpointId = assertVersionId(finishInput?.afterCheckpointId || `checkpoint_${taskId}_after`, "afterCheckpointId");
    let committedOperations = null;
    let committedRoute = null;
    const materializations = await this.#readMaterializations(locator);
    const checkpoint = await this.#mutateState(locator, async (state) => {
      const existing = state.checkpoints.find((entry) => entry.id === checkpointId) || null;
      if (existing) {
        const hadPending = Boolean(state.pending[taskId]);
        delete state.pending[taskId];
        return { state, result: clone(existing), unchanged: !hadPending };
      }
      const pending = state.pending[taskId];
      invariant(pending, "VERSION_TASK_TRANSACTION_NOT_FOUND", "Task 文件事务不存在", { status: 409, details: { taskId } });
      committedRoute = { taskId: pending.taskId, agentId: pending.agentId, agentBindingId: pending.agentBindingId };
      committedOperations = await this.#drainPendingAgentOperationsIntoState(state, pending, materializations);
      const checkpoint = await this.#finishPendingInState(state, taskId, { checkpointId, message: finishInput?.message });
      return { state, result: clone(checkpoint) };
    });
    await Promise.all([
      committedRoute && committedOperations?.length
        ? this.#removeCommittedAgentOperations(committedRoute, committedOperations)
        : Promise.resolve(),
      checkpoint ? this.#markCheckpointMaterialized(locator, checkpoint) : Promise.resolve(),
    ]);
    return checkpoint;
  }

  async #finishPendingInState(state, taskId, { checkpointId, message } = {}) {
    const pending = state.pending[taskId];
    invariant(pending, "VERSION_TASK_TRANSACTION_NOT_FOUND", "Task 文件事务不存在", { status: 409, details: { taskId } });
    const branch = state.branches[pending.branchId];
    invariant(branch && branch.headCheckpointId === pending.beforeCheckpointId, "VERSION_TASK_BRANCH_MOVED", "Task 执行期间版本分支已移动", { status: 409 });
    const records = Object.values(pending.paths).sort((left, right) => left.path.localeCompare(right.path));
    const captures = await this.remoteFs.capturePaths({ paths: records.map((record) => record.path), objectsRoot: state.storage.objectsRoot });
    invariant(Array.isArray(captures) && captures.length === records.length, "VERSION_CAPTURE_BATCH_INVALID", "执行后版本批量结果无效", { status: 502 });
    const changes = [];
    for (const [index, record] of records.entries()) {
      const captured = captures[index];
      invariant(captured?.path === record.path, "VERSION_CAPTURE_BATCH_INVALID", "执行后版本批量路径不一致", { status: 502 });
      const after = validateSnapshot(captured.snapshot, `capture(${record.path})`);
      const before = validateSnapshot(record.before, `pending(${record.path}).before`);
      if (!snapshotsEqual(before, after)) changes.push({ path: record.path, workspaceId: record.workspaceId, before, after });
    }
    if (!changes.length) {
      const beforeCheckpoint = checkpointById(state, pending.beforeCheckpointId, "beforeCheckpointId");
      invariant(beforeCheckpoint.logicalBranchId === pending.branchId
        && beforeCheckpoint.taskId === taskId
        && beforeCheckpoint.boundary === "before"
        && beforeCheckpoint.changes.length === 0,
      "VERSION_TASK_BOUNDARY_INVALID", "Task 变更前边界无效", { status: 500, expose: false });
      state.checkpoints = state.checkpoints.filter((entry) => entry.id !== beforeCheckpoint.id);
      state.sequence = state.checkpoints.reduce((maximum, entry) => Math.max(maximum, entry.sequence), 0);
      branch.headCheckpointId = beforeCheckpoint.parentCheckpointId;
      delete state.pending[taskId];
      return null;
    }
    const now = isoTime(this.clock);
    const checkpoint = checkpointRecord({
      state,
      id: assertVersionId(checkpointId, "afterCheckpointId"),
      branchId: pending.branchId,
      parentCheckpointId: pending.beforeCheckpointId,
      boundary: "after",
      changes,
      message,
      taskId,
      now,
    });
    state.sequence = checkpoint.sequence;
    state.checkpoints.push(checkpoint);
    branch.headCheckpointId = checkpoint.id;
    delete state.pending[taskId];
    return checkpoint;
  }

  async activateCheckpoint(input, activationInput) {
    const locator = normalizeLocator(input);
    const checkpointId = assertVersionId(activationInput?.checkpointId, "checkpointId");
    const activationId = assertVersionId(activationInput?.activationId || `activate_${checkpointId}`, "activationId");
    const ledgerKey = this.#ledgerLockKey(locator);
    const materializationKey = this.#materializationLockKey(locator);
    return this.#withLocks([ledgerKey, materializationKey], async () => {
      const state = await this.getDomain(locator);
      const target = checkpointById(state, checkpointId);
      invariant(target.status === "retained", "VERSION_ACTIVATION_TARGET_INVALID", "不能物化已失效的 Checkpoint", { status: 409 });
      const materializations = await this.#readMaterializations(locator);
      const desired = this.#desiredSnapshotsForDomain(state, target, materializations);
      const pathKeys = desired.map((entry) => this.#pathLockKey(state, entry.path));
      return this.#withLocks(pathKeys, async () => {
        const alreadyMaterialized = desired.every((operation) => {
          const indexed = materializations.paths[operation.path] || null;
          const domainHead = indexed?.domains?.[state.versionDomainId] || null;
          return domainHead
            && snapshotsEqual(domainHead.snapshot, operation.desired)
            && snapshotsEqual(indexed.current?.snapshot, operation.desired);
        });
        // Continuing the same web conversation, or a freshly seeded fork at
        // the same logical file state, is a metadata-only operation.  A fork
        // owns an independent domain HEAD even while the shared physical
        // materialization still names its parent domain.  Requiring ownership
        // equality here would rescan overlapping historical directory/file
        // snapshots and can misclassify a newer descendant snapshot as an
        // out-of-ledger edit.  Both the target domain HEAD and the shared
        // physical index must still match the requested snapshot exactly.
        // Native pre-tool hooks capture the real preimage if the Agent later
        // mutates a path.
        if (alreadyMaterialized) {
          return {
            applied: true,
            conflict: null,
            checkpoint: clone(target),
            activationId,
            paths: 0,
            reusedMaterialization: true,
          };
        }
        const assessment = await this.#assessPhysicalOperations(state, desired, materializations, {
          code: "VERSION_ACTIVATION_PATH_CONFLICT",
          message: "工作文件含有账本外修改，无法切换到当前对话版本",
        });
        if (assessment.conflict) return { applied: false, conflict: assessment.conflict, checkpoint: clone(target), activationId };
        const applied = [];
        try {
          for (const operation of assessment.operations) {
            if (!snapshotsEqual(operation.actual, operation.desired)) {
              await this.remoteFs.restoreSnapshot({ path: operation.path, snapshot: operation.desired, objectsRoot: state.storage.objectsRoot });
              applied.push(operation);
            }
          }
          await this.#writeMaterializations(locator, materializations, assessment.operations, state.versionDomainId, target.id);
        } catch (error) {
          for (const operation of [...applied].reverse()) {
            try { await this.remoteFs.restoreSnapshot({ path: operation.path, snapshot: operation.actual, objectsRoot: state.storage.objectsRoot }); } catch { /* a later activation will reconcile the durable index */ }
          }
          throw error;
        }
        return { applied: true, conflict: null, checkpoint: clone(target), activationId, paths: assessment.operations.length };
      });
    });
  }

  async forkDomain(sourceInput, forkInput) {
    const sourceLocator = normalizeLocator(sourceInput);
    const source = await this.getDomain(sourceLocator);
    const sourceCheckpoint = checkpointById(source, forkInput?.sourceCheckpointId, "sourceCheckpointId");
    invariant(sourceCheckpoint.status === "retained", "VERSION_FORK_SOURCE_REWOUND", "不能从已回退的 Checkpoint 建立版本账本", { status: 409 });
    const targetConversationId = assertVersionId(forkInput?.targetConversationId, "targetConversationId");
    const targetWorkspaceId = assertVersionId(forkInput?.targetWorkspaceId, "targetWorkspaceId");
    const targetBranchId = assertVersionId(forkInput?.targetBranchId, "targetBranchId");
    const targetMode = String(forkInput?.targetMode || "real");
    invariant(WORKSPACE_MODES.includes(targetMode), "VERSION_WORKSPACE_MODE_INVALID", "目标工作区模式无效", { status: 400 });
    const targetWorkspace = source.workspaces.find((entry) => entry.id === targetWorkspaceId) || source.workspaces.at(-1);
    invariant(targetWorkspace, "VERSION_FORK_WORKSPACE_MISSING", "分支起点没有工作区元数据", { status: 409 });
    const domainId = deriveVersionDomainId({ actorId: source.actorId, serverIdentity: source.serverIdentity, conversationId: targetConversationId });
    const locator = { actorId: source.actorId, serverIdentity: source.serverIdentity, versionDomainId: domainId };
    const layout = storageLayout({ baseRoot: this.baseRoot, ...locator });
    const result = await this.#withLock(`registry:${source.actorId}:${source.serverIdentity}`, async () => {
      const registry = await this.#readRegistry(source, layout.registryFile);
      if (registry.ledgers.some((entry) => entry.versionDomainId === domainId)) {
        const existing = await this.getDomain(locator);
        invariant(existing.conversationId === targetConversationId && existing.forkedFrom?.versionDomainId === source.versionDomainId && existing.forkedFrom?.checkpointId === sourceCheckpoint.id, "VERSION_FORK_TARGET_COLLISION", "目标对话已经存在不同的版本历史", { status: 409 });
        return { created: false, reused: true, state: existing, risk: null };
      }
      const imported = lineageTo(source, sourceCheckpoint).map(clone);
      const now = isoTime(this.clock);
      await this.remoteFs.mkdir(layout.objectsRoot);
      const workspaces = source.workspaces.map((entry) => ({ ...clone(entry), lastSeenAt: now }));
      if (!workspaces.some((entry) => entry.id === targetWorkspaceId)) {
        workspaces.push({ ...clone(targetWorkspace), id: targetWorkspaceId, mode: targetMode, createdAt: now, lastSeenAt: now });
      }
      const state = {
        schemaVersion: SCHEMA_VERSION,
        revision: 0,
        actorId: source.actorId,
        serverIdentity: source.serverIdentity,
        conversationId: targetConversationId,
        versionDomainId: domainId,
        storage: { root: layout.root, stateFile: layout.stateFile, objectsRoot: layout.objectsRoot },
        workspaces,
        sequence: imported.reduce((maximum, entry) => Math.max(maximum, entry.sequence), 0),
        checkpoints: imported,
        branches: { [targetBranchId]: { id: targetBranchId, conversationId: targetConversationId, fromCheckpointId: sourceCheckpoint.id, headCheckpointId: sourceCheckpoint.id, createdAt: now } },
        pending: {},
        rewinds: [],
        switches: [],
        forkedFrom: { versionDomainId: source.versionDomainId, conversationId: source.conversationId, checkpointId: sourceCheckpoint.id },
        createdAt: now,
        updatedAt: now,
      };
      await this.remoteFs.writeJsonAtomic(layout.stateFile, state, { expectedRevision: null });
      const next = { ...registry, revision: registry.revision + 1, ledgers: [...registry.ledgers, { versionDomainId: domainId, conversationId: targetConversationId, createdAt: now }] };
      await this.remoteFs.writeJsonAtomic(layout.registryFile, next, { expectedRevision: registry.revision === 0 && !registry.ledgers.length ? null : registry.revision });
      this.#domainCache.set(this.#domainCacheKey(locator), clone(state));
      this.#missingDomains.delete(this.#domainCacheKey(locator));
      this.#registryCache.set(this.#registryCacheKey(source), clone(next));
      return { created: true, reused: false, state: clone(state), risk: null };
    });
    if (result.created) {
      await this.#seedForkDomainHeads(sourceLocator, source, sourceCheckpoint, result.state);
      const sourceLineage = this.#lineageCache.get(this.#domainCacheKey(sourceLocator));
      if (sourceLineage) this.#rememberRelatedDomainIds(sourceLocator, [...sourceLineage, result.state.versionDomainId]);
    }
    return result;
  }

  async switchToCheckpoint(input, switchInput) {
    const batch = await this.switchBatch([{ locator: input, ...switchInput }]);
    return batch.results[0];
  }

  async switchBatch(requestsInput) {
    invariant(Array.isArray(requestsInput) && requestsInput.length > 0, "VERSION_SWITCH_BATCH_INVALID", "批量版本切换至少需要一个账本", { status: 400 });
    const requests = requestsInput.map((entry, index) => ({
      locator: normalizeLocator(entry?.locator),
      targetCheckpointId: assertVersionId(entry?.targetCheckpointId, `requests[${index}].targetCheckpointId`),
      switchId: assertVersionId(entry?.switchId, `requests[${index}].switchId`),
      preserveDomainHead: entry?.preserveDomainHead === true,
    }));
    invariant(new Set(requests.map((entry) => entry.locator.versionDomainId)).size === requests.length, "VERSION_SWITCH_BATCH_DUPLICATE_DOMAIN", "批量版本切换不能重复包含同一账本", { status: 400 });
    const ledgerLocks = requests.map((entry) => this.#ledgerLockKey(entry.locator));
    const materializationLocks = requests.map((entry) => this.#materializationLockKey(entry.locator));
    return this.#withLocks([...ledgerLocks, ...materializationLocks], async () => {
      const states = await Promise.all(requests.map((entry) => this.getDomain(entry.locator)));
      const plans = [];
      for (let index = 0; index < requests.length; index += 1) plans.push(await this.#planSwitch(requests[index], states[index]));
      const pathLocks = plans.flatMap((plan, index) => plan.desired.map((operation) => this.#pathLockKey(states[index], operation.path)));
      return this.#withLocks(pathLocks, async () => {
        const assessments = [];
        for (let index = 0; index < requests.length; index += 1) {
          const plan = plans[index];
          if (plan.duplicate) {
            assessments.push({ duplicate: true, target: plan.target, operations: [], conflict: null });
            continue;
          }
          const assessment = await this.#assessPhysicalOperations(states[index], plan.desired, plan.materializations, {
            code: "VERSION_SWITCH_PATH_CONFLICT",
            message: "待切换文件含有账本外修改，版本切换已停止",
          });
          assessments.push({ duplicate: false, target: plan.target, operations: assessment.operations, conflict: assessment.conflict });
        }
        const conflicts = assessments.map((entry, index) => entry.conflict ? { versionDomainId: states[index].versionDomainId, ...entry.conflict } : null).filter(Boolean);
        if (conflicts.length) {
          const conflict = conflicts.length === 1 ? conflicts[0] : { code: "VERSION_SWITCH_BATCH_CONFLICT", message: "至少一个路径无法安全切换，所有文件均保持不变", paths: conflicts };
          return { applied: false, conflict, results: assessments.map((assessment, index) => ({ applied: false, conflict: assessment.conflict || conflict, duplicate: assessment.duplicate, targetCheckpoint: clone(assessment.target), state: clone(states[index]) })) };
        }
        return this.#withDurableUndo(requests, states, assessments.map((entry) => entry.operations), async () => {
        const applied = [];
        try {
          for (let index = 0; index < assessments.length; index += 1) {
            for (const operation of assessments[index].operations) {
              if (!snapshotsEqual(operation.actual, operation.desired)) {
                await this.remoteFs.restoreSnapshot({ path: operation.path, snapshot: operation.desired, objectsRoot: states[index].storage.objectsRoot });
                applied.push({ state: states[index], operation });
              }
            }
          }
        } catch (error) {
          for (const record of [...applied].reverse()) {
            try { await this.remoteFs.restoreSnapshot({ path: record.operation.path, snapshot: record.operation.actual, objectsRoot: record.state.storage.objectsRoot }); } catch { /* recovery retries the recorded operation */ }
          }
          throw error;
        }
        const results = [];
        for (let index = 0; index < requests.length; index += 1) {
          const assessment = assessments[index];
          const state = states[index];
          if (!assessment.duplicate) {
            state.switches.push({ id: requests[index].switchId, targetCheckpointId: assessment.target.id, preserveDomainHead: requests[index].preserveDomainHead, operations: assessment.operations.map((entry) => ({ path: entry.path, workspaceId: entry.workspaceId })), createdAt: isoTime(this.clock) });
            try {
              await this.#writeState(requests[index].locator, state);
              const materializations = await this.#readMaterializations(requests[index].locator);
              await this.#writeMaterializations(requests[index].locator, materializations, assessment.operations, state.versionDomainId, assessment.target.id);
            } catch (error) {
              for (const operation of [...assessment.operations].reverse()) {
                try { await this.remoteFs.restoreSnapshot({ path: operation.path, snapshot: operation.actual, objectsRoot: state.storage.objectsRoot }); } catch { /* a later activation will reconcile the durable index */ }
              }
              throw error;
            }
          }
          results.push({ applied: true, conflict: null, duplicate: assessment.duplicate, targetCheckpoint: clone(assessment.target), state: clone(state) });
        }
        return { applied: true, conflict: null, results };
        });
      });
    });
  }

  async #planSwitch(request, state) {
    const existing = state.switches.find((entry) => entry.id === request.switchId) || null;
    const target = checkpointById(state, request.targetCheckpointId, "targetCheckpointId");
    if (existing) {
      invariant(existing.targetCheckpointId === target.id, "VERSION_SWITCH_ID_REUSED", "Switch ID 已用于其他目标", { status: 409 });
      return { duplicate: true, target, desired: [], materializations: null };
    }
    invariant(target.status === "retained", "VERSION_SWITCH_TARGET_INVALID", "目标 Checkpoint 已失效", { status: 409 });
    const materializations = await this.#readMaterializations(request.locator);
    const desired = this.#desiredSnapshotsForDomain(state, target, materializations).filter((operation) => {
      const indexed = materializations.paths[operation.path]?.current;
      return indexed?.versionDomainId !== state.versionDomainId
        || !snapshotsEqual(indexed.snapshot, operation.desired);
    });
    return { duplicate: false, target, desired, materializations };
  }

  async rewind(input, rewindInput) {
    const batch = await this.rewindBatch([{ locator: input, ...rewindInput }]);
    return batch.results[0];
  }

  async rewindBatch(requestsInput, options = {}) {
    invariant(Array.isArray(requestsInput) && requestsInput.length > 0, "VERSION_REWIND_BATCH_INVALID", "批量回溯至少需要一个账本", { status: 400 });
    const requests = requestsInput.map((entry, index) => ({
      locator: normalizeLocator(entry?.locator),
      branchId: assertVersionId(entry?.branchId, `requests[${index}].branchId`),
      targetCheckpointId: assertVersionId(entry?.targetCheckpointId, `requests[${index}].targetCheckpointId`),
      rewindId: assertVersionId(entry?.rewindId, `requests[${index}].rewindId`),
    }));
    invariant(new Set(requests.map((entry) => entry.locator.versionDomainId)).size === requests.length, "VERSION_REWIND_BATCH_DUPLICATE_DOMAIN", "批量回溯不能重复包含同一账本", { status: 400 });
    const ledgerLocks = requests.map((entry) => this.#ledgerLockKey(entry.locator));
    const materializationLocks = requests.map((entry) => this.#materializationLockKey(entry.locator));
    return this.#withLocks([...ledgerLocks, ...materializationLocks], async () => {
      const states = await Promise.all(requests.map((entry) => this.getDomain(entry.locator)));
      const plans = requests.map((entry, index) => this.#planRewind(entry, states[index]));
      const previewConflicts = plans.map((entry, index) => entry.conflict ? { versionDomainId: states[index].versionDomainId, ...entry.conflict } : null).filter(Boolean);
      if (previewConflicts.length) {
        const conflict = previewConflicts.length === 1 ? previewConflicts[0] : { code: "VERSION_REWIND_BATCH_CONFLICT", message: "至少一个路径无法安全回溯，所有文件均保持不变", paths: previewConflicts };
        return { applied: false, conflict, results: plans.map((plan, index) => ({ applied: false, conflict: plan.conflict || conflict, plan: plan.plan, state: clone(states[index]) })) };
      }
      const pathLocks = plans.flatMap((plan, index) => plan.plan.operations.map((operation) => this.#pathLockKey(states[index], operation.path)));
      return this.#withLocks(pathLocks, async () => {
        const assessments = [];
        for (let index = 0; index < requests.length; index += 1) {
          const plan = plans[index];
          if (plan.duplicate) {
            assessments.push(plan);
            continue;
          }
          const materializations = await this.#readMaterializations(requests[index].locator);
          const assessment = await this.#assessPhysicalOperations(states[index], plan.plan.operations, materializations, {
            code: "VERSION_REWIND_PATH_CONFLICT",
            message: "待回溯文件含有账本外修改，回溯已停止",
          });
          assessments.push({
            ...plan,
            plan: { ...plan.plan, operations: assessment.operations },
            conflict: assessment.conflict,
          });
        }
        const conflicts = assessments.map((entry, index) => entry.conflict ? { versionDomainId: states[index].versionDomainId, ...entry.conflict } : null).filter(Boolean);
        if (conflicts.length) {
          const conflict = conflicts.length === 1 ? conflicts[0] : { code: "VERSION_REWIND_BATCH_CONFLICT", message: "至少一个路径无法安全回溯，所有文件均保持不变", paths: conflicts };
          return { applied: false, conflict, results: assessments.map((assessment, index) => ({ applied: false, conflict: assessment.conflict || conflict, plan: assessment.plan, state: clone(states[index]) })) };
        }
        if (options?.dryRun === true) {
          return {
            applied: true,
            preview: true,
            conflict: null,
            results: assessments.map((assessment, index) => ({
              applied: true,
              preview: true,
              conflict: null,
              duplicate: assessment.duplicate,
              plan: assessment.plan,
              state: clone(states[index]),
            })),
          };
        }
        return this.#withDurableUndo(requests, states, assessments.map((entry) => entry.plan.operations), async () => {
        const applied = [];
        try {
          for (let index = 0; index < assessments.length; index += 1) {
            if (assessments[index].duplicate) continue;
            for (const operation of assessments[index].plan.operations) {
              if (!snapshotsEqual(operation.actual, operation.desired)) {
                await this.remoteFs.restoreSnapshot({ path: operation.path, snapshot: operation.desired, objectsRoot: states[index].storage.objectsRoot });
                applied.push({ state: states[index], operation });
              }
            }
          }
        } catch (error) {
          for (const record of [...applied].reverse()) {
            try { await this.remoteFs.restoreSnapshot({ path: record.operation.path, snapshot: record.operation.actual, objectsRoot: record.state.storage.objectsRoot }); } catch { /* recovery retries the recorded operation */ }
          }
          throw error;
        }
        const results = [];
        for (let index = 0; index < assessments.length; index += 1) {
          const assessment = assessments[index];
          const state = states[index];
          if (assessment.duplicate) {
            results.push({ applied: true, conflict: null, duplicate: true, plan: assessment.plan, rewind: clone(assessment.existing), state: clone(state) });
            continue;
          }
          const now = isoTime(this.clock);
          for (const checkpoint of assessment.candidates) { checkpoint.status = "rewound"; checkpoint.rewoundAt = now; }
          assessment.branch.headCheckpointId = assessment.target.id;
          const rewind = { id: requests[index].rewindId, logicalBranchId: requests[index].branchId, targetCheckpointId: assessment.target.id, removedCheckpointIds: assessment.candidates.map((entry) => entry.id), operations: assessment.plan.operations.map((entry) => ({ path: entry.path, workspaceId: entry.workspaceId })), createdAt: now };
          state.rewinds.push(rewind);
          try {
            await this.#writeState(requests[index].locator, state);
            const materializations = await this.#readMaterializations(requests[index].locator);
            await this.#writeMaterializations(requests[index].locator, materializations, assessment.plan.operations, state.versionDomainId, assessment.target.id);
          } catch (error) {
            for (const operation of [...assessment.plan.operations].reverse()) {
              try { await this.remoteFs.restoreSnapshot({ path: operation.path, snapshot: operation.actual, objectsRoot: state.storage.objectsRoot }); } catch { /* a later activation will reconcile the durable index */ }
            }
            throw error;
          }
          results.push({ applied: true, conflict: null, duplicate: false, plan: assessment.plan, rewind: clone(rewind), state: clone(state) });
        }
        return { applied: true, conflict: null, results };
        });
      });
    });
  }

  #planRewind(request, state) {
    const existing = state.rewinds.find((entry) => entry.id === request.rewindId) || null;
    const branch = state.branches[request.branchId];
    invariant(branch, "VERSION_BRANCH_NOT_FOUND", "逻辑分支不存在", { status: 404 });
    const target = checkpointById(state, request.targetCheckpointId, "targetCheckpointId");
    if (existing) return { duplicate: true, existing, branch, target, candidates: [], plan: { removedCheckpointIds: [], operations: [] }, conflict: null };
    const lineage = retainedBranchLineage(state, branch);
    const targetIndex = lineage.findIndex((entry) => entry.id === target.id);
    invariant(targetIndex >= 0, "VERSION_REWIND_TARGET_INVALID", "目标 Checkpoint 不在当前分支的继承链中或已失效", { status: 409 });
    const { candidates, operations } = changedPathsAfter(lineage, targetIndex);
    const candidateIds = new Set(candidates.map((entry) => entry.id));
    const dependentBranches = Object.values(state.branches).filter((entry) => entry.id !== request.branchId && candidateIds.has(entry.fromCheckpointId));
    if (dependentBranches.length) return { duplicate: false, branch, target, candidates, plan: { removedCheckpointIds: candidates.map((entry) => entry.id), operations }, conflict: { code: "VERSION_REWIND_DEPENDENT_BRANCH", message: "待撤销 Checkpoint 已被保留分支引用", branchIds: dependentBranches.map((entry) => entry.id) } };
    return {
      duplicate: false,
      branch,
      target,
      candidates,
      plan: { removedCheckpointIds: candidates.map((entry) => entry.id), operations },
      conflict: null,
    };
  }

  async #registerWorkspace(locator, scope) {
    return this.#mutateState(locator, async (state) => {
      invariant(state.conversationId === scope.conversationId, "VERSION_DOMAIN_SCOPE_COLLISION", "版本账本已被其他网页对话占用", { status: 409 });
      const now = isoTime(this.clock);
      const exact = state.workspaces.find((entry) => entry.id === scope.workspaceId) || null;
      if (exact) {
        invariant(exact.rootPath === scope.rootPath && exact.mode === scope.mode, "VERSION_WORKSPACE_ID_COLLISION", "工作区 ID 已指向其他路径", { status: 409 });
        return { state, result: clone(state), unchanged: true };
      } else {
        state.workspaces.push(workspaceRecord(scope, now));
        state.workspaces.sort((left, right) => left.id.localeCompare(right.id));
      }
      return { state, result: clone(state) };
    });
  }

  async #readMaterializations(locatorInput) {
    const locator = normalizeLocator(locatorInput);
    const cacheKey = this.#materializationCacheKey(locator);
    const cached = this.#materializationCache.get(cacheKey);
    if (cached) return clone(cached);
    const layout = storageLayout({ baseRoot: this.baseRoot, ...locator });
    const materializations = validateMaterializations(await this.remoteFs.readJson(layout.materializationsFile), locator);
    this.#materializationCache.set(cacheKey, clone(materializations));
    return clone(materializations);
  }

  async #writeMaterializations(locatorInput, currentInput, operations, versionDomainId, checkpointId, seeds = []) {
    const locator = normalizeLocator(locatorInput);
    const current = validateMaterializations(currentInput, locator);
    const now = isoTime(this.clock);
    const paths = clone(current.paths);
    let changed = false;
    for (const operation of operations) {
      const absolutePath = assertVersionedAbsolutePath(operation.path);
      const domainId = assertVersionId(versionDomainId, "versionDomainId");
      const head = {
        checkpointId: assertVersionId(checkpointId, "checkpointId"),
        snapshot: validateSnapshot(operation.desired, `materialization(${absolutePath})`),
        updatedAt: now,
      };
      const domains = clone(paths[absolutePath]?.domains || {});
      domains[domainId] = clone(head);
      paths[absolutePath] = {
        current: { versionDomainId: domainId, snapshot: clone(head.snapshot), updatedAt: now },
        domains,
      };
      changed = true;
    }
    for (const seed of seeds) {
      const absolutePath = assertVersionedAbsolutePath(seed.path);
      const seedDomainId = assertVersionId(seed.versionDomainId, "seed.versionDomainId");
      const entry = paths[absolutePath] || null;
      if (entry?.domains?.[seedDomainId]) continue;
      invariant(entry?.current, "VERSION_MATERIALIZATION_SEED_WITHOUT_CURRENT", "不能为尚未物化的路径单独建立对话 HEAD", { status: 500, expose: false });
      const domains = clone(entry.domains);
      domains[seedDomainId] = {
        checkpointId: seed.checkpointId === null ? null : assertVersionId(seed.checkpointId, "seed.checkpointId"),
        snapshot: validateSnapshot(seed.snapshot, `seed(${absolutePath}).snapshot`),
        updatedAt: now,
      };
      paths[absolutePath] = { current: clone(entry.current), domains };
      changed = true;
    }
    if (!changed) return current;
    const next = { ...current, revision: current.revision + 1, paths, updatedAt: now };
    const layout = storageLayout({ baseRoot: this.baseRoot, ...locator });
    await this.remoteFs.writeJsonAtomic(layout.materializationsFile, next, {
      expectedRevision: current.revision === 0 && !Object.keys(current.paths).length ? null : current.revision,
    });
    this.#materializationCache.set(this.#materializationCacheKey(locator), clone(next));
    return clone(next);
  }

  async #assessPhysicalOperations(state, operationsInput, materializations, conflictDescriptor) {
    const operations = [];
    const conflicts = [];
    for (const operation of operationsInput) {
      const actual = validateSnapshot(await this.remoteFs.fingerprintPath({ path: operation.path }), `fingerprint(${operation.path})`);
      const indexed = materializations.paths[operation.path]?.current?.snapshot || null;
      const fallback = operation.expected ? validateSnapshot(operation.expected, `expected(${operation.path})`) : null;
      const expected = indexed || fallback;
      if (!snapshotsEqual(actual, operation.desired) && (!expected || !snapshotsEqual(actual, expected))) {
        conflicts.push({ path: operation.path, expected, desired: operation.desired, actual });
      }
      operations.push({ ...operation, actual, materializedExpected: expected });
    }
    return {
      operations,
      conflict: conflicts.length ? { ...conflictDescriptor, paths: conflicts } : null,
    };
  }

  async #markCheckpointMaterialized(locatorInput, checkpointInput) {
    const locator = normalizeLocator(locatorInput);
    const checkpoint = clone(checkpointInput);
    const changes = normalizeChanges(checkpoint?.changes || []);
    if (!changes.length) return;
    const state = await this.getDomain(locator);
    const desired = changes.map((change) => ({ path: change.path, workspaceId: change.workspaceId, desired: change.after }));
    const keys = [this.#materializationLockKey(locator), ...desired.map((entry) => this.#pathLockKey(state, entry.path))];
    await this.#withLocks(keys, async () => {
      const materializations = await this.#readMaterializations(locator);
      const newPaths = changes.filter((change) => !materializations.paths[change.path]?.domains?.[state.versionDomainId]);
      const seeds = [];
      if (newPaths.length) {
        const relatedDomainIds = await this.#relatedDomainIds(locator, state);
        for (const change of newPaths) {
          for (const versionDomainId of relatedDomainIds) {
            if (versionDomainId === state.versionDomainId) continue;
            seeds.push({
              path: change.path,
              versionDomainId,
              checkpointId: null,
              snapshot: change.before,
            });
          }
        }
      }
      await this.#writeMaterializations(locator, materializations, desired, state.versionDomainId, checkpoint.id, seeds);
    });
  }

  #desiredSnapshotsForDomain(state, target, materializations) {
    const desired = new Map(desiredSnapshotsAt(state, target).map((entry) => [entry.path, entry]));
    for (const [absolutePath, entry] of Object.entries(materializations.paths)) {
      const head = entry.domains[state.versionDomainId] || null;
      if (!head || desired.has(absolutePath)) continue;
      if ([...desired.keys()].some((ancestor) => ancestor !== absolutePath && isSameOrDescendantPath(absolutePath, ancestor))) continue;
      desired.set(absolutePath, {
        path: absolutePath,
        workspaceId: null,
        desired: clone(head.snapshot),
      });
    }
    return [...desired.values()].sort((left, right) => left.path.localeCompare(right.path));
  }

  async #relatedDomainIds(locator, state) {
    const cached = this.#lineageCache.get(this.#domainCacheKey(locator));
    if (cached) return [...cached];
    const related = await this.#relatedDomainStates(locator, state);
    return related.map((entry) => entry.versionDomainId);
  }

  #rememberRelatedDomainIds(locator, ids) {
    const values = new Set(ids.map((entry) => assertVersionId(entry, "versionDomainId")));
    for (const versionDomainId of values) {
      this.#lineageCache.set(this.#domainCacheKey({ ...locator, versionDomainId }), new Set(values));
    }
  }

  async #relatedDomainStates(locator, currentState) {
    const layout = storageLayout({ baseRoot: this.baseRoot, ...locator });
    const registry = await this.#readRegistry(currentState, layout.registryFile);
    const states = await Promise.all(registry.ledgers.map((entry) => (
      entry.versionDomainId === currentState.versionDomainId
        ? Promise.resolve(currentState)
        : this.getDomain({ ...locator, versionDomainId: entry.versionDomainId })
    )));
    const neighbors = new Map(states.map((entry) => [entry.versionDomainId, new Set()]));
    for (const entry of states) {
      const parent = entry.forkedFrom?.versionDomainId || null;
      if (!parent || !neighbors.has(parent)) continue;
      neighbors.get(entry.versionDomainId).add(parent);
      neighbors.get(parent).add(entry.versionDomainId);
    }
    const relatedIds = new Set([currentState.versionDomainId]);
    const pending = [currentState.versionDomainId];
    while (pending.length) {
      const selected = pending.shift();
      for (const candidate of neighbors.get(selected) || []) {
        if (relatedIds.has(candidate)) continue;
        relatedIds.add(candidate);
        pending.push(candidate);
      }
    }
    this.#rememberRelatedDomainIds(locator, [...relatedIds]);
    return states.filter((entry) => relatedIds.has(entry.versionDomainId));
  }

  async #seedForkDomainHeads(sourceLocator, sourceState, sourceCheckpoint, targetState) {
    const key = this.#materializationLockKey(sourceLocator);
    await this.#withLock(key, async () => {
      const materializations = await this.#readMaterializations(sourceLocator);
      const desired = new Map(desiredSnapshotsAt(sourceState, sourceCheckpoint).map((entry) => [entry.path, entry.desired]));
      for (const [absolutePath, entry] of Object.entries(materializations.paths)) {
        const sourceHead = entry.domains[sourceState.versionDomainId] || null;
        if (sourceHead && !desired.has(absolutePath)) desired.set(absolutePath, sourceHead.snapshot);
      }
      const seeds = [];
      for (const [absolutePath, snapshot] of desired) {
        const entry = materializations.paths[absolutePath] || null;
        if (!entry?.current || entry.domains[targetState.versionDomainId]) continue;
        seeds.push({
          path: absolutePath,
          versionDomainId: targetState.versionDomainId,
          checkpointId: sourceCheckpoint.id,
          snapshot,
        });
      }
      await this.#writeMaterializations(
        sourceLocator,
        materializations,
        [],
        targetState.versionDomainId,
        sourceCheckpoint.id,
        seeds,
      );
    });
  }

  async #readRegistry(scope, registryFile) {
    const key = this.#registryCacheKey(scope);
    const cached = this.#registryCache.get(key);
    if (cached) return clone(cached);
    const registry = validateRegistry(await this.remoteFs.readJson(registryFile), { actorId: scope.actorId, serverIdentity: scope.serverIdentity });
    this.#registryCache.set(key, clone(registry));
    return clone(registry);
  }

  async #mutateState(locatorInput, mutation) {
    const locator = normalizeLocator(locatorInput);
    return this.#withLock(`ledger:${locator.actorId}:${locator.serverIdentity}:${locator.versionDomainId}`, async () => {
      const current = await this.getDomain(locator);
      const originalRevision = current.revision;
      const outcome = await mutation(current);
      if (outcome?.unchanged) return clone(outcome?.result ?? current);
      current.revision = originalRevision + 1;
      current.updatedAt = isoTime(this.clock);
      const layout = storageLayout({ baseRoot: this.baseRoot, ...locator });
      await this.remoteFs.writeJsonAtomic(layout.stateFile, current, { expectedRevision: originalRevision });
      this.#domainCache.set(this.#domainCacheKey(locator), clone(current));
      this.#missingDomains.delete(this.#domainCacheKey(locator));
      return clone(outcome?.result ?? current);
    });
  }

  async #writeState(locatorInput, state) {
    const locator = normalizeLocator(locatorInput);
    const originalRevision = state.revision;
    state.revision += 1;
    state.updatedAt = isoTime(this.clock);
    const layout = storageLayout({ baseRoot: this.baseRoot, ...locator });
    await this.remoteFs.writeJsonAtomic(layout.stateFile, state, { expectedRevision: originalRevision });
    this.#domainCache.set(this.#domainCacheKey(locator), clone(state));
    this.#missingDomains.delete(this.#domainCacheKey(locator));
  }

  #domainCacheKey(locatorInput) {
    const locator = normalizeLocator(locatorInput);
    return `${locator.actorId}\0${locator.serverIdentity}\0${locator.versionDomainId}`;
  }

  #registryCacheKey(scope) {
    return `${assertVersionId(scope?.actorId, "actorId")}\0${assertServerIdentity(scope?.serverIdentity)}`;
  }

  #materializationCacheKey(locatorInput) {
    const locator = normalizeLocator(locatorInput);
    return `${locator.actorId}\0${locator.serverIdentity}`;
  }

  #ledgerLockKey(locatorInput) {
    const locator = normalizeLocator(locatorInput);
    return `ledger:${locator.actorId}:${locator.serverIdentity}:${locator.versionDomainId}`;
  }

  #materializationLockKey(locatorInput) {
    const locator = normalizeLocator(locatorInput);
    return `materialization:${locator.actorId}:${locator.serverIdentity}`;
  }

  #pathLockKey(state, absolutePath) {
    return `path:${state.actorId}:${state.serverIdentity}:${crypto.createHash("sha256").update(absolutePath).digest("hex")}`;
  }

  #withLocks(keys, operation) {
    const ordered = [...new Set(keys)].sort();
    const enter = (index) => index >= ordered.length ? operation() : this.#withLock(ordered[index], () => enter(index + 1));
    return enter(0);
  }

  async #withLock(key, operation) {
    const scope = /^(?:ledger|materialization|registry|path):(.+):(ssh_[A-Za-z0-9_-]{43})(?::.*)?$/.exec(key);
    return scope ? this.#withScope({ actorId: scope[1], serverIdentity: scope[2] }, () => this.#withLocalLock(key, operation)) : this.#withLocalLock(key, operation);
  }

  async #withScope(scope, operation, mutating = true) {
    if (inVersionScope(scope)) return operation();
    return withVersionScope(scope, async () => {
      const key = versionScopeKey(scope);
      if (this.#scopeEpochs.get(key) !== versionScopeEpoch(scope) || this.#pendingRecovery.has(key)) {
        this.invalidateRemoteState();
        await this.#recoverUndo(scope);
      }
      try { return await operation(); }
      finally { this.#scopeEpochs.set(key, mutating ? bumpVersionScopeEpoch(scope) : versionScopeEpoch(scope)); }
    });
  }

  #undoPath(scope) { return `${this.baseRoot}/${scope.actorId}/${scope.serverIdentity}/mutation-undo.json`; }

  async #withDurableUndo(requests, states, operations, operation) {
    const scope = requests[0].locator;
    invariant(requests.every((request) => request.locator.actorId === scope.actorId && request.locator.serverIdentity === scope.serverIdentity), "VERSION_BATCH_SCOPE_MISMATCH", "原子版本操作必须属于同一用户和服务器", { status: 400 });
    if (!operations.some((items) => items?.length)) return operation();
    for (let index = 0; index < operations.length; index += 1) {
      const captured = await this.remoteFs.capturePaths({ paths: operations[index].map((item) => item.path), objectsRoot: states[index].storage.objectsRoot });
      for (let offset = 0; offset < captured.length; offset += 1) invariant(captured[offset].path === operations[index][offset].path && snapshotsEqual(captured[offset].snapshot, operations[index][offset].actual), "VERSION_PATH_CHANGED_DURING_ADMISSION", "版本切换准备期间文件发生变化", { status: 409 });
    }
    const file = this.#undoPath(scope);
    const previous = await this.remoteFs.readJson(file);
    invariant(!previous?.pending, "VERSION_RECOVERY_REQUIRED", "上次版本操作尚未恢复", { status: 409 });
    const layout = storageLayout({ baseRoot: this.baseRoot, ...scope });
    const materializations = await this.remoteFs.readJson(layout.materializationsFile);
    const journal = { schemaVersion: 1, revision: (previous?.revision ?? -1) + 1, pending: { requests: clone(requests), states: clone(states), operations: clone(operations), materializations } };
    await this.remoteFs.writeJsonAtomic(file, journal, { expectedRevision: previous?.revision ?? null });
    try {
      const result = await operation();
      await this.remoteFs.writeJsonAtomic(file, { ...journal, revision: journal.revision + 1, pending: null }, { expectedRevision: journal.revision });
      return result;
    } catch (error) {
      // Recovery includes every domain in the batch, including domains whose
      // receipt was already durable when a later index write failed.
      this.#scopeEpochs.delete(versionScopeKey(scope));
      try { await this.#recoverUndo(scope); }
      catch (recoveryError) { this.#pendingRecovery.add(versionScopeKey(scope)); error.recoveryError = recoveryError; }
      throw error;
    }
  }

  async #recoverUndo(scope) {
    const file = this.#undoPath(scope);
    const journal = await this.remoteFs.readJson(file);
    if (!journal?.pending) return;
    invariant(journal.schemaVersion === 1 && Number.isSafeInteger(journal.revision), "VERSION_RECOVERY_INVALID", "版本恢复日志无效", { status: 500 });
    const pending = journal.pending;
    for (let index = pending.states.length - 1; index >= 0; index -= 1) {
      const locator = normalizeLocator(pending.requests[index].locator);
      invariant(locator.actorId === scope.actorId && locator.serverIdentity === scope.serverIdentity, "VERSION_RECOVERY_SCOPE_INVALID", "版本恢复日志越界", { status: 500 });
      const state = validateDomainState(pending.states[index], locator);
      for (const operation of [...pending.operations[index]].reverse()) {
        const actual = await this.remoteFs.fingerprintPath({ path: assertVersionedAbsolutePath(operation.path) });
        invariant(snapshotsEqual(actual, operation.actual) || snapshotsEqual(actual, operation.desired), "VERSION_RECOVERY_PATH_CONFLICT", "恢复期间发现额外文件修改，已保留恢复日志", { status: 409 });
        if (!snapshotsEqual(actual, operation.actual)) await this.remoteFs.restoreSnapshot({ path: operation.path, snapshot: operation.actual, objectsRoot: state.storage.objectsRoot });
      }
      const layout = storageLayout({ baseRoot: this.baseRoot, ...locator });
      const current = await this.remoteFs.readJson(layout.stateFile);
      await this.remoteFs.writeJsonAtomic(layout.stateFile, { ...state, revision: (current?.revision ?? state.revision) + 1, updatedAt: isoTime(this.clock) }, { expectedRevision: current?.revision ?? null });
    }
    const locator = pending.requests[0].locator;
    const layout = storageLayout({ baseRoot: this.baseRoot, ...locator });
    const current = await this.remoteFs.readJson(layout.materializationsFile);
    const before = validateMaterializations(pending.materializations, locator);
    if (current || pending.materializations) await this.remoteFs.writeJsonAtomic(layout.materializationsFile, { ...before, revision: (current?.revision ?? 0) + 1, updatedAt: isoTime(this.clock) }, { expectedRevision: current?.revision ?? null });
    await this.remoteFs.writeJsonAtomic(file, { ...journal, revision: journal.revision + 1, pending: null }, { expectedRevision: journal.revision });
    this.invalidateRemoteState();
    this.#pendingRecovery.delete(versionScopeKey(scope));
  }

  async #withLocalLock(key, operation) {
    const previous = this.#locks.get(key) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.#locks.set(key, queued);
    await previous;
    try { return await operation(); }
    finally {
      release();
      if (this.#locks.get(key) === queued) this.#locks.delete(key);
    }
  }
}
