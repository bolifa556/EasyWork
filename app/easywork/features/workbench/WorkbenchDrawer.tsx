"use client";

import { LoaderCircle, ServerCog, SquareTerminal, X } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { ServerCapabilityProfile } from "@/app/core/contracts";
import { useAppRuntime } from "../../runtime/AppRuntime";
import { Button } from "../../ui/Button";
import { bindMobileWorkbench } from "./mobile-workbench";
import styles from "./WorkbenchDrawer.module.css";

const TerminalPane = lazy(() => import("./TerminalPane"));
const SchedulerPane = lazy(() => import("./SchedulerPane"));

type Props = {
  serverId: string;
  workspaceId: string;
  workspacePath: string;
  conversationId?: string;
  branchId?: string;
  height: number;
  onHeightChange: (height: number) => void;
  onClose: () => void;
};

type Tab = "terminal" | "scheduler";
const capabilityCache = new Map<string, ServerCapabilityProfile>();
const tabDefinitions = [
  ["terminal", SquareTerminal, "终端"],
  ["scheduler", ServerCog, "算力"],
] as const;

function tabIsAvailable(profile: ServerCapabilityProfile | null, candidate: Tab) {
  if (!profile) return false;
  if (candidate === "terminal") return profile.features.terminal.available && profile.features.terminal.pty;
  return profile.features.terminal.available;
}

export default function WorkbenchDrawer({ serverId, workspaceId, workspacePath, conversationId, branchId, height, onHeightChange, onClose }: Props) {
  const runtime = useAppRuntime();
  const [tab, setTab] = useState<Tab>("terminal");
  const [resizing, setResizing] = useState(false);
  const [capabilities, setCapabilities] = useState<ServerCapabilityProfile | null>(() => capabilityCache.get(serverId) || null);
  const [capabilityError, setCapabilityError] = useState<string | null>(null);
  const drawerRef = useRef<HTMLElement | null>(null);
  const headerRef = useRef<HTMLElement | null>(null);
  const closeMobile = useEffectEvent(onClose);
  useLayoutEffect(() => {
    if (drawerRef.current && headerRef.current) return bindMobileWorkbench(drawerRef.current, headerRef.current, () => closeMobile());
  }, []);
  const resizeCleanup = useRef<(() => void) | null>(null);

  const enabledTabs = useMemo(() => tabDefinitions.filter(([id]) => tabIsAvailable(capabilities, id)), [capabilities]);

  const loadCapabilities = useCallback(async (refresh = false, signal?: AbortSignal) => {
    setCapabilityError(null);
    try {
      const result = refresh
        ? await runtime.api.post<ServerCapabilityProfile>(`/api/servers/${encodeURIComponent(serverId)}/capabilities/refresh`, {}, { signal })
        : await runtime.api.get<ServerCapabilityProfile>(`/api/servers/${encodeURIComponent(serverId)}/capabilities`, signal);
      capabilityCache.set(serverId, result.data);
      setCapabilities(result.data);
    } catch (reason) {
      if (!signal?.aborted) setCapabilityError(reason instanceof Error ? reason.message : "服务器能力检测失败");
    }
  }, [runtime.api, serverId]);

  useEffect(() => () => resizeCleanup.current?.(), []);

  const clampHeight = useCallback((value: number) => Math.max(260, Math.min(value, (drawerRef.current?.parentElement?.clientHeight ?? window.innerHeight) - 200)), []);
  const startResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (window.matchMedia("(max-width: 719px)").matches) return;
    event.preventDefault();
    resizeCleanup.current?.();
    const pointerId = event.pointerId;
    const startY = event.clientY;
    const startHeight = drawerRef.current?.getBoundingClientRect().height ?? height;
    let latestHeight = startHeight;
    let frame: number | null = null;
    const paint = () => {
      frame = null;
      drawerRef.current?.style.setProperty("--workbench-height", `${latestHeight}px`);
    };
    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      latestHeight = clampHeight(startHeight + startY - moveEvent.clientY);
      if (frame === null) frame = window.requestAnimationFrame(paint);
    };
    const stop = (stopEvent?: PointerEvent) => {
      if (stopEvent && stopEvent.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      if (frame !== null) window.cancelAnimationFrame(frame);
      resizeCleanup.current = null;
      setResizing(false);
      const value = stopEvent ? clampHeight(startHeight + startY - stopEvent.clientY) : latestHeight;
      drawerRef.current?.style.setProperty("--workbench-height", `${value}px`);
      onHeightChange(value);
      localStorage.setItem("easywork.workbench-height", String(Math.round(value)));
    };
    resizeCleanup.current = stop;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    setResizing(true);
  };
  const resizeWithKeyboard = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? 260 : event.key === "End" ? window.innerHeight - 64 : height + (event.key === "ArrowUp" ? 24 : -24);
    const value = clampHeight(next);
    onHeightChange(value);
    localStorage.setItem("easywork.workbench-height", String(Math.round(value)));
  };

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setCapabilities(capabilityCache.get(serverId) || null);
      setCapabilityError(null);
      void loadCapabilities(false, controller.signal);
    }, 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [loadCapabilities, serverId]);

  const activeTab = capabilities && !tabIsAvailable(capabilities, tab)
    ? enabledTabs[0]?.[0] || tab
    : tab;

  return <section ref={drawerRef} data-mobile-swipe-ignore="" className={`${styles.drawer} ${resizing ? styles.resizing : ""}`} style={{ "--workbench-height": `${height}px` } as CSSProperties} aria-label="工作台">
    <button className={styles.resizeHandle} type="button" aria-label="调整工作台高度" title="拖动调整工作台高度" onPointerDown={startResize} onKeyDown={resizeWithKeyboard} onDoubleClick={() => { const value = clampHeight(window.innerHeight * .54); onHeightChange(value); localStorage.setItem("easywork.workbench-height", String(Math.round(value))); }} />
    <header ref={headerRef} className={styles.header}>
      <div className={styles.tabs} role="tablist" aria-label="工作台功能">{enabledTabs.map(([id, Icon, label]) => <button key={id} role="tab" aria-selected={activeTab === id} className={`${styles.tab} ${activeTab === id ? styles.active : ""}`} onClick={() => setTab(id)}><Icon size={16} /><span>{label}</span></button>)}</div>
      <span className={styles.spacer} />
      <Button className={styles.closeButton} compact iconOnly variant="ghost" aria-label="收起工作台" icon={<X size={17} />} onClick={onClose} />
    </header>
    <div className={styles.body}>
      {!capabilities || capabilityError || enabledTabs.length === 0 ? <div className={styles.capabilityState}>{capabilityError || (capabilities ? "当前服务器没有可用的工作台能力" : <><LoaderCircle className={styles.spin} size={20} />正在检测服务器能力</>)}</div> : null}
      {capabilities ? <Suspense fallback={<div className={styles.state}><LoaderCircle className={styles.spin} size={21} />正在载入</div>}>
        {activeTab === "terminal" && tabIsAvailable(capabilities, "terminal") ? <TerminalPane key={`${serverId}:${conversationId || "workbench"}:${workspaceId}:${workspacePath}`} serverId={serverId} cacheScope={`${conversationId || "workbench"}:${workspaceId}`} workspacePath={workspacePath} /> : null}
        {activeTab === "scheduler" && tabIsAvailable(capabilities, "scheduler") && conversationId && branchId ? <SchedulerPane serverId={serverId} workspaceId={workspaceId} conversationId={conversationId} branchId={branchId} capability={capabilities.features.scheduler} /> : null}
      </Suspense> : null}
    </div>
  </section>;
}
