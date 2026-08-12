export type CapabilityStatus = "available" | "unavailable" | "restricted" | "error";

export type Capability = {
  available: boolean;
  status: CapabilityStatus;
  reason: string | null;
  diagnostic: { code: string; retryable: boolean } | null;
};

export type CapabilityDiagnostic = {
  id: string;
  feature: string;
  code: string;
  message: string;
  retryable: boolean;
};

export type ServerCapabilityProfile = {
  schemaVersion: 1;
  serverId: string;
  detectedAt: string;
  expiresAt: string;
  status: "detecting" | "ready" | "partial" | "error";
  features: {
    remoteFiles: Capability & {
      list: boolean;
      upload: boolean;
      download: boolean;
      range: boolean;
      mkdir: boolean;
      rename: boolean;
      delete: boolean;
      maxUploadBytes: number | null;
      maxDownloadBytes: number | null;
    };
    preview: Capability & { types: string[] };
    terminal: Capability & { pty: boolean; resume: boolean };
    workspaces: Capability & { virtual: boolean; user: boolean; switch: boolean; dynamicWrite: boolean };
    versioning: Capability & { shadow: boolean; userGit: boolean; isolated: boolean };
    scheduler: Capability & {
      type: "slurm" | "pbs" | "generic" | "none";
      resourceSummary: boolean;
      partitions: boolean;
      userJobs: boolean;
      jobHistory: boolean;
      submitJob: boolean;
      cancelJob: boolean;
      jobOutput: boolean;
    };
    artifacts: Capability & { capture: boolean; download: boolean; range: boolean };
    agents: Capability & {
      inspect: boolean;
      install: boolean;
      update: boolean;
      uninstall: boolean;
      configure: boolean;
      context: boolean;
      compact: boolean;
    };
    skills: Capability & { registry: boolean; deploy: boolean };
  };
  diagnostics: CapabilityDiagnostic[];
};

export type AgentCapability = {
  available: boolean;
  reason?: string;
};

export type AgentCapabilities = {
  nativeSession: AgentCapability;
  liveInput: AgentCapability;
  interrupt: AgentCapability;
  resume: AgentCapability;
  reasoning: AgentCapability;
  plan: AgentCapability;
  approvals: AgentCapability;
  fileDiff: AgentCapability;
  contextUsage: AgentCapability;
  contextLimit: AgentCapability;
  compact: AgentCapability;
  permissions: AgentCapability;
  effort: AgentCapability;
};
