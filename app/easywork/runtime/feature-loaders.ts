import type { AppView } from "./AppRuntime";

export const loadConversationView = () => import("../features/conversation/ConversationView");
export const loadLibraryView = () => import("../features/library/LibraryView");
export const loadSkillsView = () => import("../features/skills/SkillsView");
export const loadHelpView = () => import("../features/help/HelpView");
export const loadAdminView = () => import("../features/admin/AdminView");
export const loadServerManager = () => import("../features/servers/ServerManager");
export const loadProjectView = () => import("../features/projects/ProjectView");

export function preloadFeature(kind: AppView["kind"]) {
  const loader = ({ home: loadConversationView, conversation: loadConversationView,
    help: loadHelpView, library: loadLibraryView, skills: loadSkillsView,
    admin: loadAdminView, servers: loadServerManager, project: loadProjectView })[kind];
  void loader().catch(() => undefined);
}
