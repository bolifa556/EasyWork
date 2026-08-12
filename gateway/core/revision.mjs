import { ApiError, invariant } from "./errors.mjs";

export function normalizeRevision(value, field = "revision") {
  const revision = Number(value);
  invariant(Number.isSafeInteger(revision) && revision >= 0, "REVISION_INVALID", `${field} 必须是非负安全整数`, { status: 400 });
  return revision;
}

export function assertExpectedRevision(actualRevision, expectedRevision) {
  const actual = normalizeRevision(actualRevision, "revision");
  invariant(expectedRevision !== undefined && expectedRevision !== null, "EXPECTED_REVISION_REQUIRED", "写操作必须提供 expectedRevision", { status: 428 });
  const expected = normalizeRevision(expectedRevision, "expectedRevision");
  if (actual !== expected) {
    throw new ApiError("REVISION_CONFLICT", "数据已被其他操作更新", {
      status: 409,
      details: { expectedRevision: expected, actualRevision: actual },
    });
  }
  return actual;
}

export function nextRevision(actualRevision, expectedRevision) {
  return assertExpectedRevision(actualRevision, expectedRevision) + 1;
}
