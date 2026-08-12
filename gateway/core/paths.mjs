import path from "node:path";

import { actorStorageType } from "./actor.mjs";
import { invariant } from "./errors.mjs";

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function actorDataRoot(dataRoot, actor) {
  invariant(typeof dataRoot === "string" && path.isAbsolute(dataRoot), "DATA_ROOT_INVALID", "dataRoot 必须是绝对路径", { status: 500, expose: false });
  const root = path.resolve(dataRoot);
  const candidate = path.resolve(root, actorStorageType(actor), actor.actorId);
  invariant(isWithin(root, candidate), "ACTOR_PATH_INVALID", "Actor 数据路径越界", { status: 500, expose: false });
  return candidate;
}

export function resolveActorPath(dataRoot, actor, ...segments) {
  const root = actorDataRoot(dataRoot, actor);
  invariant(segments.length > 0, "ACTOR_RELATIVE_PATH_REQUIRED", "必须提供 Actor 相对路径", { status: 500, expose: false });
  for (const segment of segments.flat()) {
    invariant(typeof segment === "string" && segment.length > 0 && !path.isAbsolute(segment) && !segment.includes("\0"), "ACTOR_RELATIVE_PATH_INVALID", "Actor 相对路径无效", { status: 500, expose: false });
  }
  const candidate = path.resolve(root, ...segments.flat());
  invariant(isWithin(root, candidate), "ACTOR_PATH_ESCAPE", "Actor 相对路径不能逃逸用户目录", { status: 500, expose: false });
  return candidate;
}

export function actorPathLayout(dataRoot, actor) {
  const root = actorDataRoot(dataRoot, actor);
  const names = [
    "profile",
    "preferences",
    "state",
    "credentials",
    "conversations",
    "projects",
    "memory",
    "resources",
    "skills",
    "workspaces",
    "tasks",
    "artifacts",
    "scheduler",
    "runtime",
    "audit",
  ];
  return Object.freeze(Object.fromEntries([["root", root], ...names.map((name) => [name, path.join(root, name)])]));
}

export function assertActorOwnedPath(dataRoot, actor, candidatePath) {
  const root = actorDataRoot(dataRoot, actor);
  const candidate = path.resolve(candidatePath);
  invariant(isWithin(root, candidate), "ACTOR_PATH_FORBIDDEN", "路径不属于当前 Actor", { status: 403 });
  return candidate;
}
