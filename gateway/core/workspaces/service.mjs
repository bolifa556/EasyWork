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
  createWorkspaceBindingKey,
  createWorkspaceId,
} from "./contract.mjs";
import { assertId, assertServerIdentity } from "../entities/common.mjs";

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

function overlapResolutions(risk) {
  if (!risk) return [];
  const containing = (risk.relationships || []).filter((entry) => entry.relationship === "contained_by");
  return containing.length === 1 ? ["reuse-containing-domain", "cancel"] : ["cancel"];
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

  async createVirtual(input) {
    const conversationId = await this.#authorize(input?.conversationId, "write");
    const serverIdentity = assertServerIdentity(input?.serverIdentity);
    const commandId = assertCommandId(input?.commandId);
    assertExpectedEntityRevision(input?.expectedRevision, { create: true });
    const branchId = assertId(input?.branchId || "main", "branchId");
    const idSeed = `virtual:${this.actor.actorId}:${serverIdentity}:${conversationId}:${branchId}`;
    const id = input?.workspaceId ? assertId(input.workspaceId, "workspaceId") : `ws_${crypto.createHash("sha256").update(idSeed).digest("hex").slice(0, 24)}`;
    const remoteRelative = `workspaces/${this.actor.actorId}/${conversationId}/${id}`;
    const canonicalPath = assertRemoteControlPath(await this.remoteControl.resolveEasyWork(remoteRelative), "virtualWorkspacePath");
    const remoteRef = workspaceRemoteRef(id);

    return this.#command("workspace.create-virtual", commandId, { conversationId, branchId, serverIdentity, id }, async (draft) => {
      const existing = draft.workspaces.find((entry) => entry.id === id || (entry.kind === "virtual" && entry.serverIdentity === serverIdentity && entry.canonicalPath === canonicalPath));
      if (existing) return { created: false, reused: true, workspace: clone(existing) };
      await this.remoteControl.ensureDirectory(canonicalPath);
      const createdAt = nowIso(this.clock);
      const workspace = {
        schemaVersion: WORKSPACE_SCHEMA_VERSION,
        id,
        actorId: this.actor.actorId,
        serverIdentity,
        kind: "virtual",
        canonicalPath,
        remoteRef,
        versionDomainId: null,
        revision: 0,
        createdAt,
        updatedAt: createdAt,
      };
      await this.#writeRemoteWorkspace(workspace);
      draft.workspaces.push(workspace);
      return { created: true, reused: false, workspace: clone(workspace) };
    });
  }

  async assessUserWorkspace(input) {
    await this.#authorize(input?.conversationId, "read");
    const serverIdentity = assertServerIdentity(input?.serverIdentity);
    const canonicalPath = await this.#canonicalUserPath(input?.path);
    const state = await this.repository.read();
    const exact = state.data.workspaces.find((entry) => entry.kind === "user" && entry.serverIdentity === serverIdentity && entry.canonicalPath === canonicalPath) || null;
    const versionAssessment = await this.versioning.assessWorkspace({ actorId: this.actor.actorId, serverIdentity, rootPath: canonicalPath });
    return {
      canonicalPath,
      exactWorkspace: exact ? clone(exact) : null,
      overlapRisk: clone(versionAssessment.risk),
      canCreate: Boolean(exact || versionAssessment.canCreate),
      allowedResolutions: overlapResolutions(versionAssessment.risk),
    };
  }

  async registerUserWorkspace(input) {
    const conversationId = await this.#authorize(input?.conversationId, "write");
    const serverIdentity = assertServerIdentity(input?.serverIdentity);
    const commandId = assertCommandId(input?.commandId);
    assertExpectedEntityRevision(input?.expectedRevision, { create: true });
    const canonicalPath = await this.#canonicalUserPath(input?.path);
    const overlapPolicy = input?.overlapPolicy == null ? null : String(input.overlapPolicy);
    invariant([null, "reuse-containing-domain"].includes(overlapPolicy), "WORKSPACE_OVERLAP_POLICY_INVALID", "工作区重叠处理方式无效", { status: 400 });

    return this.#command("workspace.register-user", commandId, { conversationId, serverIdentity, canonicalPath, overlapPolicy }, async (draft) => {
      const existing = draft.workspaces.find((entry) => entry.kind === "user" && entry.serverIdentity === serverIdentity && entry.canonicalPath === canonicalPath);
      if (existing) return { created: false, reused: true, workspace: clone(existing), overlapRisk: null };
      const assessment = await this.versioning.assessWorkspace({ actorId: this.actor.actorId, serverIdentity, rootPath: canonicalPath });
      if (assessment.risk && !overlapPolicy) {
        invariant(false, "WORKSPACE_OVERLAP_CONFIRMATION_REQUIRED", "工作区与已有工作区重叠，需要选择共享版本域或取消", {
          status: 409,
          details: { risk: assessment.risk, allowedResolutions: overlapResolutions(assessment.risk) },
        });
      }
      if (overlapPolicy) {
        invariant(overlapResolutions(assessment.risk).includes(overlapPolicy), "WORKSPACE_OVERLAP_POLICY_UNAVAILABLE", "当前重叠关系不能共享已有版本域", {
          status: 409,
          details: { risk: assessment.risk, allowedResolutions: overlapResolutions(assessment.risk) },
        });
      }
      const opened = await this.versioning.openDomain({
        actorId: this.actor.actorId,
        serverIdentity,
        rootPath: canonicalPath,
        mode: "real",
      }, overlapPolicy ? { overlapPolicy: "reuse-containing" } : {});
      invariant(opened.state, "WORKSPACE_VERSION_DOMAIN_UNAVAILABLE", "无法为工作区建立隔离版本域", { status: 409, details: { risk: opened.risk } });
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
        versionDomainId: opened.state.versionDomainId,
        revision: 0,
        createdAt,
        updatedAt: createdAt,
      };
      await this.#writeRemoteWorkspace(workspace);
      draft.workspaces.push(workspace);
      return { created: true, reused: false, workspace: clone(workspace), overlapRisk: clone(opened.risk) };
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

  async describeDynamicWrite(input) {
    const conversationId = await this.#authorize(input?.conversationId, "read");
    const branchId = assertId(input?.branchId || "main", "branchId");
    const agentId = assertId(input?.agentId, "agentId");
    const serverIdentity = assertServerIdentity(input?.serverIdentity);
    const contextEpoch = Number(input?.contextEpoch ?? 0);
    invariant(Number.isSafeInteger(contextEpoch) && contextEpoch >= 0, "WORKSPACE_CONTEXT_EPOCH_INVALID", "contextEpoch 无效", { status: 400 });
    const targetKind = input?.targetKind || "directory";
    invariant(["file", "directory"].includes(targetKind), "WORKSPACE_DYNAMIC_TARGET_KIND_INVALID", "动态写入目标类型无效", { status: 400 });
    const canonicalTargetPath = await this.#canonicalUserPath(input?.targetPath);
    const canonicalRootPath = targetKind === "file" ? path.posix.dirname(canonicalTargetPath) : canonicalTargetPath;
    const state = await this.repository.read();
    const workspace = state.data.workspaces.find((entry) => entry.kind === "dynamic" && entry.serverIdentity === serverIdentity && entry.canonicalPath === canonicalRootPath) || null;
    const bindingKey = workspace ? createWorkspaceBindingKey({
      actorId: this.actor.actorId,
      serverIdentity,
      conversationId,
      branchId,
      workspaceId: workspace.id,
      agentId,
      contextEpoch,
    }) : null;
    const binding = bindingKey ? state.data.bindings.find((entry) => entry.bindingKey === bindingKey) || null : null;
    const assessment = await this.versioning.assessWorkspace({ actorId: this.actor.actorId, serverIdentity, rootPath: canonicalRootPath });
    const core = {
      conversationId,
      branchId,
      agentId,
      serverIdentity,
      contextEpoch,
      targetPath: canonicalTargetPath,
      canonicalTargetPath,
      canonicalRootPath,
      targetKind,
      workspaceId: workspace?.id ?? null,
      bindingId: binding?.id ?? null,
    };
    return {
      id: createSwitchDescriptorId(core),
      ...core,
      requiresConfirmation: !binding,
      reusesNativeAgentSession: Boolean(binding?.nativeSessionId),
      lastDeliverySequence: binding?.lastDeliverySequence ?? 0,
      overlapRisk: clone(assessment.risk),
      explanation: "动态写入只授权当前目标目录；同一对话、Agent 和目录再次写入时复用原生会话与版本域。",
    };
  }

  async confirmDynamicWrite(input) {
    await this.#authorize(input?.conversationId, "write");
    const commandId = assertCommandId(input?.commandId);
    const replay = await this.#readCommandReplay("workspace.confirm-dynamic-write", commandId, {
      descriptorId: String(input?.descriptorId || ""),
    });
    if (replay) return replay;
    const descriptor = await this.describeDynamicWrite(input);
    invariant(input?.descriptorId === descriptor.id, "WORKSPACE_DYNAMIC_DESCRIPTOR_STALE", "动态写入信息已经变化，请重新确认", { status: 409 });
    assertExpectedEntityRevision(input?.expectedRevision, { create: true });
    return this.#command("workspace.confirm-dynamic-write", commandId, { descriptorId: descriptor.id }, async (draft) => {
      let workspace = draft.workspaces.find((entry) => entry.kind === "dynamic" && entry.serverIdentity === descriptor.serverIdentity && entry.canonicalPath === descriptor.canonicalRootPath);
      if (!workspace) {
        const resolved = await this.versioning.resolveDynamicWrite({
          actorId: this.actor.actorId,
          serverIdentity: descriptor.serverIdentity,
          targetPath: descriptor.canonicalTargetPath,
          targetKind: descriptor.targetKind,
        });
        invariant(resolved.state, "WORKSPACE_VERSION_DOMAIN_UNAVAILABLE", "无法为动态写入建立版本域", { status: 409, details: { risk: resolved.risk } });
        const id = createWorkspaceId({ actorId: this.actor.actorId, serverIdentity: descriptor.serverIdentity, canonicalPath: descriptor.canonicalRootPath, kind: "dynamic" });
        const timestamp = nowIso(this.clock);
        workspace = {
          schemaVersion: WORKSPACE_SCHEMA_VERSION,
          id,
          actorId: this.actor.actorId,
          serverIdentity: descriptor.serverIdentity,
          kind: "dynamic",
          canonicalPath: descriptor.canonicalRootPath,
          remoteRef: workspaceRemoteRef(id),
          versionDomainId: resolved.state.versionDomainId,
          revision: 0,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        await this.#writeRemoteWorkspace(workspace);
        draft.workspaces.push(workspace);
      }
      const normalized = this.#normalizeBindingInput({
        conversationId: descriptor.conversationId,
        branchId: descriptor.branchId,
        workspaceId: workspace.id,
        agentId: descriptor.agentId,
        contextEpoch: descriptor.contextEpoch,
      });
      const result = await this.#ensureBinding(draft, normalized);
      return { workspace: clone(workspace), binding: clone(result.binding), reused: !result.created };
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
    const existing = draft.bindings.find((entry) => entry.bindingKey === bindingKey);
    if (existing) return { created: false, binding: existing };
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
      versionDomainId: workspace.versionDomainId,
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
      versionDomainId: workspace.versionDomainId,
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
