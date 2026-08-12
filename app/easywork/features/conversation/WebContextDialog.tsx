"use client";

import { useEffect, useState } from "react";
import { Brain, Database, MessageCircle, MessagesSquare, Save } from "lucide-react";
import { commandId } from "@/app/core/gateway/client";
import { useAppRuntime } from "../../runtime/AppRuntime";
import { Button } from "../../ui/Button";
import { LoadingState } from "../../ui/LoadingState";
import { Modal } from "../../ui/Modal";
import styles from "./WebContextDialog.module.css";

type ContextPart = { kind: "user" | "assistant" | "system" | string; tokens: number };
type ContextSnapshot = {
  usage: { usedTokens: number; limitTokens: number; ratio?: number; parts?: ContextPart[] };
  config: { maxTokens: number; autoCompactThreshold: number };
  revision: number;
  compressing: boolean;
};

const number = (value: unknown, fallback: number) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const tokens = (value: number) => value >= 1000 ? `${(value / 1000).toFixed(value >= 100_000 ? 0 : 1)}k` : String(value);
const partLabel = (kind: string) => kind === "user" ? "用户消息" : kind === "assistant" ? "模型回复" : kind === "system" ? "系统上下文" : kind;

export function WebContextDialog({ conversationId, onClose }: { conversationId?: string; onClose: () => void }) {
  const { api, notify } = useAppRuntime();
  const [snapshot, setSnapshot] = useState<ContextSnapshot | null>(null);
  const [maxTokens, setMaxTokens] = useState(200_000);
  const [threshold, setThreshold] = useState(0.95);
  const [loading, setLoading] = useState(Boolean(conversationId));
  const [busy, setBusy] = useState<"save" | "compact" | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);

  useEffect(() => {
    if (!conversationId) return;
    let active = true;
    void api.get<ContextSnapshot>(`/api/conversations/${encodeURIComponent(conversationId)}/context`).then(
      (result) => {
        if (!active) return;
        setSnapshot(result.data);
        setMaxTokens(number(result.data.config?.maxTokens, 200_000));
        setThreshold(number(result.data.config?.autoCompactThreshold, 0.95));
        setLoading(false);
      },
      (error: Error) => { if (active) { setUnavailable(error.message); setLoading(false); } },
    );
    return () => { active = false; };
  }, [api, conversationId]);

  const save = async () => {
    if (!conversationId || !snapshot) return;
    setBusy("save");
    try {
      const result = await api.patch<ContextSnapshot>(`/api/conversations/${encodeURIComponent(conversationId)}/context`, {
        maxTokens,
        autoCompactThreshold: threshold,
      }, { expectedRevision: snapshot.revision, idempotencyKey: commandId("web-context-config") });
      setSnapshot(result.data);
      notify("上下文配置已保存", "success");
    } catch (error) { notify(error instanceof Error ? error.message : "配置失败", "error"); }
    finally { setBusy(null); }
  };

  const compact = async () => {
    if (!conversationId || !snapshot) return;
    setBusy("compact");
    try {
      const result = await api.post<ContextSnapshot>(`/api/conversations/${encodeURIComponent(conversationId)}/context/compact`, {}, {
        expectedRevision: snapshot.revision,
        idempotencyKey: commandId("web-context-compact"),
      });
      setSnapshot(result.data);
      notify("上下文已压缩", "success");
    } catch (error) { notify(error instanceof Error ? error.message : "压缩失败", "error"); }
    finally { setBusy(null); }
  };

  const used = snapshot?.usage.usedTokens ?? 0;
  const limit = snapshot?.usage.limitTokens ?? maxTokens;
  const ratio = snapshot?.usage.ratio ?? (limit > 0 ? used / limit : 0);
  const parts = snapshot?.usage.parts ?? [];

  return <Modal title="网页对话上下文" size="normal" panelClassName={styles.dialogPanel} onClose={onClose}>
    {loading ? <LoadingState label="正在读取上下文" /> : unavailable ? <div className={styles.unavailable}><Brain size={23} /><strong>暂时无法读取</strong><span>{unavailable}</span></div> : !conversationId ? <div className={styles.unavailable}><MessagesSquare size={23} /><strong>尚未开始对话</strong><span>发送首条消息后即可查看和配置上下文。</span></div> : snapshot ? <div className={styles.layout}>
      <section className={styles.overview}>
        <div className={styles.usageHeading}>
          <span className={styles.usageIcon}><MessageCircle size={19} /></span>
          <div><small>当前网页对话</small><strong>{tokens(used)} / {tokens(limit)}</strong></div>
          <em>{Math.round(ratio * 100)}%</em>
        </div>
        <div className={styles.progress} aria-hidden="true"><i style={{ width: `${Math.max(0, Math.min(100, ratio * 100))}%` }} /></div>
      </section>

      <section className={styles.composition}>
        <header><strong>占用组成</strong></header>
        {parts.length ? <dl className={styles.parts}>{parts.map((part, index) => <div key={`${part.kind}-${index}`}><dt>{partLabel(part.kind)}</dt><dd>{tokens(part.tokens)}</dd></div>)}</dl> : <div className={styles.emptyParts}>暂无可拆分的占用数据</div>}
      </section>

      <section className={styles.settings}>
        <header><div><strong>压缩设置</strong><small>只调整网页对话，不改动 Agent 原生会话。</small></div></header>
        <div className={styles.settingsGrid}>
          <label><span>上下文上限</span><div className={styles.numberField}><input type="number" min={4_096} max={2_000_000} step={1_000} value={maxTokens} onChange={(event) => setMaxTokens(number(event.target.value, 200_000))} /></div></label>
          <label><span>自动压缩阈值</span><div className={styles.numberField}><input type="number" min="0.5" max="0.99" step="0.01" value={threshold} onChange={(event) => setThreshold(number(event.target.value, 0.95))} /></div></label>
        </div>
      </section>

      <footer className={styles.actions}>
        <Button className={styles.saveButton} variant="ghost" icon={<Save size={16} />} disabled={Boolean(busy) || maxTokens < 4_096 || threshold < 0.5 || threshold > 0.99} onClick={() => void save()}>{busy === "save" ? "配置中" : "保存设置"}</Button>
        <Button className={styles.compactButton} variant="primary" icon={<Database size={16} />} disabled={Boolean(busy) || snapshot.compressing} onClick={() => void compact()}>{busy === "compact" || snapshot.compressing ? "压缩中" : "压缩对话"}</Button>
      </footer>
    </div> : null}
  </Modal>;
}
