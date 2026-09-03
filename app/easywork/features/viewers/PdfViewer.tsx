"use client";

import { ChevronLeft, ChevronRight, Minus, Plus, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFRenderTask } from "pdfjs-dist";
import type { ViewerProps } from "@/app/core/registry/viewers";
import { Button } from "../../ui/Button";
import { usePreviewObjectUrl } from "./usePreview";
import { ViewerLoading, ViewerToolbar } from "./ViewerChrome";
import styles from "./Viewer.module.css";

const PDF_CMAP_URL = "/pdfjs/cmaps/";
const PDF_FALLBACK_FONT_FAMILIES = ["STSong", "AdobeSongStd", "MSung", "HeiseiMin", "HeiseiKakuGo", "HYSMyeongJo", "HYGoThic"];

async function loadPdfFallbackFonts() {
  if (typeof document === "undefined" || !document.fonts) return;
  await Promise.allSettled(PDF_FALLBACK_FONT_FAMILIES.map((family) => document.fonts.load(`16px "${family}"`)));
}

export default function PdfViewer({ descriptor, previewId }: ViewerProps) {
  const { value, error, loading } = usePreviewObjectUrl(previewId, descriptor);
  const [documentProxy, setDocumentProxy] = useState<PDFDocumentProxy | null>(null);
  const [documentError, setDocumentError] = useState<string | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [viewportWidth, setViewportWidth] = useState(0);
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width || 0;
      setViewportWidth((current) => Math.abs(current - width) > 1 ? width : current);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [documentProxy]);

  useEffect(() => {
    if (!value) return;
    let active = true;
    let task: PDFDocumentLoadingTask | null = null;
    void loadPdfFallbackFonts().then(() => import("pdfjs-dist/webpack.mjs")).then((pdfjs) => {
      if (!active) return null;
      task = pdfjs.getDocument({
        url: value,
        cMapUrl: PDF_CMAP_URL,
        cMapPacked: true,
        useSystemFonts: false,
      });
      return task.promise;
    }).then((document) => {
      if (active && document) setDocumentProxy(document);
    }).catch((reason: unknown) => {
      if (active) setDocumentError(reason instanceof Error ? reason.message : "PDF 文件无法解析");
    });
    return () => {
      active = false;
      void task?.destroy();
    };
  }, [value]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!documentProxy || !canvas || viewportWidth <= 0) return;
    let active = true;
    let renderTask: PDFRenderTask | null = null;
    void documentProxy.getPage(pageNumber).then((page) => {
      if (!active) return null;
      const natural = page.getViewport({ scale: 1 });
      const fitScale = Math.max(0.25, (viewportWidth - 28) / natural.width);
      const viewport = page.getViewport({ scale: fitScale * zoom });
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("浏览器无法创建 PDF 画布");
      canvas.width = Math.max(1, Math.floor(viewport.width * pixelRatio));
      canvas.height = Math.max(1, Math.floor(viewport.height * pixelRatio));
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      renderTask = page.render({
        canvasContext: context,
        viewport,
        transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0],
      });
      return renderTask.promise;
    }).catch((reason: unknown) => {
      if (active && !(reason instanceof Error && reason.name === "RenderingCancelledException")) {
        setDocumentError(reason instanceof Error ? reason.message : "PDF 页面渲染失败");
      }
    });
    return () => {
      active = false;
      renderTask?.cancel();
    };
  }, [documentProxy, pageNumber, viewportWidth, zoom]);

  const pending = loading || Boolean(value && !documentProxy && !documentError);
  const shownError = error || documentError;
  return <div className={styles.viewer}>
    <ViewerToolbar descriptor={descriptor}>
      {documentProxy ? <>
        <Button compact iconOnly variant="ghost" aria-label="上一页" icon={<ChevronLeft size={15} />} disabled={pageNumber <= 1} onClick={() => setPageNumber((page) => Math.max(1, page - 1))} />
        <span className={styles.zoom}>{pageNumber} / {documentProxy.numPages}</span>
        <Button compact iconOnly variant="ghost" aria-label="下一页" icon={<ChevronRight size={15} />} disabled={pageNumber >= documentProxy.numPages} onClick={() => setPageNumber((page) => Math.min(documentProxy.numPages, page + 1))} />
        <Button compact iconOnly variant="ghost" aria-label="缩小" icon={<Minus size={15} />} disabled={zoom <= 0.5} onClick={() => setZoom((value) => Math.max(0.5, value - 0.25))} />
        <span className={styles.zoom}>{Math.round(zoom * 100)}%</span>
        <Button compact iconOnly variant="ghost" aria-label="放大" icon={<Plus size={15} />} disabled={zoom >= 3} onClick={() => setZoom((value) => Math.min(3, value + 0.25))} />
        <Button compact iconOnly variant="ghost" aria-label="适合窗口" icon={<RotateCcw size={15} />} disabled={zoom === 1} onClick={() => setZoom(1)} />
      </> : null}
    </ViewerToolbar>
    {pending ? <ViewerLoading label="正在读取 PDF" /> : shownError ? <div className={styles.empty}>{shownError}</div> : documentProxy ? <div ref={viewportRef} className={styles.pdfWrap}><canvas ref={canvasRef} className={styles.pdfCanvas} role="img" aria-label={`${descriptor.name} 第 ${pageNumber} 页`} /></div> : null}
  </div>;
}
