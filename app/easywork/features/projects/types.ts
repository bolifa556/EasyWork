import type {
  CollectionSummary,
  ConversationSummary,
  Mode,
  ProjectSummary,
  ResourceStatus,
} from "@/app/core/contracts";

export type ProjectFile = {
  id: string;
  name: string;
  relativePath: string;
  size: number;
  updatedAt: string;
  status: ResourceStatus;
  error?: string;
};

export type ProjectPageProps = {
  project: ProjectSummary;
  conversations: ConversationSummary[];
  files: ProjectFile[];
  collections: CollectionSummary[];
  linkedCollectionIds: string[];
  loading?: boolean;
  busyAction?: string | null;
  initialTab?: "conversations" | "files" | "collections";
  onOpenConversation: (conversationId: string) => void;
  onCreateConversation: (mode: Mode) => void;
  onMemoryModeChange: (mode: ProjectSummary["memoryMode"]) => void | Promise<void>;
  onUploadFiles: (files: File[]) => void | Promise<void>;
  onRetryFile: (fileId: string) => void | Promise<void>;
  onLinkCollection: (collectionId: string) => void | Promise<void>;
  onUnlinkCollection: (collectionId: string) => void | Promise<void>;
};
