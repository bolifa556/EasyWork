"use client";

import { Check, Copy, LoaderCircle } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { FileDescriptor } from "@/app/core/registry/viewers";
import { Button } from "../../ui/Button";
import styles from "./Viewer.module.css";

function humanSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${Math.ceil(size / 1024)} KB`;
  return `${(size / 1024 ** 2).toFixed(1)} MB`;
}

export function ViewerToolbar({ descriptor, copyText, children }: { descriptor: FileDescriptor; copyText?: string; children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (copyText === undefined) return;
    await navigator.clipboard.writeText(copyText);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_200);
  };
  return <div className={styles.toolbar}><span className={styles.title}>{descriptor.name}<small>{humanSize(descriptor.size)}</small></span><span className={styles.toolbarSpacer} />{children}{copyText !== undefined ? <Button compact variant="ghost" icon={copied ? <Check size={15} /> : <Copy size={15} />} onClick={() => void copy()}>{copied ? "已复制" : "复制"}</Button> : null}</div>;
}

export function ViewerLoading({ label = "正在读取文件" }: { label?: string }) {
  return <div className={styles.empty}><LoaderCircle className={styles.spin} size={22} /><span>{label}</span></div>;
}
