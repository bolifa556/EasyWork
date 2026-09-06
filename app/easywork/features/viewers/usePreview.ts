"use client";

import { useEffect, useState } from "react";
import type { FileDescriptor } from "@/app/core/registry/viewers";
import { useAppRuntime } from "../../runtime/AppRuntime";

const MAX_OBJECT_URL_BYTES = 16 * 1024 * 1024;

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
    void (async () => {
      if (descriptor.size > MAX_OBJECT_URL_BYTES) throw new Error("此文件需要分段渲染，当前查看器暂不支持");
      if (descriptor.size > (descriptor.maxPreviewBytes || Number.POSITIVE_INFINITY)) {
        if (!descriptor.acceptsRange || !descriptor.maxPreviewBytes) throw new Error("此文件来源不支持安全的分段预览");
        const chunks: BlobPart[] = [];
        for (let start = 0; start < descriptor.size; start += descriptor.maxPreviewBytes) {
          const endExclusive = Math.min(descriptor.size, start + descriptor.maxPreviewBytes);
          const response = await runtime.api.raw(`/api/previews/${encodeURIComponent(previewId)}/content`, {
            method: "GET",
            signal: controller.signal,
            headers: { range: `bytes=${start}-${endExclusive - 1}` },
          });
          const contentRange = response.headers.get("content-range");
          if (response.status !== 206 || contentRange !== `bytes ${start}-${endExclusive - 1}/${descriptor.size}`) {
            throw new Error("预览来源没有返回预期的分段内容");
          }
          const bytes = await response.arrayBuffer();
          if (bytes.byteLength !== endExclusive - start) throw new Error("预览分段长度不一致");
          chunks.push(bytes);
        }
        return new Blob(chunks, { type: descriptor.mime || "application/octet-stream" });
      }
      const response = await runtime.api.raw(`/api/previews/${encodeURIComponent(previewId)}/content`, {
        method: "GET",
        signal: controller.signal,
      });
      return response.blob();
    })().then((blob) => {
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
