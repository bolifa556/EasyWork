"use client";

import { useImperativeHandle, type Ref } from "react";
import { useAppRuntime } from "../../runtime/AppRuntime";

export type WorkspacePreviewHandle = { requestCloseAll: (afterClose: () => void) => void };

// Workspace switches retain their draft guard while all previews share the panel in AppShell.
export function ConversationWorkspacePreview({ conversationId, ref }: { conversationId: string; ref?: Ref<WorkspacePreviewHandle> }) {
  const { requestCloseFilePreviews } = useAppRuntime();
  useImperativeHandle(ref, () => ({ requestCloseAll: (afterClose) => requestCloseFilePreviews(conversationId, afterClose) }), [conversationId, requestCloseFilePreviews]);
  return null;
}
