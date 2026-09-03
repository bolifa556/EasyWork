"use client";

import { useCallback, useEffect, useState } from "react";
import { FileText, LoaderCircle, RefreshCw } from "lucide-react";
import { commandId } from "@/app/core/gateway/client";
import { fileDescriptorFromPreview, registerDefaultViewers, resolveViewer } from "@/app/core/registry/viewers";
import { useAppRuntime } from "@/app/easywork/runtime/AppRuntime";
import { Button } from "@/app/easywork/ui/Button";
import { Modal } from "@/app/easywork/ui/Modal";
import type { OpenPreview, PreviewDescriptor } from "@/app/easywork/features/workbench/types";
import type { LibraryFile } from "./types";
import styles from "./LibraryFilePreview.module.css";

registerDefaultViewers();

export default function LibraryFilePreview({ file, onClose }: { file: LibraryFile; onClose: () => void }) {
  const runtime = useAppRuntime();
  const [preview, setPreview] = useState<OpenPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const dispose = useCallback((current: Pick<OpenPreview, "previewId" | "revision"> | null) => {
    if (!current) return;
    void runtime.api.delete(`/api/previews/${encodeURIComponent(current.previewId)}`, {
      expectedRevision: current.revision,
    }).catch(() => undefined);
  }, [runtime.api]);

  useEffect(() => {
    let cancelled = false;
    let created: Pick<OpenPreview, "previewId" | "revision"> | null = null;

    void runtime.api.post<PreviewDescriptor>("/api/previews", {
      source: { kind: "resource", resourceVersionId: file.id },
    }, { idempotencyKey: commandId("library-preview-create") }).then(async (result) => {
      created = result.data;
      if (cancelled) {
        dispose(created);
        return;
      }
      const descriptor = fileDescriptorFromPreview({
        previewId: result.data.previewId,
        name: result.data.name || file.name,
        mime: result.data.mime || "application/octet-stream",
        size: Number.isFinite(result.data.size) ? result.data.size : file.size,
        kind: result.data.kind,
        delivery: result.data.delivery,
        metadata: result.data.metadata,
      });
      const definition = resolveViewer(descriptor);
      if (!definition) throw new Error("没有可用的文件查看器");
      const viewer = await definition.load();
      if (cancelled) {
        dispose(created);
        return;
      }
      setPreview({
        descriptor,
        previewId: result.data.previewId,
        revision: result.data.revision,
        Viewer: viewer.default,
      });
    }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : "无法打开文件预览");
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });

    return () => {
      cancelled = true;
      dispose(created);
    };
  }, [attempt, dispose, file.id, file.name, file.size, runtime.api]);

  return (
    <Modal
      title="文件预览"
      subtitle={file.relativePath}
      size="wide"
      panelClassName={styles.panel}
      bodyClassName={styles.body}
      onClose={onClose}
    >
      {loading ? (
        <div className={styles.state}><LoaderCircle className={styles.spin} size={22} /><span>正在打开文件</span></div>
      ) : error ? (
        <div className={styles.state}>
          <FileText size={24} />
          <strong>文件预览未能打开</strong>
          <span>{error}</span>
          <Button compact icon={<RefreshCw size={15} />} onClick={() => {
            setLoading(true);
            setError(null);
            setPreview(null);
            setAttempt((value) => value + 1);
          }}>重新打开</Button>
        </div>
      ) : preview ? (
        <preview.Viewer descriptor={preview.descriptor} previewId={preview.previewId} />
      ) : null}
    </Modal>
  );
}
