import type { CollectionSummary, ResourceStatus } from "@/app/core/contracts";

export type LibraryCollection = CollectionSummary;

export type LibraryFile = {
  id: string;
  bindingId: string;
  name: string;
  relativePath: string;
  size: number;
  updatedAt: string;
  status: ResourceStatus;
  error?: string;
};

export type LibraryUploadFile = {
  file: File;
  relativePath: string;
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
  onDeleteFiles: (collectionId: string, files: LibraryFile[]) => void | Promise<void>;
  onUploadFiles: (collectionId: string, directory: string, files: LibraryUploadFile[]) => void | Promise<void>;
  onUploadError: (message: string) => void;
  onRetryIndex: (collectionId: string, fileId: string) => void | Promise<void>;
  onPreviewFile: (file: LibraryFile) => void;
};
