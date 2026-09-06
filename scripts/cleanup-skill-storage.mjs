import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createActorContext } from "../gateway/core/actor.mjs";
import { SkillMarketplaceService, SkillService } from "../gateway/core/skills/index.mjs";
import { skillStoragePath } from "../gateway/core/skills/package-storage.mjs";

// Run offline: the services' mutation queues coordinate within one process.
// Every retained package is verified before any account's cleanup is applied.
export async function cleanupSkillStorage({ dataRoot, dryRun = true }) {
  dataRoot = path.resolve(dataRoot);
  const targets = [{ scope: "market", service: new SkillMarketplaceService({ dataRoot }) }];
  for (const actorType of ["user", "guest"]) {
    const folder = actorType === "user" ? "users" : "guests";
    const root = await skillStoragePath(dataRoot, folder);
    const entries = await fs.readdir(root, { withFileTypes: true }).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      const skillRoot = await skillStoragePath(dataRoot, `${folder}/${entry.name}/skills`);
      const exists = await fs.stat(skillRoot).catch((error) => {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
        throw error;
      });
      if (!exists?.isDirectory()) continue;
      const actor = createActorContext({ actorType, actorId: entry.name, deviceId: "skill-cleanup", sessionId: "skill-cleanup", roles: [] });
      targets.push({ scope: `${folder}/${entry.name}`, service: new SkillService({ dataRoot, actor, authorizeTask: async () => false }) });
    }
  }
  const plans = [];
  for (const { scope, service } of targets) plans.push({ scope, ...await service.cleanupStorage({ dryRun: true }) });
  if (dryRun) return { dataRoot, dryRun, scopes: plans };
  const scopes = [];
  for (const { scope, service } of targets) scopes.push({ scope, ...await service.cleanupStorage({ dryRun: false }) });
  return { dataRoot, dryRun, scopes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: {
    "data-root": { type: "string", default: path.resolve("data") },
    apply: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  } });
  if (values.help) console.log("Usage: node scripts/cleanup-skill-storage.mjs [--data-root PATH] [--apply]\nStop EasyWork before using --apply. Without --apply, only report obsolete skill packages. No backups are created.");
  else {
    try { console.log(JSON.stringify(await cleanupSkillStorage({ dataRoot: values["data-root"], dryRun: !values.apply }), null, 2)); }
    catch (error) { console.error(`${error.code || error.name}: ${error.message}`); process.exitCode = 1; }
  }
}
