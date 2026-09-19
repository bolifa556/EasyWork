import {
  assertArray, assertEntityHeader, assertExactKeys, assertId, assertIsoTimestamp,
  assertPortableRelativePath, assertSha256, assertString, assertUnique,
  clone, createHeader, deepFreeze,
} from "./common.mjs";

const SKILL_KEYS = ["schemaVersion", "entityType", "revision", "id", "actorId", "skillId", "sha256",
  "packagePath", "manifest", "installedAt", "createdAt", "updatedAt"];

export function validateInstalledSkill(skill) {
  assertExactKeys(skill, SKILL_KEYS, "InstalledSkill");
  assertEntityHeader(skill, "InstalledSkill");
  for (const key of ["id", "actorId", "skillId"]) assertId(skill[key], "InstalledSkill." + key);
  assertSha256(skill.sha256, "InstalledSkill.sha256");
  assertPortableRelativePath(skill.packagePath, "InstalledSkill.packagePath", { prefix: "skills/packages" });
  const manifest = skill.manifest;
  assertExactKeys(manifest, ["name", "description", "entrypoint", "permissions"], "InstalledSkill.manifest");
  assertString(manifest.name, "InstalledSkill.manifest.name", { max: 256 });
  assertString(manifest.description, "InstalledSkill.manifest.description", { min: 0, max: 8192 });
  assertPortableRelativePath(manifest.entrypoint, "InstalledSkill.manifest.entrypoint", { max: 4096 });
  assertUnique(assertArray(manifest.permissions, "InstalledSkill.manifest.permissions", assertId, { max: 256 }), "InstalledSkill.manifest.permissions");
  assertIsoTimestamp(skill.installedAt, "InstalledSkill.installedAt");
  return true;
}

export function createInstalledSkill(input, options = {}) {
  assertExactKeys(input, ["id", "actorId", "skillId", "sha256", "packagePath", "manifest"], "InstalledSkillInput");
  const header = createHeader("InstalledSkill", options);
  const skill = { ...header, ...clone(input), installedAt: header.createdAt };
  validateInstalledSkill(skill);
  return deepFreeze(skill);
}
