import type { CollectionSummary, ResourceStatus } from "@/app/core/contracts";

export type LibraryCollection = CollectionSummary;

export type LibraryFile = {
  id: string;
  name: string;
  relativePath: string;
  size: number;
  updatedAt: string;
  status: ResourceStatus;
  error?: string;
};

export type LibrarySortKey = "name" | "updatedAt" | "size";
export type SortDirection = "ascending" | "descending";

export type LibraryPageProps = {
  collections: LibraryCollection[];
  selectedCollectionId: string | null;
  files: LibraryFile[];
  loading?: boolean;
  busyAction?: string | null;
  onSelectCollection: (collectionId: string | null) => void;
  onCreateCollection: (name: string) => void | Promise<void>;
  onRenameCollection: (collectionId: string, name: string) => void | Promise<void>;
  onDeleteCollection: (collectionId: string) => void | Promise<void>;
  onUploadFiles: (collectionId: string, directory: string, files: File[]) => void | Promise<void>;
  onRetryIndex: (collectionId: string, fileId: string) => void | Promise<void>;
};
