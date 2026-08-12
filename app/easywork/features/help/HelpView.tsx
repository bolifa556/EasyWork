"use client";

import { TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { useAppRuntime } from "../../runtime/AppRuntime";
import styles from "./HelpView.module.css";

type HelpPayload = { content: string; mediaType: string; etag: string; lastModified: string };

function keywordTone(value: string) {
  if (/EasyWork/i.test(value)) return styles.product;
  if (/Agent|OpenCode|Claude Code|Codex/i.test(value)) return styles.agent;
  if (/API|模型/i.test(value)) return styles.api;
  if (/SSH|服务器|连接|2FA/i.test(value)) return styles.connection;
  if (/聊天|工作模式|工作对话/i.test(value)) return styles.mode;
  if (/工作区/i.test(value)) return styles.workspace;
  return styles.emphasis;
}

export default function HelpView() {
  const runtime = useAppRuntime();
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const etag = useRef<string | null>(null);
  const mounted = useRef(true);

  const load = useCallback(async (signal?: AbortSignal) => {
    const result = await runtime.api.get<HelpPayload>("/api/help", signal);
    const nextContent = result.data.content;
    if (!nextContent.trim()) throw new Error("帮助内容为空");
    if (result.data.etag === etag.current) return false;
    if (mounted.current) {
      setContent(nextContent);
      setError(null);
      etag.current = result.data.etag;
    }
    return true;
  }, [runtime.api]);

  useEffect(() => {
    mounted.current = true;
    const initial = new AbortController();
    void load(initial.signal).then(() => runtime.api.post("/api/auth/help-seen", {}).catch(() => undefined)).catch((reason) => { if (mounted.current) setError(reason instanceof Error ? reason.message : "帮助读取失败"); }).finally(() => { if (mounted.current) setLoading(false); });
    return () => { mounted.current = false; initial.abort(); };
  }, [load, runtime.api]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setInterval(() => { void load(controller.signal).catch(() => undefined); }, 60_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [load]);

  return <section className={styles.page}>
    {loading ? <div className={styles.loading} role="status"><span className={styles.loadingRing} /><span>正在读取帮助</span></div> : error ? <section className={styles.unavailable}><TriangleAlert size={24} /><strong>{error}</strong><button type="button" onClick={() => void load().catch((reason) => setError(reason instanceof Error ? reason.message : "帮助读取失败"))}>重新读取</button></section> : <article className={styles.document}><ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      components={{
        strong: ({ children }) => {
          const text = Array.isArray(children) ? children.join("") : String(children ?? "");
          return <strong className={keywordTone(text)}>{children}</strong>;
        },
      }}
    >{content}</ReactMarkdown></article>}
  </section>;
}
