import {
  createCapabilityProfile,
  createUnavailableFeature,
  schedulerUnsupported,
} from "./contract.mjs";

const REASON = "PBS adapter 尚未实现，EasyWork 不会把 PBS 命令输出冒充结构化调度数据";

export class PbsSchedulerAdapter {
  type = "pbs";

  inspectCapabilities(input) {
    const unavailable = createUnavailableFeature(REASON);
    return createCapabilityProfile({
      serverIdentity: input.serverIdentity,
      scheduler: "pbs",
      commands: Object.fromEntries(["qstat", "qsub", "qdel", "pbsnodes"].map((command) => [command, false])),
      features: {
        accessiblePartitions: unavailable,
        resourceSummary: unavailable,
        userJobs: unavailable,
        jobHistory: unavailable,
        jobOutput: unavailable,
        submit: unavailable,
        cancelJob: unavailable,
      },
      partitionsOrQueues: [],
      detectedAt: input.detectedAt,
      expiresAt: input.expiresAt,
    });
  }

  accessiblePartitions() { return schedulerUnsupported(this.type, "accessiblePartitions", REASON); }
  resourceSummary() { return schedulerUnsupported(this.type, "resourceSummary", REASON); }
  userJobs() { return schedulerUnsupported(this.type, "userJobs", REASON); }
  inspectJob() { return schedulerUnsupported(this.type, "inspectJob", REASON); }
  jobOutput() { return schedulerUnsupported(this.type, "jobOutput", REASON); }
  submit() { return schedulerUnsupported(this.type, "submit", REASON); }
  cancelJob() { return schedulerUnsupported(this.type, "cancelJob", REASON); }
}
