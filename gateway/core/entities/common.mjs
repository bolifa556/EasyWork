import { invariant } from "../errors.mjs";
import { normalizeRevision } from "../revision.mjs";

export const ENTITY_SCHEMA_VERSION = 1;

export function assertRecord(value, field = "entity") {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), "ENTITY_OBJECT_REQUIRED", `${field} 必须是对象`, { status: 400 });
  return value;
}

export function assertExactKeys(value, allowedKeys, field = "entity") {
  assertRecord(value, field);
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  invariant(unknown.length === 0, "ENTITY_UNKNOWN_FIELD", `${field} 包含未定义字段`, {
    status: 400,
    details: { field, unknown },
  });
  return value;
}

export function assertString(value, field, options = {}) {
  invariant(typeof value === "string", "ENTITY_STRING_REQUIRED", `${field} 必须是字符串`, { status: 400 });
  if (options.trim !== false) {
    invariant(value === value.trim(), "ENTITY_STRING_FORMAT_INVALID", `${field} 不能包含首尾空白`, { status: 400 });
  }
  const result = value;
  const min = options.min ?? 1;
  const max = options.max ?? 4096;
  invariant(result.length >= min && result.length <= max, "ENTITY_STRING_LENGTH_INVALID", `${field} 长度无效`, {
    status: 400,
    details: { field, min, max },
  });
  if (options.pattern) {
    invariant(options.pattern.test(result), "ENTITY_STRING_FORMAT_INVALID", `${field} 格式无效`, { status: 400 });
  }
  return result;
}

export function assertNullableString(value, field, options = {}) {
  if (value === null) return null;
  return assertString(value, field, options);
}

export function assertPortableRelativePath(value, field, options = {}) {
  const result = assertString(value, field, { max: options.max ?? 32768 });
  invariant(!result.includes("\\") && !result.startsWith("/") && !/^[A-Za-z]:/.test(result), "ENTITY_PATH_NOT_RELATIVE", `${field} 必须是使用 / 的相对路径`, { status: 400 });
  const segments = result.split("/");
  invariant(segments.every((segment) => segment && segment !== "." && segment !== ".." && !segment.includes("\0")), "ENTITY_PATH_TRAVERSAL", `${field} 包含非法路径片段`, { status: 400 });
  if (options.prefix) {
    invariant(result.startsWith(`${options.prefix.replace(/\/$/, "")}/`), "ENTITY_PATH_PREFIX_INVALID", `${field} 不在规定的 Actor 数据目录内`, {
      status: 400,
      details: { field, requiredPrefix: options.prefix },
    });
  }
  return result;
}

export function assertId(value, field = "id") {
  return assertString(value, field, {
    max: 256,
    pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
  });
}

export function assertNullableId(value, field) {
  if (value === null) return null;
  return assertId(value, field);
}

export function assertServerIdentity(value, field = "serverIdentity") {
  return assertString(value, field, {
    min: 47,
    max: 47,
    pattern: /^ssh_[A-Za-z0-9_-]{43}$/,
  });
}

export function assertNullableServerIdentity(value, field = "serverIdentity") {
  if (value === null) return null;
  return assertServerIdentity(value, field);
}

export function assertEnum(value, values, field) {
  invariant(values.includes(value), "ENTITY_ENUM_INVALID", `${field} 无效`, {
    status: 400,
    details: { field, allowed: values },
  });
  return value;
}

export function assertInteger(value, field, options = {}) {
  invariant(Number.isSafeInteger(value), "ENTITY_INTEGER_REQUIRED", `${field} 必须是安全整数`, { status: 400 });
  const min = options.min ?? Number.MIN_SAFE_INTEGER;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;
  invariant(value >= min && value <= max, "ENTITY_INTEGER_RANGE_INVALID", `${field} 超出范围`, {
    status: 400,
    details: { field, min, max },
  });
  return value;
}

export function assertBoolean(value, field) {
  invariant(typeof value === "boolean", "ENTITY_BOOLEAN_REQUIRED", `${field} 必须是布尔值`, { status: 400 });
  return value;
}

export function assertArray(value, field, itemValidator, options = {}) {
  invariant(Array.isArray(value), "ENTITY_ARRAY_REQUIRED", `${field} 必须是数组`, { status: 400 });
  const min = options.min ?? 0;
  const max = options.max ?? 10000;
  invariant(value.length >= min && value.length <= max, "ENTITY_ARRAY_LENGTH_INVALID", `${field} 数量无效`, {
    status: 400,
    details: { field, min, max },
  });
  return value.map((item, index) => itemValidator(item, `${field}[${index}]`));
}

export function assertUnique(values, field, key = (value) => value) {
  const keys = values.map(key);
  invariant(new Set(keys).size === keys.length, "ENTITY_DUPLICATE_VALUE", `${field} 不能包含重复项`, { status: 400 });
  return values;
}

export function assertSha256(value, field, options = {}) {
  if (options.nullable && value === null) return null;
  return assertString(value, field, { min: 64, max: 64, pattern: /^[a-f0-9]{64}$/ });
}

export function assertIsoTimestamp(value, field) {
  const result = assertString(value, field, { max: 64 });
  const timestamp = Date.parse(result);
  invariant(Number.isFinite(timestamp) && new Date(timestamp).toISOString() === result, "ENTITY_TIMESTAMP_INVALID", `${field} 必须是 UTC ISO 时间`, { status: 400 });
  return result;
}

export function timestamp(options = {}) {
  const value = (options.clock || (() => new Date()))();
  const date = value instanceof Date ? value : new Date(value);
  invariant(Number.isFinite(date.getTime()), "ENTITY_CLOCK_INVALID", "clock 返回了无效时间", { status: 500, expose: false });
  return date.toISOString();
}

export function assertEntityHeader(entity, kind) {
  invariant(entity.schemaVersion === ENTITY_SCHEMA_VERSION, "ENTITY_SCHEMA_VERSION_INVALID", `${kind}.schemaVersion 无效`, { status: 400 });
  invariant(entity.entityType === kind, "ENTITY_TYPE_INVALID", `实体类型必须是 ${kind}`, { status: 400 });
  normalizeRevision(entity.revision, `${kind}.revision`);
  assertIsoTimestamp(entity.createdAt, `${kind}.createdAt`);
  assertIsoTimestamp(entity.updatedAt, `${kind}.updatedAt`);
  invariant(entity.updatedAt >= entity.createdAt, "ENTITY_TIMESTAMP_ORDER_INVALID", `${kind}.updatedAt 不能早于 createdAt`, { status: 400 });
}

export function createHeader(entityType, options = {}) {
  const now = timestamp(options);
  return {
    schemaVersion: ENTITY_SCHEMA_VERSION,
    entityType,
    revision: 0,
    createdAt: now,
    updatedAt: now,
  };
}

export function revisedHeader(entity, expectedRevision, options = {}) {
  const actual = normalizeRevision(entity.revision);
  invariant(expectedRevision !== undefined && expectedRevision !== null, "EXPECTED_REVISION_REQUIRED", "写操作必须提供 expectedRevision", { status: 428 });
  const expected = normalizeRevision(expectedRevision, "expectedRevision");
  invariant(actual === expected, "REVISION_CONFLICT", "数据已被其他操作更新", {
    status: 409,
    details: { expectedRevision: expected, actualRevision: actual },
  });
  return {
    schemaVersion: entity.schemaVersion,
    entityType: entity.entityType,
    revision: actual + 1,
    createdAt: entity.createdAt,
    updatedAt: timestamp(options),
  };
}

export function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
}

export function clone(value) {
  return structuredClone(value);
}
