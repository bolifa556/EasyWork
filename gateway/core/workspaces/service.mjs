import crypto from "node:crypto";
import path from "node:path";

import { invariant } from "../errors.mjs";
import { defaultActorMutationQueue } from "../mutation-queue.mjs";
import { AtomicJsonRepository } from "../repository.mjs";
import {
  EASYWORK_WORKSPACE_BINDING_ROOT,
  WORKSPACE_SCHEMA_VERSION,
  assertCommandId,
  assertEasyWorkRemoteReference,
  assertExpectedEntityRevision,
  assertNativeSessionId,
  assertRemoteControlPath,
  assertWorkspaceDependencies,
  assertWorkspaceStore,
  canonicalWorkspacePath,
  createSwitchDescriptorId,
  createVirtualWorkspaceId,
  createWorkspaceBindingKey,
  createWorkspaceId,
} from "./contract.mjs";
import { assertId, assertServerIdentity } from "../entities/common.mjs";
import { versionDomainId as deriveVersionDomainId } from "../versioning/contract.mjs";

const clone = (value) => structuredClone(value);
const inlineQueue = Object.freeze({ run: async (_actor, operation) => operation() });

function nowIso(clock) {
  const value = (clock || (() => new Date()))();
  const date = value instanceof Date ? value : new Date(value);
  invariant(Number.isFinite(date.valueOf()), "WORKSPACE_CLOCK_INVALID", "工作区时钟无效", { status: 500, expose: false });
  return date.toISOString();
}

function commandFingerprint(operation, input) {
  return crypto.createHash("sha256").update(JSON.stringify({ operation, input })).digest("hex");
}

function bindingRemoteRef(bindingId) {
  return assertEasyWorkRemoteReference(`${EASYWORK_WORKSPACE_BINDING_ROOT}/${assertId(bindingId, "bindingId")}.json`);
}

function workspaceRemoteRef(workspaceId) {
  return assertEasyWorkRemoteReference(`${EASYWORK_WORKSPACE_BINDING_ROOT}/workspace-${assertId(workspaceId, "workspaceId")}.json`);
}

function routeKey(conversationId, branchId) {
  return `${assertId(conversationId, "conversationId")}:${assertId(branchId, "branchId")}`;
}

export class WorkspaceService {
  constructor(dependencies) {
    assertWorkspaceDependencies(dependencies);
    this.actor = dependencies.actor;
    this.dataRoot = dependencies.dataRoot;
    this.remoteControl = dependencies.remoteControl;
    this.versioning = dependencies.versioning;
    this.authorizeConversation = dependencies.authorizeConversation;
    this.queue = dependencies.queue || defaultActorMutationQueue;
    this.clock = dependencies.clock;
    this.repository = new AtomicJsonRepository({
      dataRoot: this.dataRoot,
      actor: this.actor,
      relativePath: ["workspaces", "registry.json"],
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      defaultData: () => ({ workspaces: [], bindings: [], routes: [], commands: [] }),
      validate: (data) => assertWorkspaceStore(data, this.actor.actorId),
      queue: inlineQueue,
    });
  }

  async list(input = {}) {
    const state = await this.repository.read();
    const serverIdentity = input.serverIdentity ? assertServerIdentity(input.serverIdentity) : null;
    const workspaces = state.data.workspaces.filter((workspace) => !serverIdentity || workspace.serverIdentity === serverIdentity);
    return { revision: state.revision, workspaces: clone(workspaces) };
  }

  async getWorkspace(workspaceIdValue) {
    const workspaceId = assertId(workspaceIdValue, "workspaceId");
    const state = await this.repository.read();
    const workspace = state.data.workspaces.find((entry) => entry.id === workspaceId);
    invariant(workspace, "WORKSPACE_NOT_FOUND", "工作区不存在", { status: 404 });
    return clone(workspace);
  }

  async listBindings(input) {
    const conversationId = await this.#authorize(input?.conversationId, "read");
    const branchId = input?.branchId ? assertId(input.branchId, "branchId") : null;
    const state = await this.repository.read();
    return state.data.bindings
      .filter((binding) => binding.conversationId === conversationId && (!branchId || binding.branchId === branchId))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
      .map(clone);
  }

  async forgetConversations({ conversationIds = [], serverIdentity: serverIdentityValue } = {}, options = {}) {
    const deleted = new Set((Array.isArray(conversationIds) ? conversationIds : [])
      .map((value) => assertId(value, "conversationId")));
    const serverIdentity = assertServerIdentity(serverIdentityValue);
    const beforeCommit = options?.beforeCommit;
    invariant(beforeCommit === undefined || typeof beforeCommit === "function", "WORKSPACE_CLEANUP_CALLBACK_INVALID", "工作区清理回调无效", { status: 500, expose: false });
    if (!deleted.size) {
      return {
        removedBindings: [],
        removedRoutes: [],
        removedWorkspaces: [],
        retainedInheritedWorkspaces: [],
        protectedWorkspaceIds: [],
      };
    }
    return this.queue.run(this.actor, async () => {
      const current = await this.repository.read();
      const draft = clone(current.data);
      const removedBindings = draft.bindings.filter((binding) => (
        binding.serverIdentity === serverIdentity && deleted.has(binding.conversationId)
      ));
      const removedBindingIds = new Set(removedBindings.map((binding) => binding.id));
      const workspacesTouchedByRemovedBindings = new Set(removedBindings.map((binding) => binding.workspaceId));
      const removedRoutes = draft.routes.filter((route) => removedBindingIds.has(route.bindingId));
      draft.bindings = draft.bindings.filter((binding) => !removedBindingIds.has(binding.id));
      draft.routes = draft.routes.filter((route) => !removedBindingIds.has(route.bindingId));

      const referencedWorkspaceIds = new Set(draft.bindings
        .filter((binding) => binding.serverIdentity === serverIdentity)
        .map((binding) => binding.workspaceId));
      const ownedByDeletedConversation = (workspace) => deleted.has(
        String(workspace.canonicalPath || "")
          .split("/")
          .find((segment) => deleted.has(segment)) || "",
      );
      const removedWorkspaces = draft.workspaces.filter((workspace) => (
        workspace.serverIdentity === serverIdentity
          && workspace.kind === "virtual"
          && (ownedByDeletedConversation(workspace) || workspacesTouchedByRemovedBindings.has(workspace.id))
          && !referencedWorkspaceIds.has(workspace.id)
      ));
      const removedWorkspaceIds = new Set(removedWorkspaces.map((workspace) => workspace.id));
      const retainedInheritedWorkspaces = draft.workspaces.filter((workspace) => (
        workspace.serverIdentity === serverIdentity
          && workspace.kind === "virtual"
          && (ownedByDeletedConversation(workspace) || workspacesTouchedByRemovedBindings.has(workspace.id))
          && referencedWorkspaceIds.has(workspace.id)
      ));
      draft.workspaces = draft.workspaces.filter((workspace) => !removedWorkspaceIds.has(workspace.id));

      // Workspace commands are idempotency receipts, not user history. Once a
      // conversation is tombstoned, receipts whose result still embeds that
      // conversation would otherwise keep an unreachable control-plane graph
      // alive forever.
      draft.commands = draft.commands.filter((entry) => {
        const serialized = JSON.stringify(entry?.result || null);
        return ![...deleted].some((conversationId) => serialized.includes(conversationId));
      });
      const cleanup = {
        removedBindings: removedBindings.map(clone),
        removedRoutes: removedRoutes.map(clone),
        removedWorkspaces: removedWorkspaces.map(clone),
        retainedInheritedWorkspaces: retainedInheritedWorkspaces.map(clone),
        protectedWorkspaceIds: [...referencedWorkspaceIds].sort(),
      };
      // Remote cleanup is deliberately inside the same Actor mutation lock and
      // before the local registry commit. If SSH drops midway, a retry still
      // sees the binding/workspace plan (including a virtual workspace whose
      // canonical owner was an already-deleted parent conversation). Route
      // changes in a surviving derived conversation cannot race this decision.
      if (beforeCommit) await beforeCommit(clone(cleanup));
      await this.repository.replace(draft, { expectedRevision: current.revision, clock: this.clock });
      return cleanup;
    });
  }

  async createVirtual(input) {
    const conversationId = await this.#authorize(input?.conversationId, "write");
    const serverIdentity = assertServerIdentity(input?.serverIdentity);
    const commandId = assertCommandId(input?.commandId);
    assertExpectedEntityRevision(input?.expectedRevision, { create: true });
    const branchId = assertId(input?.branchId || "main", "branchId");
    const id = input?.workspaceId ? assertId(input.workspaceId, "workspaceId") : createVirtualWorkspaceId({ actorId: this.actor.actorId, serverIdentity, conversationId, branchId });
    const remoteRelative = `workspaces/${this.actor.actorId}/${conversationId}/${id}`;
    const canonicalPath = assertRemoteControlPath(await this.remoteControl.resolveEasyWork(remoteRelative), "virtualWorkspacePath");
    const remoteRef = workspaceRemoteRef(id);

    return this.#command("workspace.create-virtual", commandId, { conversationId, branchId, serverIdentity, id }, async (draft) => {
      const existing = draft.workspaces.find((entry) => entry.id === id || (entry.kind === "virtual" && entry.serverIdentity === serverIdentity && entry.canonicalPath === canonicalPath));
      if (existing) return { created: false, reused: true, workspace: clone(existing) };
      const createdAt = nowIso(this.clock);
      const workspace = {
        schemaVersion: WORKSPACE_SCHEMA_VERSION,
        id,
        actorId: this.actor.actorId,
        serverIdentity,
        kind: "virtual",
        canonicalPath,
        remoteRef,
        revision: 0,
        createdAt,
        updatedAt: createdAt,
      };
      await Promise.all([
        this.remoteControl.ensureDirectory(canonicalPath),
        this.#writeRemoteWorkspace(workspace),
      ]);
      draft.workspaces.push(workspace);
      return { created: true, reused: false, workspace: clone(workspace) };
    });
  }

  async registerUserWorkspace(input) {
    const conversationId = await this.#authorize(input?.conversationId, "write");
    const serverIdentity = assertServerIdentity(input?.serverIdentity);
    const commandId = assertCommandId(input?.commandId);
    assertExpectedEntityRevision(input?.expectedRevision, { create: true });
    const canonicalPath = await this.#canonicalUserPath(input?.path);
    return this.#command("workspace.register-user", commandId, { conversationId, serverIdentity, canonicalPath }, async (draft) => {
      const existing = draft.workspaces.find((entry) => entry.kind === "user" && entry.serverIdentity === serverIdentity && entry.canonicalPath === canonicalPath);
      if (existing) return { created: false, reused: true, workspace: clone(existing) };
      const id = createWorkspaceId({ actorId: this.actor.actorId, serverIdentity, canonicalPath, kind: "user" });
      const createdAt = nowIso(this.clock);
      const workspace = {
        schemaVersion: WORKSPACE_SCHEMA_VERSION,
        id,
        actorId: this.actor.actorId,
        serverIdentity,
        kind: "user",
        canonicalPath,
        remoteRef: workspaceRemoteRef(id),
        revision: 0,
        createdAt,
        updatedAt: createdAt,
      };
      await this.#writeRemoteWorkspace(workspace);
      draft.workspaces.push(workspace);
      return { created: true, reused: false, workspace: clone(workspace) };
    });
  }

  async ensureAgentBinding(input) {
    const conversationId = await this.#authorize(input?.conversationId, "write");
    const commandId = assertCommandId(input?.commandId);
    assertExpectedEntityRevision(input?.expectedRevision, { create: true });
    const normalized = this.#normalizeBindingInput({ ...input, conversationId });
    return this.#command("workspace.ensure-binding", commandId, normalized, async (draft) => {
      const result = await this.#ensureBinding(draft, normalized);
      const key = routeKey(normalized.conversationId, normalized.branchId);
      let route = draft.routes.find((entry) => entry.key === key) || null;
      if (!route) {
        const timestamp = nowIso(this.clock);
        route = {
          schemaVersion: WORKSPACE_SCHEMA_VERSION,
          key,
          actorId: this.actor.actorId,
          conversationId: normalized.conversationId,
          branchId: normalized.branchId,
          bindingId: result.binding.id,
          revision: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        draft.routes.push(route);
      }
      return {
        created: result.created,
        reused: !result.created,
        binding: clone(result.binding),
        routeRevision: route.revision,
      };
    });
  }

  async describeSwitch(input) {
    const conversationId = await this.#authorize(input?.conversationId, "read");
    const branchId = assertId(input?.branchId || "main", "branchId");
    const workspaceId = assertId(input?.workspaceId, "workspaceId");
    const agentId = assertId(input?.agentId, "agentId");
    const contextEpoch = Number(input?.contextEpoch ?? 0);
    invariant(Number.isSafeInteger(contextEpoch) && contextEpoch >= 0, "WORKSPACE_CONTEXT_EPOCH_INVALID", "contextEpoch 无效", { status: 400 });
    const state = await this.repository.read();
    const workspace = state.data.workspaces.find((entry) => entry.id === workspaceId);
    invariant(workspace, "WORKSPACE_NOT_FOUND", "工作区不存在", { status: 404 });
    const key = createWorkspaceBindingKey({
      actorId: this.actor.actorId,
      serverIdentity: workspace.serverIdentity,
      conversationId,
      branchId,
      workspaceId,
      agentId,
      contextEpoch,
    });
    const targetBinding = state.data.bindings.find((entry) => entry.bindingKey === key) || null;
    const route = state.data.routes.find((entry) => entry.key === routeKey(conversationId, branchId)) || null;
    const currentBinding = route ? state.data.bindings.find((entry) => entry.id === route.bindingId) || null : null;
    const descriptorCore = {
      conversationId,
      branchId,
      routeRevision: route?.revision ?? 0,
      fromBindingId: currentBinding?.id ?? null,
      targetWorkspaceId: workspaceId,
      targetAgentId: agentId,
      targetContextEpoch: contextEpoch,
      targetBindingId: targetBinding?.id ?? null,
      targetBindingRevision: targetBinding?.revision ?? 0,
    };
    return {
      id: createSwitchDescriptorId(descriptorCore),
      ...descriptorCore,
      requiresConfirmation: Boolean(currentBinding && (currentBinding.workspaceId !== workspaceId || currentBinding.agentId !== agentId)),
      effects: {
        switchesNativeAgentSession: Boolean(currentBinding && currentBinding.bindingKey !== key),
        preservesWebConversationMemory: true,
        reusesNativeAgentSession: Boolean(targetBinding?.nativeSessionId),
        contextDelivery: targetBinding ? "delta-after-watermark" : "bootstrap",
        lastDeliverySequence: targetBinding?.lastDeliverySequence ?? 0,
      },
    };
  }

  async switchBinding(input) {
    await this.#authorize(input?.conversationId, "write");
    const commandId = assertCommandId(input?.commandId);
    const replay = await this.#readCommandReplay("workspace.switch-binding", commandId, {
      descriptorId: String(input?.descriptorId || ""),
      expectedRevision: input?.expectedRevision,
    });
    if (replay) return replay;
    const descriptor = await this.describeSwitch(input);
    invariant(input?.descriptorId === descriptor.id, "WORKSPACE_SWITCH_DESCRIPTOR_STALE", "工作区切换信息已经变化，请重新确认", { status: 409 });
    const expectedRevision = assertExpectedEntityRevision(input?.expectedRevision);
    invariant(expectedRevision === descriptor.routeRevision, "REVISION_CONFLICT", "当前工作区路由已被其他操作更新", {
      status: 409,
      details: { expectedRevision, actualRevision: descriptor.routeRevision },
    });
    const normalized = this.#normalizeBindingInput({
      conversationId: descriptor.conversationId,
      branchId: descriptor.branchId,
      workspaceId: descriptor.targetWorkspaceId,
      agentId: descriptor.targetAgentId,
      contextEpoch: descriptor.targetContextEpoch,
    });
    return this.#command("workspace.switch-binding", commandId, { descriptorId: descriptor.id, expectedRevision }, async (draft) => {
      const { binding } = await this.#ensureBinding(draft, normalized);
      const key = routeKey(descriptor.conversationId, descriptor.branchId);
      const route = draft.routes.find((entry) => entry.key === key);
      const timestamp = nowIso(this.clock);
      if (route) {
        invariant(route.revision === expectedRevision, "REVISION_CONFLICT", "当前工作区路由已被其他操作更新", { status: 409 });
        route.bindingId = binding.id;
        route.revision += 1;
        route.updatedAt = timestamp;
      } else {
        invariant(expectedRevision === 0, "REVISION_CONFLICT", "当前工作区路由已被其他操作更新", { status: 409 });
        draft.routes.push({
          schemaVersion: WORKSPACE_SCHEMA_VERSION,
          key,
          actorId: this.actor.actorId,
          conversationId: descriptor.conversationId,
          branchId: descriptor.branchId,
          bindingId: binding.id,
          revision: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
      }
      return { binding: clone(binding), descriptor: clone(descriptor), routeRevision: expectedRevision + 1 };
    });
  }

  async updateNativeSession(input) {
    const bindingId = assertId(input?.bindingId, "bindingId");
    const commandId = assertCommandId(input?.commandId);
    const expectedRevision = assertExpectedEntityRevision(input?.expectedRevision);
    const nativeSessionId = assertNativeSessionId(input?.nativeSessionId);
    const lastDeliverySequence = Number(input?.lastDeliverySequence);
    invariant(Number.isSafeInteger(lastDeliverySequence) && lastDeliverySequence >= 0, "WORKSPACE_BINDING_WATERMARK_INVALID", "Delivery watermark 无效", { status: 400 });
    return this.#command("workspace.update-native-session", commandId, { bindingId, expectedRevision, nativeSessionId, lastDeliverySequence }, async (draft) => {
      const binding = draft.bindings.find((entry) => entry.id === bindingId);
      invariant(binding, "WORKSPACE_BINDING_NOT_FOUND", "工作区 Agent Binding 不存在", { status: 404 });
      await this.#authorize(binding.conversationId, "write");
      invariant(binding.revision === expectedRevision, "REVISION_CONFLICT", "工作区 Agent Binding 已被其他操作更新", { status: 409 });
      invariant(lastDeliverySequence >= binding.lastDeliverySequence, "WORKSPACE_BINDING_WATERMARK_REGRESSION", "Delivery watermark 不能回退", { status: 409 });
      binding.nativeSessionId = nativeSessionId;
      binding.lastDeliverySequence = lastDeliverySequence;
      binding.revision += 1;
      binding.updatedAt = nowIso(this.clock);
      await this.#writeRemoteBinding(binding);
      return { binding: clone(binding) };
    });
  }

  async getRoute(input) {
    const conversationId = await this.#authorize(input?.conversationId, "read");
    const branchId = assertId(input?.branchId || "main", "branchId");
    const state = await this.repository.read();
    const route = state.data.routes.find((entry) => entry.key === routeKey(conversationId, branchId));
    if (!route) return null;
    const binding = state.data.bindings.find((entry) => entry.id === route.bindingId);
    const workspace = state.data.workspaces.find((entry) => entry.id === binding?.workspaceId);
    invariant(binding && workspace, "WORKSPACE_ROUTE_CORRUPT", "工作区路由引用无效", { status: 500, expose: false });
    return { route: clone(route), binding: clone(binding), workspace: clone(workspace) };
  }

  async forkBranch(input) {
    const conversationId = await this.#authorize(input?.conversationId, "write");
    const sourceBranchId = assertId(input?.sourceBranchId, "sourceBranchId");
    const branchId = assertId(input?.branchId, "branchId");
    const commandId = assertCommandId(input?.commandId);
    return this.#command("workspace.fork-branch", commandId, { conversationId, sourceBranchId, branchId }, async (draft) => {
      const sourceRoute = draft.routes.find((entry) => entry.key === routeKey(conversationId, sourceBranchId));
      if (!sourceRoute) return { routed: false, reason: "source-route-missing" };
      const sourceBinding = draft.bindings.find((entry) => entry.id === sourceRoute.bindingId);
      invariant(sourceBinding, "WORKSPACE_ROUTE_CORRUPT", "来源工作区路由引用无效", { status: 500, expose: false });
      const normalized = this.#normalizeBindingInput({
        conversationId,
        branchId,
        workspaceId: sourceBinding.workspaceId,
        agentId: sourceBinding.agentId,
        contextEpoch: sourceBinding.contextEpoch,
      });
      const { binding } = await this.#ensureBinding(draft, normalized);
      const key = routeKey(conversationId, branchId);
      let route = draft.routes.find((entry) => entry.key === key) || null;
      const timestamp = nowIso(this.clock);
      if (!route) {
        route = {
          schemaVersion: WORKSPACE_SCHEMA_VERSION,
          key,
          actorId: this.actor.actorId,
          conversationId,
          branchId,
          bindingId: binding.id,
          revision: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        draft.routes.push(route);
      }
      return { routed: true, binding: clone(binding), route: clone(route) };
    });
  }

  async forkConversation(input) {
    const sourceConversationId = await this.#authorize(input?.sourceConversationId, "read");
    const conversationId = await this.#authorize(input?.conversationId, "write");
    const sourceBranchId = assertId(input?.sourceBranchId, "sourceBranchId");
    const branchId = assertId(input?.branchId, "branchId");
    const sourceBindingId = input?.sourceBindingId == null ? null : assertId(input.sourceBindingId, "sourceBindingId");
    const commandId = assertCommandId(input?.commandId);
    return this.#command("workspace.fork-conversation", commandId, {
      sourceConversationId,
      conversationId,
      sourceBranchId,
      branchId,
      sourceBindingId,
    }, async (draft) => {
      const sourceRoute = draft.routes.find((entry) => entry.key === routeKey(sourceConversationId, sourceBranchId));
      if (!sourceRoute) return { routed: false, reason: "source-route-missing" };
      const sourceBinding = draft.bindings.find((entry) => entry.id === (sourceBindingId || sourceRoute.bindingId));
      invariant(sourceBinding, "WORKSPACE_ROUTE_CORRUPT", "来源工作区路由引用无效", { status: 500, expose: false });
      invariant(sourceBinding.conversationId === sourceConversationId && sourceBinding.branchId === sourceBranchId, "WORKSPACE_FORK_BINDING_SCOPE_MISMATCH", "分支来源工作区绑定不属于来源对话边界", { status: 409 });
      const normalized = this.#normalizeBindingInput({
        conversationId,
        branchId,
        workspaceId: sourceBinding.workspaceId,
        agentId: sourceBinding.agentId,
        contextEpoch: sourceBinding.contextEpoch,
      });
      const { binding } = await this.#ensureBinding(draft, normalized);
      const key = routeKey(conversationId, branchId);
      let route = draft.routes.find((entry) => entry.key === key) || null;
      const timestamp = nowIso(this.clock);
      if (!route) {
        route = {
          schemaVersion: WORKSPACE_SCHEMA_VERSION,
          key,
          actorId: this.actor.actorId,
          conversationId,
          branchId,
          bindingId: binding.id,
          revision: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        draft.routes.push(route);
      }
      const workspace = draft.workspaces.find((entry) => entry.id === binding.workspaceId);
      return { routed: true, binding: clone(binding), route: clone(route), workspace: clone(workspace) };
    });
  }

  async advanceContextEpoch(input) {
    const conversationId = await this.#authorize(input?.conversationId, "write");
    const branchId = assertId(input?.branchId, "branchId");
    const commandId = assertCommandId(input?.commandId);
    return this.#command("workspace.advance-context-epoch", commandId, { conversationId, branchId }, async (draft) => {
      const key = routeKey(conversationId, branchId);
      const route = draft.routes.find((entry) => entry.key === key);
      if (!route) return { routed: false, reason: "route-missing" };
      const current = draft.bindings.find((entry) => entry.id === route.bindingId);
      invariant(current, "WORKSPACE_ROUTE_CORRUPT", "工作区路由引用无效", { status: 500, expose: false });
      const { binding } = await this.#ensureBinding(draft, this.#normalizeBindingInput({
        conversationId,
        branchId,
        workspaceId: current.workspaceId,
        agentId: current.agentId,
        contextEpoch: current.contextEpoch + 1,
      }));
      route.bindingId = binding.id;
      route.revision += 1;
      route.updatedAt = nowIso(this.clock);
      return { routed: true, binding: clone(binding), route: clone(route) };
    });
  }

  async restoreUnusedContextEpoch(input) {
    const conversationId = await this.#authorize(input?.conversationId, "write");
    const branchId = assertId(input?.branchId, "branchId");
    const currentBindingId = assertId(input?.currentBindingId, "currentBindingId");
    const targetBindingId = assertId(input?.targetBindingId, "targetBindingId");
    const commandId = assertCommandId(input?.commandId);
    return this.#command("workspace.restore-unused-context-epoch", commandId, {
      conversationId,
      branchId,
      currentBindingId,
      targetBindingId,
    }, async (draft) => {
      const route = draft.routes.find((entry) => entry.key === routeKey(conversationId, branchId));
      invariant(route?.bindingId === currentBindingId, "WORKSPACE_ROUTE_STALE", "工作区路由已经变化", { status: 409 });
      const current = draft.bindings.find((entry) => entry.id === currentBindingId);
      const target = draft.bindings.find((entry) => entry.id === targetBindingId);
      invariant(current && target, "WORKSPACE_BINDING_NOT_FOUND", "工作区 Agent Binding 不存在", { status: 404 });
      invariant(target.conversationId === conversationId
        && target.branchId === branchId
        && target.serverIdentity === current.serverIdentity
        && target.workspaceId === current.workspaceId
        && target.agentId === current.agentId
        && target.contextEpoch < current.contextEpoch,
      "WORKSPACE_CONTEXT_EPOCH_RESTORE_INVALID", "不能恢复到该 Agent 上下文代次", { status: 409 });
      const timestamp = nowIso(this.clock);
      current.status = "stale";
      current.revision += 1;
      current.updatedAt = timestamp;
      target.status = "active";
      target.revision += 1;
      target.updatedAt = timestamp;
      route.bindingId = target.id;
      route.revision += 1;
      route.updatedAt = timestamp;
      await Promise.all([this.#writeRemoteBinding(current), this.#writeRemoteBinding(target)]);
      return { routed: true, binding: clone(target), route: clone(route), repairedBindingId: current.id };
    });
  }

  async #authorize(conversationIdValue, action) {
    const conversationId = assertId(conversationIdValue, "conversationId");
    const result = await this.authorizeConversation(conversationId, action, this.actor);
    invariant(result !== false, "CONVERSATION_FORBIDDEN", "无权访问该对话", { status: 403 });
    return conversationId;
  }

  async #canonicalUserPath(value) {
    const canonical = await this.remoteControl.canonicalize(String(value || ""));
    return canonicalWorkspacePath(canonical, "workspacePath");
  }

  #normalizeBindingInput(input) {
    const conversationId = assertId(input?.conversationId, "conversationId");
    const branchId = assertId(input?.branchId || "main", "branchId");
    const workspaceId = assertId(input?.workspaceId, "workspaceId");
    const agentId = assertId(input?.agentId, "agentId");
    const contextEpoch = Number(input?.contextEpoch ?? 0);
    invariant(Number.isSafeInteger(contextEpoch) && contextEpoch >= 0, "WORKSPACE_CONTEXT_EPOCH_INVALID", "contextEpoch 无效", { status: 400 });
    return { conversationId, branchId, workspaceId, agentId, contextEpoch };
  }

  async #ensureBinding(draft, normalized) {
    const workspace = draft.workspaces.find((entry) => entry.id === normalized.workspaceId);
    invariant(workspace, "WORKSPACE_NOT_FOUND", "工作区不存在", { status: 404 });
    const bindingKey = createWorkspaceBindingKey({
      actorId: this.actor.actorId,
      serverIdentity: workspace.serverIdentity,
      conversationId: normalized.conversationId,
      branchId: normalized.branchId,
      workspaceId: workspace.id,
      agentId: normalized.agentId,
      contextEpoch: normalized.contextEpoch,
    });
    const existing = draft.bindings.find((entry) => entry.bindingKey === bindingKey) || null;
    // The ledger identity is pure control-plane data.  Do not open or create a
    // remote ledger while establishing a route.  A task only reads an existing
    // head during parallel preparation; the first native file mutation creates
    // the ledger lazily.  Thus a read-only conversation leaves no empty version
    // state behind and route creation stays outside the first-turn critical path.
    const versionDomainId = deriveVersionDomainId({
      actorId: this.actor.actorId,
      serverIdentity: workspace.serverIdentity,
      conversationId: normalized.conversationId,
    });
    if (existing) {
      if (existing.versionDomainId !== versionDomainId) {
        existing.versionDomainId = versionDomainId;
        existing.revision += 1;
        existing.updatedAt = nowIso(this.clock);
        await this.#writeRemoteBinding(existing);
      }
      return { created: false, binding: existing };
    }
    const superseded = draft.bindings.filter((entry) => entry.status === "active"
      && entry.serverIdentity === workspace.serverIdentity
      && entry.conversationId === normalized.conversationId
      && entry.branchId === normalized.branchId
      && entry.workspaceId === workspace.id
      && entry.agentId === normalized.agentId
      && entry.contextEpoch !== normalized.contextEpoch);
    for (const prior of superseded) {
      prior.status = "stale";
      prior.revision += 1;
      prior.updatedAt = nowIso(this.clock);
      await this.#writeRemoteBinding(prior);
    }
    const id = `wsb_${crypto.createHash("sha256").update(bindingKey).digest("hex").slice(0, 24)}`;
    const timestamp = nowIso(this.clock);
    const binding = {
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      id,
      bindingKey,
      actorId: this.actor.actorId,
      conversationId: normalized.conversationId,
      branchId: normalized.branchId,
      serverIdentity: workspace.serverIdentity,
      workspaceId: workspace.id,
      versionDomainId,
      agentId: normalized.agentId,
      contextEpoch: normalized.contextEpoch,
      nativeSessionId: null,
      lastDeliverySequence: 0,
      status: "active",
      remoteRef: bindingRemoteRef(id),
      revision: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.#writeRemoteBinding(binding);
    draft.bindings.push(binding);
    return { created: true, binding };
  }

  async #writeRemoteWorkspace(workspace) {
    const resolved = assertRemoteControlPath(await this.remoteControl.resolveEasyWork(`bindings/workspaces/workspace-${workspace.id}.json`));
    await this.remoteControl.ensureDirectory(path.posix.dirname(resolved));
    await this.remoteControl.writeJsonAtomic(resolved, {
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      workspaceId: workspace.id,
      kind: workspace.kind,
      canonicalPath: workspace.canonicalPath,
      actorId: workspace.actorId,
      serverIdentity: workspace.serverIdentity,
    });
  }

  async #writeRemoteBinding(binding) {
    const resolved = assertRemoteControlPath(await this.remoteControl.resolveEasyWork(`bindings/workspaces/${binding.id}.json`));
    await this.remoteControl.ensureDirectory(path.posix.dirname(resolved));
    await this.remoteControl.writeJsonAtomic(resolved, {
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      bindingId: binding.id,
      conversationId: binding.conversationId,
      branchId: binding.branchId,
      workspaceId: binding.workspaceId,
      versionDomainId: binding.versionDomainId,
      agentId: binding.agentId,
      contextEpoch: binding.contextEpoch,
      nativeSessionId: binding.nativeSessionId,
      lastDeliverySequence: binding.lastDeliverySequence,
      status: binding.status,
    });
  }

  async #command(operation, commandId, input, execute) {
    const fingerprint = commandFingerprint(operation, input);
    return this.queue.run(this.actor, async () => {
      const current = await this.repository.read();
      const previous = current.data.commands.find((entry) => entry.commandId === commandId);
      if (previous) {
        invariant(previous.operation === operation && previous.fingerprint === fingerprint, "COMMAND_ID_REUSED", "commandId 已用于不同工作区操作", { status: 409 });
        return { ...clone(previous.result), storeRevision: current.revision, idempotentReplay: true };
      }
      const draft = clone(current.data);
      const result = await execute(draft);
      draft.commands.push({ commandId, operation, fingerprint, result: clone(result), completedAt: nowIso(this.clock) });
      const updated = await this.repository.replace(draft, { expectedRevision: current.revision, clock: () => new Date(nowIso(this.clock)) });
      return { ...clone(result), storeRevision: updated.revision, idempotentReplay: false };
    });
  }

  async #readCommandReplay(operation, commandId, input) {
    const current = await this.repository.read();
    const previous = current.data.commands.find((entry) => entry.commandId === commandId);
    if (!previous) return null;
    const fingerprint = commandFingerprint(operation, input);
    invariant(previous.operation === operation && previous.fingerprint === fingerprint, "COMMAND_ID_REUSED", "commandId 已用于不同工作区操作", { status: 409 });
    return { ...clone(previous.result), storeRevision: current.revision, idempotentReplay: true };
  }
}
