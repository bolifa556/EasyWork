import assert from "node:assert/strict";
import test from "node:test";

import * as gateway from "../gateway/core/index.mjs";

test("gateway/core 提供单一且可直接接入的公共出口", () => {
  const expectedFunctions = [
    "ApiError",
    "ArtifactService",
    "AgentDeploymentService",
    "AgentRuntimeTransport",
    "AuthDeviceService",
    "ContextHub",
    "CollectionService",
    "ConversationService",
    "DetachedTaskRuntime",
    "FileTaskStore",
    "PersistentMemoryService",
    "PlatformConfigurationService",
    "ProjectService",
    "ProviderService",
    "ActorMutationQueue",
    "AtomicJsonRepository",
    "RealtimeEventJournal",
    "ResourceService",
    "SchedulerService",
    "SshCredentialVault",
    "SshAgentExecutor",
    "SshNetworkPolicy",
    "SshServerRegistry",
    "SshWorkerPool",
    "SkillService",
    "TaskOrchestrator",
    "HostAgentArtifactCatalog",
    "VersioningService",
    "WorkspaceService",
    "WorkDraftService",
    "apiFailure",
    "apiSuccess",
    "computeServerIdentity",
    "createActorContext",
    "createArtifact",
    "createAgentAdapters",
    "createContextDelivery",
    "createContextSession",
    "createEffectiveContextScope",
    "createOpaqueCursorCodec",
    "createResourceBinding",
    "createResourceBlob",
    "createResourceVersion",
    "createSkillRegistry",
    "createSkillVersion",
    "createTask",
    "SlurmSchedulerAdapter",
    "PbsSchedulerAdapter",
    "WebAgentRuntime",
    "transitionTask",
  ];
  for (const name of expectedFunctions) assert.equal(typeof gateway[name], "function", `${name} 未从 gateway index 导出`);
});

test("公共出口不暴露旧协议或兼容入口", () => {
  for (const forbidden of ["agentMemoryDelta", "WorkerTask", "legacyState", "normalizeLegacyState", "keywordFallbackSearch"]) {
    assert.equal(forbidden in gateway, false, `不应导出旧入口 ${forbidden}`);
  }
});
