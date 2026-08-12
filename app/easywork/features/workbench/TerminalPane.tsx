"use client";

import "@xterm/xterm/css/xterm.css";

import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Terminal as XTermTerminal } from "@xterm/xterm";
import { CirclePause, LoaderCircle, Play, Power, RotateCcw, Search, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { RealtimeEnvelope } from "@/app/core/contracts";
import { commandId } from "@/app/core/gateway/client";
import { useAppRuntime } from "../../runtime/AppRuntime";
import { Button } from "../../ui/Button";
import styles from "./WorkbenchDrawer.module.css";

type TerminalSession = {
  sessionId: string;
  topic: string;
  status: "open" | "closed" | string;
  attached: boolean;
  term: string;
  cols: number;
  rows: number;
  openedAt?: string;
  updatedAt?: string;
  closeResult?: { code: number | null; signal: string | null; error?: { message?: string } | null } | null;
};

type CachedSession = TerminalSession & { output: string };
const cachedSessions = new Map<string, CachedSession>();

function decodeOutput(event: RealtimeEnvelope) {
  const payload = event.payload as { dataBase64?: string } | null;
  if (!payload?.dataBase64) return null;
  try {
    return Uint8Array.from(atob(payload.dataBase64), (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

const statusText: Record<string, string> = {
  creating: "正在创建",
  open: "已连接",
  detached: "已分离",
  closed: "已关闭",
  failed: "连接失败",
};

const earthsongTheme = {
  background: "#403f37",
  foreground: "#e8dfc8",
  cursor: "#f2e8cf",
  cursorAccent: "#403f37",
  selectionBackground: "#8c866d88",
  black: "#292a24",
  red: "#d17b62",
  green: "#8f9d6a",
  yellow: "#d4b86a",
  blue: "#6f9aa8",
  magenta: "#b48ead",
  cyan: "#7db6ae",
  white: "#e8dfc8",
  brightBlack: "#716f63",
  brightRed: "#e58a70",
  brightGreen: "#a6b681",
  brightYellow: "#e5c777",
  brightBlue: "#8aafbb",
  brightMagenta: "#c5a0bf",
  brightCyan: "#95cbc3",
  brightWhite: "#fff8e7",
} as const;

export default function TerminalPane({ serverId, resumeAvailable, cacheScope }: { serverId: string; resumeAvailable: boolean; cacheScope: string }) {
  const runtime = useAppRuntime();
  const cacheKey = `server:${serverId}:${cacheScope}`;
  const [session, setSession] = useState<TerminalSession | null>(null);
  const [status, setStatus] = useState("creating");
  const [error, setError] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const terminalNode = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTermTerminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const sessionRef = useRef<TerminalSession | null>(null);
  const outputRef = useRef(cachedSessions.get(cacheKey)?.output || "");
  const decoderRef = useRef(new TextDecoder());
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const closeRequested = useRef(false);
  const resizeTimer = useRef<number | null>(null);
  const inputQueue = useRef<Promise<unknown>>(Promise.resolve());

  const updateSession = useCallback((next: TerminalSession) => {
    sessionRef.current = next;
    setSession(next);
    setStatus(next.status === "closed" ? "closed" : next.attached ? "open" : "detached");
    cachedSessions.set(cacheKey, { ...next, output: outputRef.current });
  }, [cacheKey]);

  const appendOutput = useCallback((bytes: Uint8Array | string) => {
    const chunk = typeof bytes === "string" ? bytes : decoderRef.current.decode(bytes, { stream: true });
    if (!chunk) return;
    outputRef.current = `${outputRef.current}${chunk}`.slice(-2_000_000);
    const current = sessionRef.current;
    if (current) cachedSessions.set(cacheKey, { ...current, output: outputRef.current });
    terminalRef.current?.write(chunk);
  }, [cacheKey]);

  const send = useCallback((text: string) => {
    const current = sessionRef.current;
    if (!current || current.status !== "open" || !current.attached || !text) return Promise.resolve();
    inputQueue.current = inputQueue.current.then(() => runtime.api.post(
      `/api/servers/${encodeURIComponent(serverId)}/terminal/${encodeURIComponent(current.sessionId)}/input`,
      { text },
      { idempotencyKey: commandId("terminal-input") },
    )).catch((reason) => {
      setError(reason instanceof Error ? reason.message : "终端输入发送失败");
    });
    return inputQueue.current;
  }, [runtime.api, serverId]);

  const resizeRemote = useCallback((cols: number, rows: number) => {
    const current = sessionRef.current;
    if (!current || current.status !== "open" || !current.attached) return;
    if (Math.abs(cols - current.cols) < 1 && Math.abs(rows - current.rows) < 1) return;
    if (resizeTimer.current !== null) window.clearTimeout(resizeTimer.current);
    resizeTimer.current = window.setTimeout(() => {
      void runtime.api.post<TerminalSession>(
        `/api/servers/${encodeURIComponent(serverId)}/terminal/${encodeURIComponent(current.sessionId)}/resize`,
        { cols, rows },
        { idempotencyKey: commandId("terminal-resize") },
      ).then((result) => updateSession(result.data)).catch(() => undefined);
    }, 120);
  }, [runtime.api, serverId, updateSession]);

  useEffect(() => {
    const node = terminalNode.current;
    if (!node) return undefined;
    const terminal = new XTermTerminal({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: "Cascadia Code, JetBrains Mono, SFMono-Regular, Consolas, monospace",
      fontSize: 14,
      lineHeight: 1.2,
      minimumContrastRatio: 4.5,
      screenReaderMode: true,
      scrollback: 10_000,
      theme: earthsongTheme,
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    terminal.loadAddon(fit);
    terminal.loadAddon(search);
    terminal.open(node);
    terminalRef.current = terminal;
    fitAddonRef.current = fit;
    searchAddonRef.current = search;
    fit.fit();
    if (outputRef.current) terminal.write(outputRef.current);
    const inputSubscription = terminal.onData((data) => { void send(data); });
    const resizeSubscription = terminal.onResize(({ cols, rows }) => resizeRemote(cols, rows));
    const observer = new ResizeObserver(() => {
      try { fit.fit(); } catch { /* the drawer may be closing */ }
    });
    observer.observe(node);
    terminal.focus();
    return () => {
      observer.disconnect();
      inputSubscription.dispose();
      resizeSubscription.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      searchAddonRef.current = null;
      if (resizeTimer.current !== null) window.clearTimeout(resizeTimer.current);
    };
  }, [resizeRemote, send]);

  const subscribe = useCallback((current: TerminalSession) => {
    unsubscribeRef.current?.();
    if (!runtime.realtime) return;
    unsubscribeRef.current = runtime.realtime.subscribe(current.topic, (event) => {
      if (event.kind === "terminal.output") {
        const bytes = decodeOutput(event);
        if (bytes) appendOutput(bytes);
      }
      if (event.kind === "terminal.detached") setStatus("detached");
      if (event.kind === "terminal.resumed") setStatus("open");
      if (event.kind === "terminal.closed") {
        const payload = event.payload as TerminalSession["closeResult"];
        setStatus(payload?.error ? "failed" : "closed");
        setSession((value) => value ? { ...value, status: "closed", attached: false, closeResult: payload } : value);
        appendOutput(`\r\n\u001b[2m[终端${payload?.error?.message ? `异常结束：${payload.error.message}` : "已关闭"}]\u001b[0m\r\n`);
        cachedSessions.delete(cacheKey);
      }
    });
  }, [appendOutput, cacheKey, runtime.realtime]);

  const createSession = useCallback(async (discard?: () => boolean) => {
    closeRequested.current = false;
    setStatus("creating");
    setError(null);
    const created = await runtime.api.post<TerminalSession>(`/api/servers/${encodeURIComponent(serverId)}/terminal`, {
      term: "xterm-256color",
      cols: terminalRef.current?.cols || 100,
      rows: terminalRef.current?.rows || 30,
    }, { idempotencyKey: commandId("terminal-create") });
    if (discard?.()) {
      await runtime.api.delete(`/api/servers/${encodeURIComponent(serverId)}/terminal/${encodeURIComponent(created.data.sessionId)}`).catch(() => undefined);
      return null;
    }
    decoderRef.current = new TextDecoder();
    outputRef.current = "";
    terminalRef.current?.reset();
    updateSession(created.data);
    subscribe(created.data);
    return created.data;
  }, [runtime.api, serverId, subscribe, updateSession]);

  useEffect(() => {
    let disposed = false;
    closeRequested.current = false;
    const attach = async () => {
      setStatus("creating");
      setError(null);
      try {
        let current = cachedSessions.get(cacheKey) || null;
        if (current) {
          try {
            const inspected = await runtime.api.get<TerminalSession>(`/api/servers/${encodeURIComponent(serverId)}/terminal/${encodeURIComponent(current.sessionId)}`);
            current = { ...inspected.data, output: current.output };
            if (current.status === "open" && !current.attached && resumeAvailable) {
              const resumed = await runtime.api.post<TerminalSession>(`/api/servers/${encodeURIComponent(serverId)}/terminal/${encodeURIComponent(current.sessionId)}/resume`, {}, { idempotencyKey: commandId("terminal-resume") });
              current = { ...resumed.data, output: current.output };
            }
          } catch {
            cachedSessions.delete(cacheKey);
            current = null;
          }
        }
        if (!current || current.status !== "open") {
          await createSession(() => disposed);
          return;
        }
        if (disposed) return;
        outputRef.current = current.output;
        terminalRef.current?.reset();
        if (current.output) terminalRef.current?.write(current.output);
        updateSession(current);
        subscribe(current);
      } catch (reason) {
        if (!disposed) {
          setStatus("failed");
          setError(reason instanceof Error ? reason.message : "终端创建失败");
        }
      }
    };
    void attach();
    return () => {
      disposed = true;
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
      const current = sessionRef.current;
      if (!closeRequested.current && current?.status === "open" && current.attached && resumeAvailable) {
        void runtime.api.post<TerminalSession>(`/api/servers/${encodeURIComponent(serverId)}/terminal/${encodeURIComponent(current.sessionId)}/detach`, {}, { idempotencyKey: commandId("terminal-detach") }).then((result) => {
          cachedSessions.set(cacheKey, { ...result.data, output: cachedSessions.get(cacheKey)?.output || outputRef.current });
        }).catch(() => undefined);
      }
    };
  }, [cacheKey, createSession, resumeAvailable, runtime.api, serverId, subscribe, updateSession]);

  const detach = async () => {
    const current = sessionRef.current;
    if (!current || !resumeAvailable) return;
    try {
      const result = await runtime.api.post<TerminalSession>(`/api/servers/${encodeURIComponent(serverId)}/terminal/${encodeURIComponent(current.sessionId)}/detach`, {}, { idempotencyKey: commandId("terminal-detach") });
      updateSession(result.data);
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
    } catch (reason) { setError(reason instanceof Error ? reason.message : "无法分离终端"); }
  };

  const resume = async () => {
    const current = sessionRef.current;
    if (!current || !resumeAvailable) return;
    try {
      const result = await runtime.api.post<TerminalSession>(`/api/servers/${encodeURIComponent(serverId)}/terminal/${encodeURIComponent(current.sessionId)}/resume`, {}, { idempotencyKey: commandId("terminal-resume") });
      updateSession(result.data);
      subscribe(result.data);
      terminalRef.current?.focus();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "无法恢复终端"); }
  };

  const close = async () => {
    const current = sessionRef.current;
    if (!current) return;
    closeRequested.current = true;
    try {
      const result = await runtime.api.delete<TerminalSession>(`/api/servers/${encodeURIComponent(serverId)}/terminal/${encodeURIComponent(current.sessionId)}`);
      updateSession(result.data);
      cachedSessions.delete(cacheKey);
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
    } catch (reason) {
      closeRequested.current = false;
      setError(reason instanceof Error ? reason.message : "无法关闭终端");
    }
  };

  return <div className={`${styles.pane} ${styles.terminalPane}`}>
    <div className={styles.terminalToolbar}>
      <span className={`${styles.sessionStatus} ${styles[`session_${status}`] || ""}`}><i />{statusText[status] || status}</span>
      <span className={styles.terminalMeta}>{session ? `${session.cols} × ${session.rows}` : "PTY"}</span>
      <span className={styles.spacer} />
      {searchOpen ? <label className={styles.terminalSearch}><Search size={14} aria-hidden="true" /><input autoFocus aria-label="在终端中搜索" value={searchTerm} onChange={(event) => { setSearchTerm(event.target.value); searchAddonRef.current?.findNext(event.target.value, { incremental: true }); }} onKeyDown={(event) => { if (event.key === "Enter") searchAddonRef.current?.findNext(searchTerm); if (event.key === "Escape") { setSearchOpen(false); terminalRef.current?.focus(); } }} /><button aria-label="关闭搜索" onClick={() => { setSearchOpen(false); terminalRef.current?.focus(); }}><X size={14} /></button></label> : <Button compact iconOnly variant="ghost" aria-label="搜索终端输出" icon={<Search size={15} />} onClick={() => setSearchOpen(true)} />}
      {status === "open" && resumeAvailable ? <Button compact variant="ghost" icon={<CirclePause size={15} />} onClick={() => void detach()}>分离</Button> : null}
      {status === "detached" ? <Button compact variant="secondary" icon={<Play size={15} />} onClick={() => void resume()}>恢复</Button> : null}
      {["closed", "failed"].includes(status) ? <Button compact variant="secondary" icon={<Play size={15} />} onClick={() => void createSession().catch((reason) => { setStatus("failed"); setError(reason instanceof Error ? reason.message : "终端创建失败"); })}>新建会话</Button> : null}
      {status === "open" ? <Button compact variant="ghost" icon={<RotateCcw size={14} />} onClick={() => void send("\u0003")}>Ctrl C</Button> : null}
      <Button compact iconOnly variant="ghost" aria-label="清空终端" icon={<Trash2 size={15} />} onClick={() => { terminalRef.current?.clear(); outputRef.current = ""; const current = sessionRef.current; if (current) cachedSessions.set(cacheKey, { ...current, output: "" }); }} />
      <Button compact iconOnly variant="danger" aria-label="关闭终端会话" icon={<Power size={15} />} disabled={!session || status === "closed"} onClick={() => void close()} />
    </div>
    <div className={styles.terminalStage}>
      {status === "creating" ? <div className={styles.terminalOverlay}><LoaderCircle className={styles.spin} size={21} />正在创建 PTY</div> : null}
      {status === "detached" ? <div className={styles.terminalDetached}>终端已分离，恢复后可继续原会话</div> : null}
      {error ? <div className={styles.terminalError} role="alert">{error}</div> : null}
      <div ref={terminalNode} className={styles.xtermHost} aria-label="远程终端" />
    </div>
  </div>;
}
