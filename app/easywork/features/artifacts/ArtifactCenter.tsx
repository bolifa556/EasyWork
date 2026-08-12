"use client";

import { Archive, Download } from "lucide-react";
import { useEffect, useState } from "react";
import { useAppRuntime } from "../../runtime/AppRuntime";
import { Button } from "../../ui/Button";
import { PageFrame } from "../../ui/PageFrame";
import styles from "./ArtifactCenter.module.css";

type Artifact = { id: string; name: string; kind: string; size: number | null; createdAt: string; lifecycle: string; pinned: boolean };

export default function ArtifactCenter() {
  const runtime = useAppRuntime();
  const [items, setItems] = useState<Artifact[]>([]);
  useEffect(() => { void runtime.api.get<{ items: Artifact[] }>("/api/artifacts?limit=100").then((result) => setItems(result.data.items)).catch(() => undefined); }, [runtime.api]);
  const download = async (item: Artifact) => {
    try {
      const issued = await runtime.api.post<{ downloadToken: string }>(`/api/artifacts/${encodeURIComponent(item.id)}/download`, { ttlMs: 60_000 });
      const response = await runtime.api.raw(`/api/artifacts/${encodeURIComponent(item.id)}/download?token=${encodeURIComponent(issued.data.downloadToken)}`, { method: "GET" });
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = item.name;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (reason) {
      runtime.notify(reason instanceof Error ? reason.message : "下载失败", "error");
    }
  };
  return <PageFrame icon={<Archive size={19} />} title="产物" count={items.length}>
    {items.length ? <div className={styles.grid}>{items.map((item) => <article className={styles.card} key={item.id}><div className={styles.top}><Archive size={18} /><span>{item.kind}</span></div><div><div className={styles.name}>{item.name}</div><div className={styles.meta}>{item.size == null ? "远端文件" : `${Math.ceil(item.size / 1024)} KB`}<br />{new Date(item.createdAt).toLocaleString()}</div></div><div className={styles.actions}><Button compact variant="secondary" icon={<Download size={15} />} onClick={() => void download(item)}>下载</Button></div></article>)}</div> : <div className={styles.empty}><Archive size={25} /><strong>任务生成的文件会出现在这里</strong></div>}
  </PageFrame>;
}
