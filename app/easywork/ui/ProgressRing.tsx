import type { CSSProperties } from "react";
import styles from "./ProgressRing.module.css";

function ratio(value: number) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function formatTokens(value: number | null | undefined) {
  if (value === null || value === undefined) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

export function AgentContextRing({ value, readable }: { value: number; readable: boolean }) {
  const normalized = ratio(value);
  const description = readable
    ? `Agent 上下文已使用 ${Math.round(normalized * 100)}%`
    : "Agent 上下文无法读取";

  return <span
    data-context-ring="agent"
    className={`${styles.agentContextRing} ${readable ? styles.readable : styles.unreadable}`}
    style={{ "--context-ratio": `${normalized * 100}%` } as CSSProperties}
    title={readable ? `Agent 上下文 ${Math.round(normalized * 100)}%` : description}
    aria-label={description}
  />;
}

export function WebContextRing({ value, used, limit, loading }: { value: number; used?: number; limit?: number; loading: boolean }) {
  const normalized = ratio(value);
  return <span
    data-context-ring="web"
    className={`${styles.webContextRing} ${loading ? styles.loading : ""}`}
    style={{ "--context-ratio": `${normalized * 100}%` } as CSSProperties}
    title={loading && used === undefined
      ? "正在读取网页对话上下文"
      : `网页对话上下文 ${formatTokens(used ?? 0)} / ${formatTokens(limit ?? 200_000)}`}
    aria-label="网页对话上下文占用"
  >
    <span aria-hidden="true" />
  </span>;
}
