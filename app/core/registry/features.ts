import type { ComponentType, LazyExoticComponent } from "react";
import { lazy } from "react";
import type { ServerCapabilityProfile } from "../contracts";

export type FeatureId =
  | "admin"
  | "library"
  | "skills"
  | "help"
  | "servers"
  | "agents"
  | "workspaces"
  | "remote-files"
  | "terminal"
  | "git"
  | "tasks"
  | "artifacts"
  | "hpc";

export type FeatureContext = {
  mode: "chat" | "work";
  isAdmin: boolean;
  serverCapabilities?: ServerCapabilityProfile;
};

export type FeatureDefinition<Props extends object = Record<string, never>> = {
  id: FeatureId;
  surface: "left" | "main" | "right" | "bottom" | "top" | "modal";
  route?: string;
  available: (context: FeatureContext) => boolean;
  load: () => Promise<{ default: ComponentType<Props> }>;
};

export const featureRegistry: Partial<Record<FeatureId, FeatureDefinition<Record<string, never>>>> = {};

export function featureCapability(featureId: FeatureId, context: FeatureContext): { available: boolean; reason: string | null } {
  const profile = context.serverCapabilities;
  if (!profile) {
    const serverFeature = ["agents", "workspaces", "remote-files", "terminal", "git", "artifacts", "hpc"].includes(featureId);
    return { available: !serverFeature, reason: serverFeature ? "尚未检测服务器能力" : null };
  }
  const capability = featureId === "remote-files" ? profile.features.remoteFiles
    : featureId === "terminal" ? profile.features.terminal
      : featureId === "workspaces" ? profile.features.workspaces
      : featureId === "git" ? profile.features.versioning
        : featureId === "hpc" ? profile.features.scheduler
          : featureId === "artifacts" ? profile.features.artifacts
            : featureId === "agents" ? profile.features.agents
              : null;
  return capability ? { available: capability.available, reason: capability.reason } : { available: true, reason: null };
}

export function isFeatureAvailable(featureId: FeatureId, context: FeatureContext) {
  const registered = featureRegistry[featureId];
  return featureCapability(featureId, context).available && (registered?.available(context) ?? true);
}

export function registerFeature<Props extends object>(definition: FeatureDefinition<Props>) {
  featureRegistry[definition.id] = definition as FeatureDefinition<Record<string, never>>;
}

export function lazyFeature<Props extends object>(definition: FeatureDefinition<Props>): LazyExoticComponent<ComponentType<Props>> {
  registerFeature(definition);
  return lazy(definition.load);
}
