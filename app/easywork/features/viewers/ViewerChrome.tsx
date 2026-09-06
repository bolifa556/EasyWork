"use client";

import { Undo2, Check, Copy, LoaderCircle } from "lucide-react";
import { createContext, useContext, useState, type ReactNode } from "react";
import type { FileDescriptor } from "@/app/core/registry/viewers";
import { Button } from "../../ui/Button";
import styles from "./Viewer.module.css";

const ViewerActionsContext = createContext<{ onBack?: () => void; actions?: ReactNode; serverName?: string }>({});

export function ViewerActions({ onBack, actions, serverName, children }: { onBack?: () => void; actions?: ReactNode; serverName?: string; children: ReactNode }) {
  const inherited = useContext(ViewerActionsContext);
  return <ViewerActionsContext.Provider value={{ onBack: onBack ?? inherited.onBack, actions: actions ?? inherited.actions, serverName: serverName ?? inherited.serverName }}>{children}</ViewerActionsContext.Provider>;
}

export function ViewerToolbar({ descriptor, copyText, children }: { descriptor: FileDescriptor; copyText?: string; children?: ReactNode }) {
  const { onBack, actions, serverName } = useContext(ViewerActionsContext);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (copyText === undefined) return;
    await navigator.clipboard.writeText(copyText);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_200);
  };
  return <div className={styles.toolbar} role="toolbar" aria-label="文件操作">
    <span className={styles.title}>
      <span className={styles.filename}>{descriptor.name}</span>
      {serverName ? <span className={styles.serverName} aria-label={"服务器：" + serverName}>· {serverName}</span> : null}
    </span>
    <span className={styles.toolbarSpacer} />
    {children}{actions}
    {copyText !== undefined ? <Button compact variant="ghost" aria-label={copied ? "已复制" : "复制"} icon={copied ? <Check size={15} /> : <Copy size={15} />} onClick={() => void copy()}>{copied ? "已复制" : "复制"}</Button> : null}
    {onBack ? <Button className={styles.backButton} compact variant="ghost" aria-label="返回" icon={<Undo2 size={16} strokeWidth={1.8} />} onClick={onBack}><span className={styles.backLabel}>返回</span></Button> : null}
  </div>;
}

export function ViewerLoading({ label = "正在读取文件" }: { label?: string }) {
  return <div className={styles.empty}><LoaderCircle className={styles.spin} size={22} /><span>{label}</span></div>;
}
