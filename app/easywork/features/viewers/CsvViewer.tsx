"use client";

import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Search } from "lucide-react";
import { useMemo, useState } from "react";
import type { ViewerProps } from "@/app/core/registry/viewers";
import { Button } from "../../ui/Button";
import { usePreview } from "./usePreview";
import { ViewerLoading, ViewerToolbar } from "./ViewerChrome";
import styles from "./Viewer.module.css";

const PAGE_SIZE = 100;

function parseDelimited(value: string, delimiter: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quoted) {
      if (character === '"' && value[index + 1] === '"') { cell += '"'; index += 1; }
      else if (character === '"') quoted = false;
      else cell += character;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === delimiter) { row.push(cell); cell = ""; }
    else if (character === "\n") { row.push(cell.replace(/\r$/, "")); rows.push(row); row = []; cell = ""; }
    else cell += character;
  }
  if (cell || row.length) { row.push(cell.replace(/\r$/, "")); rows.push(row); }
  return rows;
}

export default function CsvViewer({ descriptor, previewId }: ViewerProps) {
  const { value, error, loading, truncated } = usePreview(previewId);
  const [filter, setFilter] = useState("");
  const [sortColumn, setSortColumn] = useState<number | null>(null);
  const [ascending, setAscending] = useState(true);
  const [page, setPage] = useState(0);
  const rows = useMemo(() => parseDelimited(value, descriptor.extension === "tsv" ? "\t" : ","), [descriptor.extension, value]);
  const header = rows[0] || [];
  const processed = useMemo(() => {
    const needle = filter.trim().toLocaleLowerCase();
    const output = rows.slice(1).filter((row) => !needle || row.some((cell) => cell.toLocaleLowerCase().includes(needle)));
    if (sortColumn !== null) output.sort((left, right) => (left[sortColumn] || "").localeCompare(right[sortColumn] || "", undefined, { numeric: true }) * (ascending ? 1 : -1));
    return output;
  }, [ascending, filter, rows, sortColumn]);
  const pageCount = Math.max(1, Math.ceil(processed.length / PAGE_SIZE));
  const visible = processed.slice(Math.min(page, pageCount - 1) * PAGE_SIZE, (Math.min(page, pageCount - 1) + 1) * PAGE_SIZE);
  const sort = (column: number) => {
    if (sortColumn === column) setAscending((current) => !current);
    else { setSortColumn(column); setAscending(true); }
    setPage(0);
  };

  return <div className={styles.viewer}>
    <ViewerToolbar descriptor={descriptor} copyText={value}>
      <label className={styles.search}><Search size={14} /><input value={filter} placeholder="筛选表格" onChange={(event) => { setFilter(event.target.value); setPage(0); }} /></label>
      {truncated ? <span className={styles.truncatedBadge}>仅显示部分内容</span> : null}
    </ViewerToolbar>
    {loading ? <ViewerLoading label="正在读取表格" /> : error ? <div className={styles.empty}>{error}</div> : <div className={styles.tableLayout}>
      <div className={styles.tableWrap}><table className={styles.table}><thead><tr>{header.map((cell, index) => <th key={index}><button onClick={() => sort(index)}>{cell || `第 ${index + 1} 列`}{sortColumn === index ? ascending ? <ArrowUp size={13} /> : <ArrowDown size={13} /> : null}</button></th>)}</tr></thead><tbody>{visible.map((row, index) => <tr key={index}>{header.map((_, column) => <td title={row[column] || ""} key={column}>{row[column] || ""}</td>)}</tr>)}</tbody></table></div>
      <footer className={styles.tableFooter}><span>{processed.length} 行</span><Button compact iconOnly variant="ghost" aria-label="上一页" icon={<ChevronLeft size={15} />} disabled={page <= 0} onClick={() => setPage((value) => Math.max(0, value - 1))} /><span>{Math.min(page, pageCount - 1) + 1} / {pageCount}</span><Button compact iconOnly variant="ghost" aria-label="下一页" icon={<ChevronRight size={15} />} disabled={page >= pageCount - 1} onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))} /></footer>
    </div>}
  </div>;
}
