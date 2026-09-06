import { createActorContext } from "../actor.mjs";
import { SkillService } from "./service.mjs";

const userActor = (actorId, roles = []) => createActorContext({ actorType: "user", actorId, deviceId: "skill-distribution", sessionId: "skill-distribution", roles });
const distributionAdmin = userActor("skill-distribution", ["admin"]);

export class SkillDistributionService {
  constructor({ dataRoot, marketplace, auth, clock }) {
    this.dataRoot = dataRoot;
    this.marketplace = marketplace;
    this.auth = auth;
    this.clock = clock;
  }

  async installForActor(actor, skillService, deployments) {
    if (actor.actorType !== "user") return [];
    deployments ||= await this.marketplace.listDeployments();
    if (!deployments.length) return [];
    const skills = skillService || new SkillService({ dataRoot: this.dataRoot, actor, clock: this.clock, authorizeTask: async () => false });
    const results = [];
    for (const { id, deploymentId } of deployments) results.push(await this.marketplace.install(actor, skills, id, { deploymentId }));
    return results;
  }

  async reconcile(marketSkillId) {
    const deployments = (await this.marketplace.listDeployments()).filter((item) => !marketSkillId || item.id === marketSkillId);
    const result = { installed: 0, skipped: 0, failed: 0 };
    if (!deployments.length) return result;
    for (const { userId } of await this.auth.listUsersForAdmin(distributionAdmin)) {
      try {
        for (const installed of await this.installForActor(userActor(userId), undefined, deployments)) {
          result[installed.duplicate ? "skipped" : "installed"] += 1;
        }
      } catch { result.failed += 1; }
    }
    return result;
  }
}
