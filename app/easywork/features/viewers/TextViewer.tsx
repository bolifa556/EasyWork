"use client";

import { Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { ViewerProps } from "@/app/core/registry/viewers";
import { Button } from "../../ui/Button";
import { MarkdownCodeBlock } from "../conversation/MarkdownContent";
import { usePreview } from "./usePreview";
import { ViewerLoading, ViewerToolbar } from "./ViewerChrome";
import styles from "./Viewer.module.css";

export default function TextViewer({ descriptor, previewId }: ViewerProps) {
  const { value, error, loading, truncated } = usePreview(previewId);
  const [search, setSearch] = useState("");
  const lines = useMemo(() => value.split("\n"), [value]);
  const normalized = search.trim().toLocaleLowerCase();
  const matches = useMemo(() => normalized ? lines.reduce<number[]>((output, line, index) => {
    if (line.toLocaleLowerCase().includes(normalized)) output.push(index);
    return output;
  }, []) : [], [lines, normalized]);

  return <div className={styles.viewer}>
    <ViewerToolbar descriptor={descriptor} copyText={value}>
      <label className={styles.search}><Search size={14} /><input value={search} placeholder="在文件中查找" onChange={(event) => setSearch(event.target.value)} />{search ? <Button compact iconOnly variant="ghost" aria-label="清除搜索" icon={<X size={14} />} onClick={() => setSearch("")} /> : null}</label>
      {search ? <span className={styles.matchCount}>{matches.length} 处</span> : null}
      {truncated ? <span className={styles.truncatedBadge}>仅显示部分内容</span> : null}
    </ViewerToolbar>
    {loading ? <ViewerLoading /> : error ? <div className={styles.empty}>{error}</div> : <div className={`${styles.content} ${styles.codePreview}`}><MarkdownCodeBlock source={value} copy={false} viewportClassName={styles.fileCode}><code>{lines.map((line, index) => <span id={`${previewId}-line-${index + 1}`} className={`${styles.codeLine} ${matches.includes(index) ? styles.matchedLine : ""}`} key={index}><a href={`#${previewId}-line-${index + 1}`} aria-label={`第 ${index + 1} 行`}>{index + 1}</a><span>{line || " "}</span></span>)}</code></MarkdownCodeBlock></div>}
  </div>;
}
