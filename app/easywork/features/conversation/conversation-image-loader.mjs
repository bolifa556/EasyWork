import { readPreviewBlob } from "../viewers/preview-blob.mjs";

export function createConversationImageLoader({ api, source, thumbnail, onState, eventTarget, documentTarget, serverEvent,
  createUrl = (blob) => URL.createObjectURL(blob), revokeUrl = (url) => URL.revokeObjectURL(url) }) {
  const controller = new AbortController();
  let value = "", running = false, retryRequested = false, serverId = "";
  const run = async (force = false) => {
    if (controller.signal.aborted || (value && !force)) return;
    if (running) { retryRequested = true; return; }
    running = true;
    do {
      retryRequested = false;
      onState({ value, loading: true, error: "" });
      try {
        const { data: preview } = await api.post("/api/previews", { source, ...(thumbnail ? { variant: "thumbnail" } : {}) }, { signal: controller.signal });
        if (controller.signal.aborted) break;
        serverId = String(preview.metadata?.serverId || "");
        const blob = await readPreviewBlob(api, preview.previewId, { size: preview.size, mime: preview.mime,
          acceptsRange: preview.delivery?.acceptsRange, maxPreviewBytes: preview.delivery?.maxBytes }, controller.signal);
        if (controller.signal.aborted) break;
        const next = createUrl(blob);
        if (value) revokeUrl(value);
        value = next;
        onState({ value, loading: false, error: "" });
        retryRequested = false;
      } catch (error) {
        if (!controller.signal.aborted && !retryRequested) onState({ value, loading: false, error: error instanceof Error ? error.message : "图片读取失败" });
      }
    } while (retryRequested && !controller.signal.aborted);
    running = false;
  };
  const recover = () => { void run(); };
  const serverChanged = (event) => {
    const detail = event.detail;
    if (["connected", "binding"].includes(detail?.kind) && (!serverId || serverId === detail.serverId)) recover();
  };
  const visible = () => { if (documentTarget?.visibilityState === "visible") recover(); };
  eventTarget?.addEventListener(serverEvent, serverChanged);
  eventTarget?.addEventListener("online", recover);
  eventTarget?.addEventListener("focus", recover);
  documentTarget?.addEventListener("visibilitychange", visible);
  queueMicrotask(recover);
  return {
    retry: () => { void run(true); },
    recover,
    dispose() {
      controller.abort();
      eventTarget?.removeEventListener(serverEvent, serverChanged);
      eventTarget?.removeEventListener("online", recover);
      eventTarget?.removeEventListener("focus", recover);
      documentTarget?.removeEventListener("visibilitychange", visible);
      if (value) revokeUrl(value);
    },
  };
}
