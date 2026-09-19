"use client";

import { useEffect, useState } from "react";
import type { FileDescriptor } from "@/app/core/registry/viewers";
import { useAppRuntime } from "../../runtime/AppRuntime";
import { readPreviewBlob } from "./preview-blob.mjs";

export function usePreview(previewId: string, kind: "text" | "json" = "text") {
  const runtime = useAppRuntime();
  const requestKey = `${previewId}:${kind}`;
  const [result, setResult] = useState<{ key: string; value: string; error: string | null; loading: boolean; truncated: boolean }>({
    key: requestKey,
    value: "",
    error: null,
    loading: true,
    truncated: false,
  });
  useEffect(() => {
    const controller = new AbortController();
    void runtime.api.raw(`/api/previews/${encodeURIComponent(previewId)}/content`, {
      method: "GET",
      signal: controller.signal,
      headers: { accept: kind === "json" ? "application/json" : "text/plain" },
    }).then(async (response) => ({ value: await response.text(), truncated: response.headers.get("x-preview-truncated") === "1" })).then(({ value, truncated }) => {
      if (controller.signal.aborted) return;
      setResult({ key: requestKey, value, error: null, loading: false, truncated });
    }).catch((reason) => {
      if (!controller.signal.aborted) {
        setResult({
          key: requestKey,
          value: "",
          error: reason instanceof Error ? reason.message : "无法读取预览内容",
          loading: false,
          truncated: false,
        });
      }
    });
    return () => controller.abort();
  }, [kind, previewId, requestKey, runtime.api]);
  return result.key === requestKey ? result : { key: requestKey, value: "", error: null, loading: true, truncated: false };
}

export function usePreviewObjectUrl(previewId: string, descriptor: FileDescriptor) {
  const runtime = useAppRuntime();
  const [result, setResult] = useState<{ key: string; value: string; error: string | null; loading: boolean }>({
    key: previewId,
    value: "",
    error: null,
    loading: true,
  });
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl = "";
    void readPreviewBlob(runtime.api, previewId, { size: descriptor.size, mime: descriptor.mime, acceptsRange: descriptor.acceptsRange, maxPreviewBytes: descriptor.maxPreviewBytes }, controller.signal).then((blob) => {
      if (controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob);
      setResult({ key: previewId, value: objectUrl, error: null, loading: false });
    }).catch((reason) => {
      if (!controller.signal.aborted) {
        setResult({
          key: previewId,
          value: "",
          error: reason instanceof Error ? reason.message : "无法读取预览内容",
          loading: false,
        });
      }
    });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [descriptor.acceptsRange, descriptor.maxPreviewBytes, descriptor.mime, descriptor.size, previewId, runtime.api]);
  return result.key === previewId ? result : { key: previewId, value: "", error: null, loading: true };
}
