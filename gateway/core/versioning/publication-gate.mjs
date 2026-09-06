import { AsyncLocalStorage } from "node:async_hooks";
import { ActorMutationQueue } from "../mutation-queue.mjs";

const queue = new ActorMutationQueue();
const context = new AsyncLocalStorage();
const epochs = new Map();
export const versionScopeKey = ({ actorId, serverIdentity }) => `${actorId}\0${serverIdentity}`;
export const versionScopeEpoch = (scope) => epochs.get(versionScopeKey(scope)) || 0;
export const bumpVersionScopeEpoch = (scope) => {
  const value = versionScopeEpoch(scope) + 1;
  epochs.set(versionScopeKey(scope), value);
  return value;
};
export const inVersionScope = (scope) => context.getStore() === versionScopeKey(scope);
export function withVersionScope(scope, operation) {
  const key = versionScopeKey(scope);
  if (inVersionScope(scope)) return operation();
  return queue.run({ actorType: "version-publication", actorId: key }, () => context.run(key, operation));
}
