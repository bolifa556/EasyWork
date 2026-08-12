"use client";

import { Braces } from "lucide-react";
import { useMemo } from "react";
import type { ViewerProps } from "@/app/core/registry/viewers";
import { usePreview } from "./usePreview";
import { ViewerLoading, ViewerToolbar } from "./ViewerChrome";
import styles from "./Viewer.module.css";

export default function JsonViewer({ descriptor, previewId }: ViewerProps) {
  const { value, error, loading } = usePreview(previewId, "json");
  const formatted = useMemo(() => {
    try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
  }, [value]);
  return <div className={styles.viewer}>
    <ViewerToolbar descriptor={descriptor} copyText={formatted}><span className={styles.formatBadge}><Braces size={14} />JSON</span></ViewerToolbar>
    {loading ? <ViewerLoading /> : error ? <div className={styles.empty}>{error}</div> : <div className={styles.content}><pre className={styles.text}>{formatted}</pre></div>}
  </div>;
}
