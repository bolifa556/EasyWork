import { Copy, LoaderCircle } from "lucide-react";
import styles from "./AppShell.module.css";

export type ConversationCopyMode = "reference" | "body" | "all";

export function ConversationCopyMenu({ copying, onCopy }: { copying: ConversationCopyMode | null; onCopy: (mode: ConversationCopyMode) => void }) {
  return <>
    <button type="button" disabled={Boolean(copying)} onClick={() => onCopy("reference")}>
      {copying === "reference" ? <LoaderCircle className={styles.spin} size={16} /> : <Copy size={16} />}复制对话
    </button>
    <button type="button" disabled={Boolean(copying)} onClick={() => onCopy("body")}>
      {copying === "body" ? <LoaderCircle className={styles.spin} size={16} /> : <Copy size={16} />}仅复制正文为 Markdown
    </button>
    <button type="button" disabled={Boolean(copying)} onClick={() => onCopy("all")}>
      {copying === "all" ? <LoaderCircle className={styles.spin} size={16} /> : <Copy size={16} />}复制全部内容为Markdown
    </button>
  </>;
}
