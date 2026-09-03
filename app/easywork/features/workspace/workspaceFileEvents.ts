export const WORKSPACE_FILES_CHANGED_EVENT = "easywork:workspace-files-changed";

export type WorkspaceFilesChangedDetail = {
  serverId: string;
  workspaceId: string;
};

const workspaceRevisions = new Map<string, number>();

function workspaceKey(detail: WorkspaceFilesChangedDetail) {
  return `${detail.serverId}:${detail.workspaceId}`;
}

export function workspaceFilesRevision(detail: WorkspaceFilesChangedDetail) {
  return workspaceRevisions.get(workspaceKey(detail)) || 0;
}

export function announceWorkspaceFilesChanged(detail: WorkspaceFilesChangedDetail) {
  workspaceRevisions.set(workspaceKey(detail), workspaceFilesRevision(detail) + 1);
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<WorkspaceFilesChangedDetail>(WORKSPACE_FILES_CHANGED_EVENT, { detail }));
}
