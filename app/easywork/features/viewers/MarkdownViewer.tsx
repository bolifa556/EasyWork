"use client";

import { Code2, Eye } from "lucide-react";
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { MarkdownCodeBlock, nodeText } from "../conversation/MarkdownContent";
import type { ViewerProps } from "@/app/core/registry/viewers";
import { Button } from "../../ui/Button";
import { usePreview } from "./usePreview";
import { ViewerLoading, ViewerToolbar } from "./ViewerChrome";
import styles from "./Viewer.module.css";

export default function MarkdownViewer({ descriptor, previewId }: ViewerProps) {
  const { value, error, loading, truncated } = usePreview(previewId);
  const [source, setSource] = useState(false);
  return <div className={styles.viewer}>
    <ViewerToolbar descriptor={descriptor} copyText={value}>{truncated ? <span className={styles.truncatedBadge}>仅显示部分内容</span> : null}<Button compact variant="ghost" icon={source ? <Eye size={15} /> : <Code2 size={15} />} onClick={() => setSource((current) => !current)}>{source ? "预览" : "源码"}</Button></ViewerToolbar>
    {loading ? <ViewerLoading /> : error ? <div className={styles.empty}>{error}</div> : <div className={styles.content}>{source ? <MarkdownCodeBlock source={value} copy={false} viewportClassName={styles.fileCode}><code>{value}</code></MarkdownCodeBlock> : <article className={styles.markdown}><ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]} components={{ pre: ({ children }) => <MarkdownCodeBlock source={nodeText(children)}>{children}</MarkdownCodeBlock> }}>{value}</ReactMarkdown></article>}</div>}
  </div>;
}
