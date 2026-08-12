import type { ComponentType } from "react";

export type FileDescriptor = {
  id: string;
  name: string;
  mime: string;
  size: number;
  extension: string;
  kind: "text" | "markdown" | "json" | "image" | "pdf" | "csv" | "fallback";
  safety: "text" | "image" | "document" | "binary" | "unknown";
  acceptsRange: boolean;
  maxPreviewBytes?: number;
  metadata?: Record<string, unknown>;
};

export type ViewerProps = {
  descriptor: FileDescriptor;
  previewId: string;
};

export type ViewerDefinition = {
  id: string;
  supports: (file: FileDescriptor) => number;
  load: () => Promise<{ default: ComponentType<ViewerProps> }>;
  fallback: "text" | "download" | "metadata";
};

export type PreviewDescriptorInput = {
  previewId: string;
  kind: FileDescriptor["kind"];
  name: string;
  mime: string;
  size: number;
  metadata?: Record<string, unknown>;
  delivery?: { acceptsRange?: boolean; maxBytes?: number };
};

const viewerRegistry: ViewerDefinition[] = [];
let defaultsRegistered = false;

export function registerViewer(viewer: ViewerDefinition) {
  viewerRegistry.push(viewer);
}

export function resolveViewer(file: FileDescriptor) {
  return viewerRegistry
    .map((viewer) => ({ viewer, score: viewer.supports(file) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)[0]?.viewer;
}

export function listViewers() {
  return [...viewerRegistry];
}

export function fileDescriptorFromPreview(input: PreviewDescriptorInput): FileDescriptor {
  const safety: FileDescriptor["safety"] = ["text", "markdown", "json", "csv"].includes(input.kind)
    ? "text"
    : input.kind === "image"
      ? "image"
      : input.kind === "pdf"
        ? "document"
        : "binary";
  return {
    id: input.previewId,
    name: input.name,
    mime: input.mime,
    size: input.size,
    extension: input.name.includes(".") ? input.name.split(".").at(-1)?.toLowerCase() || "" : "",
    kind: input.kind,
    safety,
    acceptsRange: Boolean(input.delivery?.acceptsRange),
    maxPreviewBytes: input.delivery?.maxBytes,
    metadata: input.metadata,
  };
}

export function registerDefaultViewers() {
  if (defaultsRegistered) return;
  defaultsRegistered = true;
  const definition = (id: string, kind: FileDescriptor["kind"], load: ViewerDefinition["load"], fallback: ViewerDefinition["fallback"]): ViewerDefinition => ({
    id,
    supports: (file) => file.kind === kind ? 100 : 0,
    load,
    fallback,
  });
  // The Gateway-sniffed kind is authoritative. The browser never upgrades an
  // unsupported binary merely because its filename has a familiar suffix.
  registerViewer(definition("markdown", "markdown", () => import("@/app/easywork/features/viewers/MarkdownViewer"), "text"));
  registerViewer(definition("json", "json", () => import("@/app/easywork/features/viewers/JsonViewer"), "text"));
  registerViewer(definition("image", "image", () => import("@/app/easywork/features/viewers/ImageViewer"), "download"));
  registerViewer(definition("pdf", "pdf", () => import("@/app/easywork/features/viewers/PdfViewer"), "download"));
  registerViewer(definition("csv", "csv", () => import("@/app/easywork/features/viewers/CsvViewer"), "text"));
  registerViewer(definition("text", "text", () => import("@/app/easywork/features/viewers/TextViewer"), "text"));
  registerViewer(definition("fallback", "fallback", () => import("@/app/easywork/features/viewers/FallbackViewer"), "metadata"));
}
