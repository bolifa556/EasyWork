import { invariant } from "./errors.mjs";

const ACTOR_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ROLE_PATTERN = /^[a-z][a-z0-9:_-]{0,63}$/;

function uniqueStrings(values) {
  return [...new Set((values || []).map(String))];
}

export function createActorContext(input) {
  const actorType = String(input?.actorType || "");
  const actorId = String(input?.actorId || "");
  invariant(["user", "guest"].includes(actorType), "ACTOR_TYPE_INVALID", "actorType 必须是 user 或 guest", { status: 401 });
  invariant(ACTOR_ID_PATTERN.test(actorId), "ACTOR_ID_INVALID", "actorId 格式无效", { status: 401 });
  const roles = uniqueStrings(input?.roles || []);
  invariant(roles.every((role) => ROLE_PATTERN.test(role)), "ACTOR_ROLE_INVALID", "Actor role 格式无效", { status: 401 });
  const sessionId = String(input?.sessionId || "");
  const deviceId = String(input?.deviceId || "");
  invariant(ACTOR_ID_PATTERN.test(sessionId), "SESSION_ID_INVALID", "sessionId 格式无效", { status: 401 });
  invariant(ACTOR_ID_PATTERN.test(deviceId), "DEVICE_ID_INVALID", "deviceId 格式无效", { status: 401 });

  return Object.freeze({
    actorType,
    actorId,
    userId: actorType === "user" ? actorId : null,
    deviceId,
    sessionId,
    roles: Object.freeze(roles),
  });
}

export function actorStorageType(actor) {
  invariant(actor?.actorType === "user" || actor?.actorType === "guest", "ACTOR_CONTEXT_REQUIRED", "需要有效 ActorContext", { status: 401 });
  return actor.actorType === "user" ? "users" : "guests";
}

export function requireAuthenticatedActor(actor) {
  invariant(actor?.actorType === "user" && actor?.userId, "AUTHENTICATION_REQUIRED", "该操作需要登录", { status: 401 });
  return actor;
}

export function requireRole(actor, role) {
  invariant(actor?.roles?.includes(role), "ROLE_REQUIRED", "当前账号无权执行该操作", {
    status: 403,
    details: { requiredRole: role },
  });
  return actor;
}
