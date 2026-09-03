"use client";

import "@xterm/xterm/css/xterm.css";

import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Terminal as XTermTerminal } from "@xterm/xterm";
import { Check, ChevronDown, LoaderCircle, Plus, Search, SquareTerminal, Trash2, X } from "lucide-react";
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
  scopeKey?: string;
  outputBase64?: string;
  term: string;
  cols: number;
  rows: number;
  cwd?: string | null;
  openedAt?: string;
  updatedAt?: string;
  closeResult?: { code: number | null; signal: string | null; error?: { message?: string } | null } | null;
};

type TerminalRecord = {
  session: TerminalSession;
  label: string;
  output: string;
  decoder: TextDecoder;
};
type TerminalGroup = {
  records: Map<string, TerminalRecord>;
  activeSessionId: string | null;
  nextOrdinal: number;
};
type TerminalSessionView = { session: TerminalSession; label: string };
type PendingInput = { text: string; timer: number | null };
type InputPump = { queued: string; running: Promise<void> | null };

const cachedTerminalGroups = new Map<string, TerminalGroup>();

function terminalGroup(cacheKey: string) {
  const cached = cachedTerminalGroups.get(cacheKey);
  if (cached) return cached;
  const created: TerminalGroup = { records: new Map(), activeSessionId: null, nextOrdinal: 1 };
  cachedTerminalGroups.set(cacheKey, created);
  return created;
}

function terminalSessionViews(group: TerminalGroup): TerminalSessionView[] {
  return [...group.records.values()].map((record) => ({ session: { ...record.session }, label: record.label }));
}

function decodeBase64Text(value?: string) {
  if (!value) return "";
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(value), (character) => character.charCodeAt(0)));
  } catch {
    return "";
  }
}

function createRecord(session: TerminalSession, label: string, output = decodeBase64Text(session.outputBase64)): TerminalRecord {
  return { session, label, output, decoder: new TextDecoder() };
}

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

const terminalTheme = {
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

type Props = {
  serverId: string;
  cacheScope: string;
  workspacePath: string;
};

export default function TerminalPane({ serverId, cacheScope, workspacePath }: Props) {
  const runtime = useAppRuntime();
  const cacheKey = `server:${serverId}:${cacheScope}`;
  const [initialGroup] = useState(() => terminalGroup(cacheKey));
  const groupRef = useRef<TerminalGroup>(initialGroup);
  const [sessionList, setSessionList] = useState<TerminalSessionView[]>(() => terminalSessionViews(initialGroup));
  const [activeSessionId, setActiveSessionId] = useState<string | null>(() => initialGroup.activeSessionId);
  const [creating, setCreating] = useState(() => initialGroup.records.size === 0);
  const [error, setError] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const terminalNode = useRef<HTMLDivElement>(null);
  const switcherRoot = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTermTerminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const activeSessionIdRef = useRef(activeSessionId);
  const subscriptionsRef = useRef(new Map<string, () => void>());
  const resizeTimer = useRef<number | null>(null);
  const inputPumps = useRef(new Map<string, InputPump>());
  const pendingInputs = useRef(new Map<string, PendingInput>());
  const mountedRef = useRef(true);

  const refreshSessionList = useCallback(() => {
    const group = groupRef.current;
    cachedTerminalGroups.set(cacheKey, group);
    setSessionList(terminalSessionViews(group));
  }, [cacheKey]);

  const writeRecord = useCallback((sessionId: string, chunk: string) => {
    if (!chunk) return;
    const record = groupRef.current.records.get(sessionId);
    if (!record) return;
    record.output = `${record.output}${chunk}`.slice(-2_000_000);
    if (activeSessionIdRef.current === sessionId) terminalRef.current?.write(chunk);
  }, []);

  const appendRemoteOutput = useCallback((sessionId: string, bytes: Uint8Array) => {
    const record = groupRef.current.records.get(sessionId);
    if (!record) return;
    const decoded = record.decoder.decode(bytes, { stream: true });
    writeRecord(sessionId, decoded);
  }, [writeRecord]);

  const updateSession = useCallback((next: TerminalSession) => {
    const record = groupRef.current.records.get(next.sessionId);
    if (!record) return;
    record.session = next;
    refreshSessionList();
  }, [refreshSessionList]);

  const sendToSession = useCallback((sessionId: string, text: string) => {
    const record = groupRef.current.records.get(sessionId);
    if (!record || record.session.status !== "open" || !record.session.attached || !text) return Promise.resolve();
    let pump = inputPumps.current.get(sessionId);
    if (!pump) {
      pump = { queued: "", running: null };
      inputPumps.current.set(sessionId, pump);
    }
    pump.queued += text;
    if (pump.running) return pump.running;
    const run = async () => {
      while (pump.queued) {
        const payload = pump.queued;
        pump.queued = "";
        await runtime.api.post(
          `/api/servers/${encodeURIComponent(serverId)}/terminal/${encodeURIComponent(sessionId)}/input`,
          { text: payload },
          { idempotencyKey: commandId("terminal-input") },
        );
      }
    };
    pump.running = run().catch((reason) => {
      if (mountedRef.current) setError(reason instanceof Error ? reason.message : "终端输入发送失败");
    }).finally(() => {
      pump.running = null;
      if (!pump.queued) inputPumps.current.delete(sessionId);
    });
    return pump.running;
  }, [runtime.api, serverId]);

  const flushPendingInput = useCallback((sessionId: string) => {
    const pending = pendingInputs.current.get(sessionId);
    if (!pending?.text) return;
    if (pending.timer !== null) window.clearTimeout(pending.timer);
    pendingInputs.current.delete(sessionId);
    void sendToSession(sessionId, pending.text);
  }, [sendToSession]);

  const queueTerminalInput = useCallback((sessionId: string, raw: string) => {
    let pending = pendingInputs.current.get(sessionId);
    if (!pending) {
      pending = { text: "", timer: null };
      pendingInputs.current.set(sessionId, pending);
    }
    pending.text += raw;
    const immediate = raw.length > 1 || /[\r\n\t\u0003\u0004\u001b\u007f\b]/u.test(raw);
    if (immediate) {
      flushPendingInput(sessionId);
      return;
    }
    if (pending.timer === null) {
      pending.timer = window.setTimeout(() => flushPendingInput(sessionId), 80);
    }
  }, [flushPendingInput]);

  const selectSession = useCallback((sessionId: string) => {
    const group = groupRef.current;
    const record = group.records.get(sessionId);
    if (!record) return;
    group.activeSessionId = sessionId;
    activeSessionIdRef.current = sessionId;
    setActiveSessionId(sessionId);
    setSwitcherOpen(false);
    const terminal = terminalRef.current;
    if (terminal) {
      terminal.reset();
      if (record.output) terminal.write(record.output);
      terminal.focus();
    }
  }, []);

  const handleTerminalData = useCallback((raw: string) => {
    const sessionId = activeSessionIdRef.current;
    if (!sessionId || !raw) return;
    queueTerminalInput(sessionId, raw);
  }, [queueTerminalInput]);

  useEffect(() => () => {
    for (const pending of pendingInputs.current.values()) {
      if (pending.timer !== null) window.clearTimeout(pending.timer);
    }
    pendingInputs.current.clear();
  }, []);

  const resizeRemote = useCallback((cols: number, rows: number) => {
    // The drawer enters with a transform animation. During that first frame
    // ResizeObserver can report a tiny transient box (for example 10 x 5).
    // Never propagate that animation artefact to the real remote PTY.
    if (cols < 24 || rows < 6) return;
    const record = groupRef.current.records.get(activeSessionIdRef.current || "");
    if (!record || record.session.status !== "open" || !record.session.attached) return;
    if (record.session.cols === cols && record.session.rows === rows) return;
    if (resizeTimer.current !== null) window.clearTimeout(resizeTimer.current);
    resizeTimer.current = window.setTimeout(() => {
      void runtime.api.post<TerminalSession>(
        `/api/servers/${encodeURIComponent(serverId)}/terminal/${encodeURIComponent(record.session.sessionId)}/resize`,
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
      disableStdin: false,
      fontFamily: "Cascadia Code, JetBrains Mono, SFMono-Regular, Consolas, monospace",
      fontSize: 14,
      lineHeight: 1.2,
      minimumContrastRatio: 4.5,
      screenReaderMode: true,
      scrollback: 10_000,
      theme: terminalTheme,
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    terminal.loadAddon(fit);
    terminal.loadAddon(search);
    terminal.open(node);
    terminalRef.current = terminal;
    fitAddonRef.current = fit;
    searchAddonRef.current = search;
    let fitFrames: number[] = [];
    let fitTimers: number[] = [];
    const fitWhenStable = () => {
      if (node.clientWidth < 220 || node.clientHeight < 96) return;
      try {
        const proposed = fit.proposeDimensions();
        if (!proposed || proposed.cols < 24 || proposed.rows < 6) return;
        fit.fit();
      } catch { /* the drawer may be closing */ }
    };
    const scheduleFit = () => {
      fitFrames.forEach((frame) => window.cancelAnimationFrame(frame));
      fitTimers.forEach((timer) => window.clearTimeout(timer));
      fitFrames = [window.requestAnimationFrame(() => {
        fitFrames.push(window.requestAnimationFrame(fitWhenStable));
      })];
      fitTimers = [80, 240].map((delay) => window.setTimeout(fitWhenStable, delay));
    };
    scheduleFit();
    const activeRecord = groupRef.current.records.get(activeSessionIdRef.current || "");
    if (activeRecord?.output) terminal.write(activeRecord.output);
    const inputSubscription = terminal.onData(handleTerminalData);
    const resizeSubscription = terminal.onResize(({ cols, rows }) => resizeRemote(cols, rows));
    const observer = new ResizeObserver(scheduleFit);
    observer.observe(node);
    if (node.parentElement) observer.observe(node.parentElement);
    window.addEventListener("resize", scheduleFit);
    terminal.focus();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", scheduleFit);
      fitFrames.forEach((frame) => window.cancelAnimationFrame(frame));
      fitTimers.forEach((timer) => window.clearTimeout(timer));
      inputSubscription.dispose();
      resizeSubscription.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      searchAddonRef.current = null;
      if (resizeTimer.current !== null) window.clearTimeout(resizeTimer.current);
    };
  }, [handleTerminalData, resizeRemote]);

  useEffect(() => {
    if (!activeSessionId) return undefined;
    let frame = 0;
    const timers: number[] = [];
    const fitAndSync = () => {
      const terminal = terminalRef.current;
      const fit = fitAddonRef.current;
      if (!terminal || !fit || !terminalNode.current) return;
      if (terminalNode.current.clientWidth < 220 || terminalNode.current.clientHeight < 96) return;
      try { fit.fit(); } catch { return; }
      resizeRemote(terminal.cols, terminal.rows);
    };
    frame = window.requestAnimationFrame(fitAndSync);
    timers.push(window.setTimeout(fitAndSync, 140), window.setTimeout(fitAndSync, 360));
    return () => {
      window.cancelAnimationFrame(frame);
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [activeSessionId, resizeRemote]);

  const subscribeSession = useCallback((record: TerminalRecord) => {
    subscriptionsRef.current.get(record.session.sessionId)?.();
    if (!runtime.realtime) return;
    const unsubscribe = runtime.realtime.subscribe(record.session.topic, (event) => {
      if (event.kind === "terminal.output") {
        const bytes = decodeOutput(event);
        if (bytes) appendRemoteOutput(record.session.sessionId, bytes);
      } else if (event.kind === "terminal.detached") {
        updateSession({ ...record.session, attached: false });
      } else if (event.kind === "terminal.resumed") {
        updateSession({ ...record.session, status: "open", attached: true });
      } else if (event.kind === "terminal.closed") {
        const payload = event.payload as TerminalSession["closeResult"];
        updateSession({ ...record.session, status: "closed", attached: false, closeResult: payload });
        writeRecord(record.session.sessionId, `\r\n\u001b[2m[终端${payload?.error?.message ? `异常结束：${payload.error.message}` : "已关闭"}]\u001b[0m\r\n`);
      }
    });
    subscriptionsRef.current.set(record.session.sessionId, unsubscribe);
  }, [appendRemoteOutput, runtime.realtime, updateSession, writeRecord]);

  const createSession = useCallback(async (discard?: () => boolean) => {
    setCreating(true);
    setError(null);
    try {
      const created = await runtime.api.post<TerminalSession>(`/api/servers/${encodeURIComponent(serverId)}/terminal`, {
        term: "xterm-256color",
        cols: terminalRef.current?.cols || 100,
        rows: terminalRef.current?.rows || 30,
        cwd: workspacePath,
        scopeKey: cacheScope,
      }, { idempotencyKey: commandId("terminal-create") });
      if (discard?.() || !mountedRef.current) {
        await runtime.api.delete(`/api/servers/${encodeURIComponent(serverId)}/terminal/${encodeURIComponent(created.data.sessionId)}`).catch(() => undefined);
        return null;
      }
      const group = groupRef.current;
      const record = createRecord(created.data, `终端 ${group.nextOrdinal++}`);
      group.records.set(created.data.sessionId, record);
      refreshSessionList();
      subscribeSession(record);
      selectSession(created.data.sessionId);
      return created.data;
    } finally {
      if (mountedRef.current) setCreating(false);
    }
  }, [cacheScope, refreshSessionList, runtime.api, selectSession, serverId, subscribeSession, workspacePath]);

  useEffect(() => {
    mountedRef.current = true;
    const subscriptions = subscriptionsRef.current;
    const group = groupRef.current;
    let disposed = false;
    const attach = async () => {
      setError(null);
      try {
        const listed = await runtime.api.get<TerminalSession[]>(`/api/servers/${encodeURIComponent(serverId)}/terminal?scopeKey=${encodeURIComponent(cacheScope)}`);
        const liveIds = new Set(listed.data.map((session) => session.sessionId));
        for (const session of listed.data) {
          const existing = group.records.get(session.sessionId);
          if (existing) {
            existing.session = session;
            existing.output = decodeBase64Text(session.outputBase64);
          } else {
            group.records.set(session.sessionId, createRecord(session, `终端 ${group.nextOrdinal++}`));
          }
        }
        for (const sessionId of [...group.records.keys()]) {
          if (!liveIds.has(sessionId)) group.records.delete(sessionId);
        }
        if (disposed) return;
        for (const record of group.records.values()) subscribeSession(record);
        refreshSessionList();
        const openRecords = [...group.records.values()].filter((record) => record.session.status === "open");
        if (!openRecords.length) {
          await createSession(() => disposed);
          return;
        }
        const preferred = group.activeSessionId ? group.records.get(group.activeSessionId) : null;
        selectSession(preferred?.session.status === "open" ? preferred.session.sessionId : openRecords[0].session.sessionId);
        setCreating(false);
      } catch (reason) {
        if (!disposed) {
          setCreating(false);
          setError(reason instanceof Error ? reason.message : "终端创建失败");
        }
      }
    };
    void attach();
    return () => {
      disposed = true;
      mountedRef.current = false;
      for (const unsubscribe of subscriptions.values()) unsubscribe();
      subscriptions.clear();
      cachedTerminalGroups.set(cacheKey, group);
    };
  }, [cacheKey, cacheScope, createSession, refreshSessionList, runtime.api, selectSession, serverId, subscribeSession]);

  useEffect(() => {
    if (!switcherOpen) return undefined;
    const close = (event: PointerEvent) => {
      if (!switcherRoot.current?.contains(event.target as Node)) setSwitcherOpen(false);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setSwitcherOpen(false); };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", escape);
    };
  }, [switcherOpen]);

  const activeView = sessionList.find((candidate) => candidate.session.sessionId === activeSessionId) || null;
  const activeSession = activeView?.session || null;
  const status = creating && !activeSession ? "creating" : activeSession?.status === "closed" ? "closed" : activeSession?.attached ? "open" : activeSession ? "detached" : error ? "failed" : "creating";

  return <div className={`${styles.pane} ${styles.terminalPane}`}>
    <div className={styles.terminalToolbar}>
      <span className={`${styles.sessionStatus} ${styles[`session_${status}`] || ""}`}><i />{statusText[status] || status}</span>
      <div className={styles.terminalSwitcher} ref={switcherRoot}>
        <button type="button" className={styles.terminalSwitcherButton} aria-haspopup="menu" aria-expanded={switcherOpen} onClick={() => setSwitcherOpen((open) => !open)}><SquareTerminal size={14} /><span>{activeView?.label || "终端"}</span><ChevronDown size={13} /></button>
        {switcherOpen ? <div className={styles.terminalSwitcherMenu} role="menu" aria-label="终端会话">
          {sessionList.map(({ session, label }) => <button type="button" role="menuitemradio" aria-checked={session.sessionId === activeSessionId} key={session.sessionId} onClick={() => selectSession(session.sessionId)}><span className={`${styles.terminalSessionDot} ${styles[`session_${session.status === "open" ? session.attached ? "open" : "detached" : session.status}`] || ""}`}><i /></span><span>{label}</span><small>{statusText[session.status === "open" && !session.attached ? "detached" : session.status] || session.status}</small>{session.sessionId === activeSessionId ? <Check size={14} /> : null}</button>)}
          <span className={styles.terminalSwitcherSeparator} />
          <button type="button" className={styles.newTerminalButton} disabled={creating} onClick={() => void createSession().catch((reason) => setError(reason instanceof Error ? reason.message : "终端创建失败"))}>{creating ? <LoaderCircle className={styles.spin} size={14} /> : <Plus size={14} />}新增终端</button>
        </div> : null}
      </div>
      <span className={styles.terminalMeta}>{activeSession ? `${activeSession.cols} × ${activeSession.rows}` : "PTY"}</span>
      <span className={styles.spacer} />
      {searchOpen ? <label className={styles.terminalSearch}><Search size={14} aria-hidden="true" /><input autoFocus aria-label="在终端中搜索" value={searchTerm} onChange={(event) => { setSearchTerm(event.target.value); searchAddonRef.current?.findNext(event.target.value, { incremental: true }); }} onKeyDown={(event) => { if (event.key === "Enter") searchAddonRef.current?.findNext(searchTerm); if (event.key === "Escape") { setSearchOpen(false); terminalRef.current?.focus(); } }} /><button type="button" aria-label="关闭搜索" onClick={() => { setSearchOpen(false); terminalRef.current?.focus(); }}><X size={14} /></button></label> : <Button compact variant="ghost" icon={<Search size={15} />} onClick={() => setSearchOpen(true)}>搜索</Button>}
      <Button compact variant="ghost" icon={<Trash2 size={15} />} onClick={() => {
        terminalRef.current?.reset();
        const record = groupRef.current.records.get(activeSessionIdRef.current || "");
        if (!record) return;
        record.output = "";
        void sendToSession(record.session.sessionId, "\u000c");
      }}>清除</Button>
    </div>
    <div className={styles.terminalStage}>
      {creating && !activeSession ? <div className={styles.terminalOverlay}><LoaderCircle className={styles.spin} size={21} />正在创建 PTY</div> : null}
      {status === "detached" ? <div className={styles.terminalDetached}>终端暂时不可输入，重新打开工作台后会自动恢复</div> : null}
      {error ? <div className={styles.terminalError} role="alert">{error}</div> : null}
      <div ref={terminalNode} className={styles.xtermHost} aria-label="远程终端" />
    </div>
  </div>;
}
