"use client";

import type { ViewerProps } from "@/app/core/registry/viewers";
import { usePreviewObjectUrl } from "./usePreview";
import { ViewerLoading, ViewerToolbar } from "./ViewerChrome";
import styles from "./Viewer.module.css";

export default function PdfViewer({ descriptor, previewId }: ViewerProps) {
  const { value, error, loading } = usePreviewObjectUrl(previewId, descriptor);
  return <div className={styles.viewer}><ViewerToolbar descriptor={descriptor} />{loading ? <ViewerLoading label="正在读取 PDF" /> : error ? <div className={styles.empty}>{error}</div> : value ? <iframe className={styles.frame} title={descriptor.name} src={value} /> : null}</div>;
}
