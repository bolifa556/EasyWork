"use client";

import Image from "next/image";
import { Download, ImageOff, LoaderCircle, Maximize2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useAppRuntime } from "../../runtime/AppRuntime";
import { SERVERS_CHANGED_EVENT } from "../../runtime/cacheEvents";
import { Modal } from "../../ui/Modal";
import { createConversationImageLoader } from "./conversation-image-loader.mjs";
import styles from "./ConversationImage.module.css";

type ImageDownloadProps = { onDownload?: () => void; downloading?: boolean };

export function ConversationImage({ src, name, compact = false, loading = false, error = "", onRemove, onDownload, downloading = false, onRetry, renderFullImage }: { src?: string; name: string; compact?: boolean; loading?: boolean; error?: string; onRemove?: () => void; onRetry?: () => void; renderFullImage?: () => ReactNode } & ImageDownloadProps) {
  const [open, setOpen] = useState(false);
  const [failedSource, setFailedSource] = useState("");
  const failed = Boolean(error || (src && failedSource === src));
  return <span data-image-tile className={`${styles.tile} ${compact ? styles.compact : ""}`}>
    <button type="button" className={`${styles.thumbnail} ${loading || failed || !src ? styles.emptyThumbnail : ""}`} disabled={loading || ((!src || failed) && !onRetry)} aria-label={`${failed ? "重新加载图片" : "查看大图"}：${name}`} title={error || name} onClick={() => { if (failed || !src) onRetry?.(); else setOpen(true); }}>
      {loading ? <LoaderCircle className={styles.spin} size={compact ? 20 : 25} /> : failed ? <span className={styles.failure}><ImageOff size={22} />{!compact ? <span>{error || "图片加载失败"}{onRetry ? <small>点击重试</small> : null}</span> : null}</span> : src ? (
        // Keep authenticated blob previews in normal flow so their intrinsic ratio sizes the frame.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={name} onError={() => setFailedSource(src)} />
      ) : <span className={styles.placeholder} />}
      {src && !failed && !onDownload ? <span className={styles.expand}><Maximize2 size={14} /></span> : null}
    </button>
    {onDownload ? <button type="button" className={styles.download} aria-label={`下载 ${name}`} title="下载图片" aria-busy={downloading} disabled={downloading} onClick={(event) => { event.stopPropagation(); onDownload(); }}>{downloading ? <LoaderCircle className={styles.spin} size={17} /> : <Download size={17} />}</button> : null}
    {onRemove ? <button type="button" className={styles.remove} aria-label={`移除 ${name}`} onClick={(event) => { event.stopPropagation(); onRemove(); }}><X size={13} /></button> : null}
    {open && src ? <Modal title={name} size="wide" panelClassName={styles.lightbox} backdropClassName={styles.backdrop} bodyClassName={styles.lightboxBody} onClose={() => setOpen(false)}>
      {renderFullImage ? renderFullImage() : <Image unoptimized src={src} alt={name} width={1600} height={1200} className={styles.fullImage} />}
    </Modal> : null}
  </span>;
}

export function LocalConversationImage({ file, onRemove }: { file: File; onRemove: () => void }) {
  const [preview, setPreview] = useState<{ file: File; url: string } | null>(null);
  useEffect(() => {
    const url = URL.createObjectURL(file);
    const frame = window.requestAnimationFrame(() => setPreview({ file, url }));
    return () => { window.cancelAnimationFrame(frame); URL.revokeObjectURL(url); };
  }, [file]);
  return <ConversationImage compact name={file.name} src={preview?.file === file ? preview.url : ""} onRemove={onRemove} />;
}

type ImageSource = { kind: "resource"; resourceVersionId: string } | { kind: "artifact"; artifactId: string };

type ImageLoadState = { value: string; loading: boolean; error: string };

function useStoredImage(source: ImageSource, enabled: boolean, thumbnail: boolean) {
  const runtime = useAppRuntime();
  const loader = useRef<ReturnType<typeof createConversationImageLoader> | null>(null);
  const [result, setResult] = useState<(ImageLoadState & { key: string }) | null>(null);
  const key = JSON.stringify([runtime.bootstrap?.actor.id, source, thumbnail]);
  const connectedServers = JSON.stringify((runtime.bootstrap?.servers || []).filter((server) => server.status === "connected").map((server) => server.id).sort());
  const previousConnections = useRef(connectedServers);
  useEffect(() => {
    if (!enabled) return;
    const [, requestSource, requestThumbnail] = JSON.parse(key);
    const current = createConversationImageLoader({ api: runtime.api, source: requestSource, thumbnail: requestThumbnail,
      onState: (state: ImageLoadState) => setResult({ key, ...state }), eventTarget: window, documentTarget: document, serverEvent: SERVERS_CHANGED_EVENT });
    loader.current = current;
    return () => { current.dispose(); loader.current = null; };
  }, [enabled, key, runtime.api]);
  useEffect(() => {
    const previous = new Set(JSON.parse(previousConnections.current) as string[]);
    previousConnections.current = connectedServers;
    if ((JSON.parse(connectedServers) as string[]).some((serverId) => !previous.has(serverId))) loader.current?.recover();
  }, [connectedServers]);
  const retry = useCallback(() => loader.current?.retry(), []);
  return { ...(result?.key === key ? result : { value: "", loading: true, error: "" }), retry };
}

function OriginalImage({ source, name, fallback }: { source: ImageSource; name: string; fallback: string }) {
  const image = useStoredImage(source, true, false);
  return <>
    <Image unoptimized src={image.value || fallback} alt={name} width={1600} height={1200} className={styles.fullImage} />
    {image.loading ? <span className={styles.fullImageStatus}><LoaderCircle className={styles.spin} size={14} />正在读取原图…</span> : image.error ? <span className={styles.fullImageStatus} role="status">原图暂时无法读取，已显示缓存预览。<button type="button" onClick={image.retry}>重试</button></span> : null}
  </>;
}

export function StoredConversationImage({ source, name, onDownload, downloading }: { source: ImageSource; name: string } & ImageDownloadProps) {
  const root = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const image = useStoredImage(source, visible, source.kind === "artifact");
  useEffect(() => {
    if (!root.current) return;
    if (typeof IntersectionObserver === "undefined") {
      const frame = window.requestAnimationFrame(() => setVisible(true));
      return () => window.cancelAnimationFrame(frame);
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: "240px" });
    observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  return <span ref={root} className={styles.stored}><ConversationImage name={name} src={image.value} loading={image.loading} error={image.error} onRetry={image.retry} onDownload={onDownload} downloading={downloading} renderFullImage={source.kind === "artifact" ? () => <OriginalImage source={source} name={name} fallback={image.value} /> : undefined} /></span>;
}
