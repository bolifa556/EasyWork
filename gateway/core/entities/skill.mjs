import { invariant } from "../errors.mjs";
import {
  assertArray,
  assertBoolean,
  assertEntityHeader,
  assertExactKeys,
  assertId,
  assertIsoTimestamp,
  assertNullableId,
  assertPortableRelativePath,
  assertSha256,
  assertString,
  assertUnique,
  clone,
  createHeader,
  deepFreeze,
  revisedHeader,
} from "./common.mjs";

const SKILL_VERSION_KEYS = [
  "schemaVersion", "entityType", "revision", "id", "actorId", "skillId", "version", "sha256", "packagePath", "manifest",
  "installedAt", "createdAt", "updatedAt",
];
const SKILL_REGISTRY_KEYS = [
  "schemaVersion", "entityType", "revision", "id", "actorId", "skillId", "displayName", "description", "activeVersionId",
  "versions", "createdAt", "updatedAt",
];
const TASK_SKILL_PIN_KEYS = [
  "schemaVersion", "entityType", "revision", "id", "actorId", "taskId", "skillId", "skillVersionId", "version", "sha256",
  "mandatory", "pinnedAt", "createdAt", "updatedAt",
];

function validateManifest(manifest, field = "SkillVersion.manifest") {
  assertExactKeys(manifest, ["name", "description", "entrypoint", "permissions"], field);
  assertString(manifest.name, `${field}.name`, { max: 256 });
  assertString(manifest.description, `${field}.description`, { min: 0, max: 8192 });
  assertPortableRelativePath(manifest.entrypoint, `${field}.entrypoint`, { max: 4096 });
  assertUnique(assertArray(manifest.permissions, `${field}.permissions`, (value, itemField) => assertId(value, itemField), { max: 256 }), `${field}.permissions`);
  return true;
}

export function validateSkillVersion(skillVersion) {
  assertExactKeys(skillVersion, SKILL_VERSION_KEYS, "SkillVersion");
  assertEntityHeader(skillVersion, "SkillVersion");
  assertId(skillVersion.id, "SkillVersion.id");
  assertId(skillVersion.actorId, "SkillVersion.actorId");
  assertId(skillVersion.skillId, "SkillVersion.skillId");
  assertString(skillVersion.version, "SkillVersion.version", { max: 128 });
  assertSha256(skillVersion.sha256, "SkillVersion.sha256");
  assertPortableRelativePath(skillVersion.packagePath, "SkillVersion.packagePath", { prefix: "skills/packages" });
  validateManifest(skillVersion.manifest);
  assertIsoTimestamp(skillVersion.installedAt, "SkillVersion.installedAt");
  return true;
}

export function createSkillVersion(input, options = {}) {
  assertExactKeys(input, ["id", "actorId", "skillId", "version", "sha256", "packagePath", "manifest"], "SkillVersionInput");
  const header = createHeader("SkillVersion", options);
  const skillVersion = {
    ...header,
    ...clone(input),
    installedAt: header.createdAt,
  };
  validateSkillVersion(skillVersion);
  return deepFreeze(skillVersion);
}

export function validateSkillRegistry(registry) {
  assertExactKeys(registry, SKILL_REGISTRY_KEYS, "SkillRegistry");
  assertEntityHeader(registry, "SkillRegistry");
  assertId(registry.id, "SkillRegistry.id");
  assertId(registry.actorId, "SkillRegistry.actorId");
  assertId(registry.skillId, "SkillRegistry.skillId");
  assertString(registry.displayName, "SkillRegistry.displayName", { max: 256 });
  assertString(registry.description, "SkillRegistry.description", { min: 0, max: 8192 });
  assertNullableId(registry.activeVersionId, "SkillRegistry.activeVersionId");
  const versions = assertArray(registry.versions, "SkillRegistry.versions", (value, field) => {
    assertExactKeys(value, ["skillVersionId", "version", "sha256"], field);
    return {
      skillVersionId: assertId(value.skillVersionId, `${field}.skillVersionId`),
      version: assertString(value.version, `${field}.version`, { max: 128 }),
      sha256: assertSha256(value.sha256, `${field}.sha256`),
    };
  }, { max: 1000 });
  assertUnique(versions, "SkillRegistry.versions.skillVersionId", (value) => value.skillVersionId);
  assertUnique(versions, "SkillRegistry.versions.version", (value) => value.version);
  invariant(registry.activeVersionId === null || versions.some((value) => value.skillVersionId === registry.activeVersionId), "SKILL_ACTIVE_VERSION_UNREGISTERED", "activeVersionId 必须属于 Registry", { status: 400 });
  return true;
}

export function createSkillRegistry(input, options = {}) {
  assertExactKeys(input, ["id", "actorId", "skillId", "displayName", "description"], "SkillRegistryInput");
  const registry = {
    ...createHeader("SkillRegistry", options),
    ...clone(input),
    activeVersionId: null,
    versions: [],
  };
  validateSkillRegistry(registry);
  return deepFreeze(registry);
}

export function registerSkillVersion(registry, skillVersion, options = {}) {
  validateSkillRegistry(registry);
  validateSkillVersion(skillVersion);
  invariant(registry.actorId === skillVersion.actorId && registry.skillId === skillVersion.skillId, "SKILL_REGISTRY_OWNERSHIP_MISMATCH", "SkillVersion 不属于该 Registry", { status: 403 });
  invariant(!registry.versions.some((value) => value.skillVersionId === skillVersion.id || value.version === skillVersion.version), "SKILL_VERSION_ALREADY_REGISTERED", "SkillVersion ID 或版本号已登记", { status: 409 });
  const next = {
    ...clone(registry),
    ...revisedHeader(registry, options.expectedRevision, options),
    versions: [...registry.versions, {
      skillVersionId: skillVersion.id,
      version: skillVersion.version,
      sha256: skillVersion.sha256,
    }],
    activeVersionId: options.activate === false ? registry.activeVersionId : skillVersion.id,
  };
  validateSkillRegistry(next);
  return deepFreeze(next);
}

export function activateSkillVersion(registry, skillVersionId, options = {}) {
  validateSkillRegistry(registry);
  assertId(skillVersionId, "skillVersionId");
  invariant(registry.versions.some((value) => value.skillVersionId === skillVersionId), "SKILL_VERSION_UNREGISTERED", "只能激活已登记版本", { status: 404 });
  const next = {
    ...clone(registry),
    ...revisedHeader(registry, options.expectedRevision, options),
    activeVersionId: skillVersionId,
  };
  validateSkillRegistry(next);
  return deepFreeze(next);
}

export function validateTaskSkillPin(pin) {
  assertExactKeys(pin, TASK_SKILL_PIN_KEYS, "TaskSkillPin");
  assertEntityHeader(pin, "TaskSkillPin");
  assertId(pin.id, "TaskSkillPin.id");
  assertId(pin.actorId, "TaskSkillPin.actorId");
  assertId(pin.taskId, "TaskSkillPin.taskId");
  assertId(pin.skillId, "TaskSkillPin.skillId");
  assertId(pin.skillVersionId, "TaskSkillPin.skillVersionId");
  assertString(pin.version, "TaskSkillPin.version", { max: 128 });
  assertSha256(pin.sha256, "TaskSkillPin.sha256");
  assertBoolean(pin.mandatory, "TaskSkillPin.mandatory");
  assertIsoTimestamp(pin.pinnedAt, "TaskSkillPin.pinnedAt");
  return true;
}

export function createTaskSkillPin(input, options = {}) {
  assertExactKeys(input, ["id", "actorId", "taskId", "skillVersion", "mandatory"], "TaskSkillPinInput");
  validateSkillVersion(input.skillVersion);
  invariant(input.actorId === input.skillVersion.actorId, "SKILL_PIN_OWNERSHIP_MISMATCH", "不能固定其他用户的 Skill", { status: 403 });
  const header = createHeader("TaskSkillPin", options);
  const pin = {
    ...header,
    id: input.id,
    actorId: input.actorId,
    taskId: input.taskId,
    skillId: input.skillVersion.skillId,
    skillVersionId: input.skillVersion.id,
    version: input.skillVersion.version,
    sha256: input.skillVersion.sha256,
    mandatory: input.mandatory,
    pinnedAt: header.createdAt,
  };
  validateTaskSkillPin(pin);
  return deepFreeze(pin);
}
