"use client";

import { FileQuestion } from "lucide-react";
import type { ViewerProps } from "@/app/core/registry/viewers";
import { ViewerToolbar } from "./ViewerChrome";
import styles from "./Viewer.module.css";

export default function FallbackViewer({ descriptor }: ViewerProps) {
  return <div className={styles.viewer}><ViewerToolbar descriptor={descriptor} /><div className={styles.empty}><FileQuestion size={28} /><strong>此格式不能安全地在网页中预览</strong><span>{descriptor.mime || "未知文件类型"}</span></div></div>;
}
