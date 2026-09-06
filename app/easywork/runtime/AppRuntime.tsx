"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { GatewayClient } from "@/app/core/gateway/client";
import { randomIdentifier } from "@/app/core/identifiers";
import { isActiveTask, mergeTaskSnapshots } from "@/app/core/task-snapshots";
import { RealtimeClient } from "@/app/core/realtime/client";
import { GatewayError, type BootstrapResponse, type ConversationSummary, type ServerCapabilityProfile, type SessionResponse } from "@/app/core/contracts";
import { preloadFeature } from "./feature-loaders";
import { prefetchRouteData } from "./startup-data";
import { startupDestination } from "./startup-route";
import { prefetchHelpDocument } from "../features/help/help-document";
import { useFilePreviewTabs } from "./useFilePreviewTabs";
import { announceConversationsChanged } from "./cacheEvents";
export type { WorkspacePreviewTab } from "./useFilePreviewTabs";

const SESSION_KEY = "easywork.session";
const DEVICE_KEY = "easywork.device";
const DEVICE_INTRO_KEY = "easywork.device-intro-seen";
const DEVICE_INTRO_AUTO_KEY = "easywork.device-intro-auto";

class SessionSource {
  #token: string | null;
  constructor(token: string | null) { this.#token = token; }
  read = () => this.#token;
  write(token: string | null) { this.#token = token; }
}

export type ConversationPanel =
  | { kind: "file"; previewId: string }
  | { kind: "task"; taskId: string }
  | { kind: "artifact"; artifactId: string }
  | { kind: "diff"; changeId: string };

export type AppView =
  | { kind: "home"; projectId?: string; mode?: "chat" | "work" }
  | { kind: "help" }
  | { kind: "library"; collectionId?: string }
  | {
      kind: "skills";
      tab?: "installed" | "market" | "uploads";
      detailId?: string;
      detailSource?: "installed" | "market" | "upload";
      reviewTab?: "pending" | "reviewed";
    }
  | { kind: "servers" }
  | { kind: "admin" }
  | { kind: "project"; projectId: string }
  | { kind: "conversation"; conversationId: string; panel?: ConversationPanel; messageId?: string };

type Toast = { id: string; tone: "neutral" | "success" | "error"; message: string };

export type WorkspaceSidebarSession = {
  conversationId: string;
  serverId: string;
  workspaceId: string;
  workspacePath: string;
  branchId?: string;
  capabilities: ServerCapabilityProfile;
};

type RuntimeValue = ReturnType<typeof useFilePreviewTabs> & {
  api: GatewayClient;
  realtime: RealtimeClient | null;
  token: string | null;
  bootstrap: BootstrapResponse | null;
  loading: boolean;
  error: string | null;
  view: AppView;
  sidebarOpen: boolean;
  rightRailOpen: boolean;
  workspaceSidebar: WorkspaceSidebarSession | null;
  toasts: Toast[];
  navigate: (view: AppView, options?: { replace?: boolean }) => void;
  setSidebarOpen: (open: boolean) => void;
  setRightRailOpen: (open: boolean) => void;
  setWorkspaceSidebar: (session: WorkspaceSidebarSession | null) => void;
  refreshBootstrap: () => Promise<void>;
  updateConversationNavigation: (conversation: Omit<ConversationSummary, "runningTaskId">) => void;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  notify: (message: string, tone?: Toast["tone"]) => void;
};

const RuntimeContext = createContext<RuntimeValue | null>(null);

function deviceId() {
  const stored = localStorage.getItem(DEVICE_KEY);
  if (stored) return stored;
  const value = `device-${randomIdentifier()}`;
  localStorage.setItem(DEVICE_KEY, value);
  return value;
}

function sessionToken() {
  return typeof window === "undefined" ? null : localStorage.getItem(SESSION_KEY);
}

function consumeFirstDeviceVisit() {
  if (localStorage.getItem(DEVICE_INTRO_KEY) === "1") return false;
  localStorage.setItem(DEVICE_INTRO_KEY, "1");
  localStorage.setItem(DEVICE_INTRO_AUTO_KEY, "1");
  return true;
}

function leaveFinishedDeviceIntro() {
  if (localStorage.getItem(DEVICE_INTRO_AUTO_KEY) !== "1" || window.location.pathname !== "/help") return false;
  localStorage.removeItem(DEVICE_INTRO_AUTO_KEY);
  return true;
}

function routeFor(view: AppView) {
  if (view.kind === "home") {
    const query = new URLSearchParams();
    if (view.projectId) query.set("project", view.projectId);
    if (view.mode) query.set("mode", view.mode);
    return query.size ? `/?${query}` : "/";
  }
  if (view.kind === "project") return `/p/${encodeURIComponent(view.projectId)}`;
  if (view.kind === "conversation") {
    const query = new URLSearchParams();
    if (view.panel?.kind === "file") { query.set("view", "file"); query.set("preview", view.panel.previewId); }
    if (view.panel?.kind === "task") { query.set("view", "task"); query.set("task", view.panel.taskId); }
    if (view.panel?.kind === "artifact") { query.set("view", "artifact"); query.set("artifact", view.panel.artifactId); }
    if (view.panel?.kind === "diff") { query.set("view", "diff"); query.set("change", view.panel.changeId); }
    if (view.messageId) query.set("message", view.messageId);
    const suffix = query.size ? `?${query}` : "";
    return `/c/${encodeURIComponent(view.conversationId)}${suffix}`;
  }
  if (view.kind === "library" && view.collectionId) return `/library/${encodeURIComponent(view.collectionId)}`;
  if (view.kind === "skills") {
    const tab = view.tab || (view.detailSource === "market" ? "market" : view.detailSource === "upload" ? "uploads" : "installed");
    const query = new URLSearchParams();
    if (view.reviewTab) query.set("review", view.reviewTab);
    const detail = view.detailId && view.detailSource ? `/${encodeURIComponent(view.detailId)}` : "";
    return `/skills/${tab}${detail}${query.size ? `?${query}` : ""}`;
  }
  return `/${view.kind}`;
}

function parseRoute(pathname: string, search = ""): AppView {
  const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] === "p" && parts[1]) return { kind: "project", projectId: parts[1] };
  if (parts[0] === "c" && parts[1]) {
    const query = new URLSearchParams(search);
    const requestedView = query.get("view");
    const panel = requestedView === "file" && query.get("preview")
      ? { kind: "file" as const, previewId: query.get("preview") as string }
      : requestedView === "task" && query.get("task")
        ? { kind: "task" as const, taskId: query.get("task") as string }
        : requestedView === "artifact" && query.get("artifact")
          ? { kind: "artifact" as const, artifactId: query.get("artifact") as string }
          : requestedView === "diff" && query.get("change")
            ? { kind: "diff" as const, changeId: query.get("change") as string }
            : undefined;
    const messageId = query.get("message") || undefined;
    return { kind: "conversation", conversationId: parts[1], panel, messageId };
  }
  if (parts[0] === "library") return { kind: "library", collectionId: parts[1] };
  if (parts[0] === "skills") {
    const tab = ["installed", "market", "uploads"].includes(parts[1]) ? parts[1] as "installed" | "market" | "uploads" : "installed";
    const detailSource = parts[2] ? tab === "market" ? "market" as const : tab === "uploads" ? "upload" as const : "installed" as const : undefined;
    const query = new URLSearchParams(search);
    const review = query.get("review");
    return {
      kind: "skills",
      tab,
      ...(detailSource && parts[2] ? { detailSource, detailId: parts[2] } : {}),
      ...(review === "pending" || review === "reviewed" ? { reviewTab: review } : {}),
    };
  }
  if (["help", "servers", "admin"].includes(parts[0])) return { kind: parts[0] as Exclude<AppView["kind"], "home" | "project" | "conversation" | "library" | "skills"> };
  const query = new URLSearchParams(search);
  const projectId = query.get("project") || undefined;
  const requestedMode = query.get("mode");
  const mode = requestedMode === "chat" || requestedMode === "work" ? requestedMode : undefined;
  return { kind: "home", projectId, mode };
}

function websocketUrl() {
  const url = new URL("/easywork-ws", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

async function retryGateway<T>(operation: () => Promise<T>) {
  const delays = [0, 450, 1_000, 2_000];
  let lastError: unknown;
  for (const delay of delays) {
    if (delay) await new Promise((resolve) => window.setTimeout(resolve, delay));
    try {
      return await operation();
    } catch (reason) {
      lastError = reason;
      const retryable = reason instanceof GatewayError ? reason.retryable || reason.status === 0 : reason instanceof TypeError;
      if (!retryable) throw reason;
    }
  }
  throw lastError;
}

export function AppRuntimeProvider({ children }: { children: ReactNode }) {
  const [sessionSource] = useState(() => new SessionSource(sessionToken()));
  const [token, setToken] = useState<string | null>(() => sessionSource.read());
  const [bootstrap, setBootstrap] = useState<BootstrapResponse | null>(null);
  const bootstrapGeneration = useRef(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<AppView>(() => typeof window === "undefined"
    ? { kind: "home" }
    : parseRoute(window.location.pathname, window.location.search));
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [rightRailOpen, setRightRailOpen] = useState(false);
  const [workspaceSidebar, setWorkspaceSidebarState] = useState<WorkspaceSidebarSession | null>(null);
  const filePreviews = useFilePreviewTabs();
  const { closeWorkspacePreviews, hideFilePreview } = filePreviews;
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [api] = useState(() => new GatewayClient("", sessionSource.read));
  const [realtime] = useState(() => new RealtimeClient(websocketUrl, sessionSource.read));

  const storeSession = useCallback((next: string | null) => {
    if (sessionSource.read() !== next) closeWorkspacePreviews();
    sessionSource.write(next);
    setToken(next);
    if (next) localStorage.setItem(SESSION_KEY, next);
    else localStorage.removeItem(SESSION_KEY);
  }, [closeWorkspacePreviews, sessionSource, setToken]);

  const notify = useCallback((message: string, tone: Toast["tone"] = "neutral") => {
    const id = randomIdentifier();
    setToasts((current) => [...current, { id, tone, message }]);
    window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), tone === "error" ? 7000 : 3600);
  }, [setToasts]);

  const setWorkspaceSidebar = useCallback((next: WorkspaceSidebarSession | null) => {
    const apply = () => setWorkspaceSidebarState(next);
    const changesSidebarMode = Boolean(workspaceSidebar) !== Boolean(next);
    if (!changesSidebarMode || typeof document === "undefined" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      apply();
      return;
    }
    const transitionDocument = document as Document & {
      startViewTransition?: (update: () => void) => { finished: Promise<void> };
    };
    if (typeof transitionDocument.startViewTransition === "function") {
      document.documentElement.dataset.easyworkSidebarTransition = "true";
      const transition = transitionDocument.startViewTransition(apply);
      const cleanup = () => { delete document.documentElement.dataset.easyworkSidebarTransition; };
      void transition.finished.then(cleanup, cleanup);
    } else apply();
  }, [workspaceSidebar]);

  const refreshBootstrap = useCallback(async () => {
    const requestedSession = sessionSource.read();
    if (!requestedSession) return;
    const generation = ++bootstrapGeneration.current;
    const route = parseRoute(window.location.pathname, window.location.search);
    const query = route.kind === "conversation" ? `?conversationId=${encodeURIComponent(route.conversationId)}` : "";
    const result = await retryGateway(() => api.get<BootstrapResponse>(`/api/bootstrap${query}`));
    if (requestedSession !== sessionSource.read() || generation !== bootstrapGeneration.current) return;
    setBootstrap((current) => {
      if (!current || current.actor.id !== result.data.actor.id) return result.data;
      const incomingIds = new Set(result.data.runningTasks.map((task) => task.id));
      return { ...result.data, runningTasks: mergeTaskSnapshots(current.runningTasks, result.data.runningTasks)
        .filter((task) => incomingIds.has(task.id) && isActiveTask(task)) };
    });
    setError(null);
  }, [api, sessionSource, setBootstrap]);

  const updateConversationNavigation = useCallback((conversation: Omit<ConversationSummary, "runningTaskId">) => {
    const route = parseRoute(window.location.pathname, window.location.search);
    if (route.kind !== "conversation" || route.conversationId !== conversation.id) return;
    setBootstrap((current) => {
      if (!current) return current;
      const page = current.conversationNavigation?.projectConversations;
      return { ...current, conversationNavigation: {
        conversationId: conversation.id,
        conversation: { ...conversation, runningTaskId: current.runningTasks.find((task) => task.conversationId === conversation.id)?.id ?? null },
        projectConversations: page?.projectId === conversation.projectId ? page : null,
      } };
    });
  }, [setBootstrap]);
  useEffect(() => {
    if (!token || !bootstrap?.actor.id) return;
    let timer: number | undefined;
    const unsubscribe = realtime.subscribe(`conversations:${bootstrap.actor.id}`, (event) => {
      if (event.kind !== "conversation.title.updated" || !event.ids.conversationId) return;
      // Coalesce replayed metadata into one list refresh. Each window receives
      // this account-scoped stream, so it needs no additional tab broadcast.
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        announceConversationsChanged({ conversationId: event.ids.conversationId!, kind: "renamed" }, { broadcast: false });
      }, 100);
    });
    return () => { window.clearTimeout(timer); unsubscribe(); };
  }, [token, bootstrap?.actor.id, realtime]);

  useEffect(() => {
    if (loading) return;
    preloadFeature(view.kind);
    if (view.kind === "help") prefetchHelpDocument();
  }, [api, view, loading]);

  useEffect(() => {
    const synchronizeSession = (event: StorageEvent) => {
      if (event.key !== SESSION_KEY || event.newValue === sessionSource.read()) return;
      api.beginSessionTransition();
      closeWorkspacePreviews();
      sessionSource.write(event.newValue);
      setToken(event.newValue);
      if (event.newValue) {
        realtime.reconnectIfSubscribed();
        void refreshBootstrap().catch((reason) => {
          setError(reason instanceof Error ? reason.message : "登录会话同步失败");
        });
      } else {
        realtime.close();
        setBootstrap(null);
      }
    };
    window.addEventListener("storage", synchronizeSession);
    return () => window.removeEventListener("storage", synchronizeSession);
  }, [api, closeWorkspacePreviews, realtime, refreshBootstrap, sessionSource]);

  useEffect(() => {
    if (!token) return;
    let lastRefreshAt = Date.now();
    const synchronizeVisibleState = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastRefreshAt < 5 * 60_000) return;
      lastRefreshAt = Date.now();
      void refreshBootstrap().catch(() => undefined);
    };
    window.addEventListener("focus", synchronizeVisibleState);
    document.addEventListener("visibilitychange", synchronizeVisibleState);
    return () => {
      window.removeEventListener("focus", synchronizeVisibleState);
      document.removeEventListener("visibilitychange", synchronizeVisibleState);
    };
  }, [refreshBootstrap, token]);

  const establishGuest = useCallback(async () => {
    const result = await api.request<SessionResponse>("/api/auth/guest", {
      method: "POST",
      body: { deviceId: deviceId() },
      authenticated: false,
    });
    storeSession(result.data.token);
    return result.data;
  }, [api, storeSession]);

  useEffect(() => {
    const pop = () => {
      setWorkspaceSidebarState(null);
      hideFilePreview();
      const next = parseRoute(window.location.pathname, window.location.search);
      preloadFeature(next.kind);
      prefetchRouteData(api, next);
      setView(next);
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, [api, hideFilePreview]);

  useEffect(() => {
    let cancelled = false;
    // Decide the destination before starting page requests. A first device
    // loads help directly; repeat visits keep the requested route.
    const firstDeviceVisit = localStorage.getItem(DEVICE_INTRO_KEY) !== "1";
    const destination = startupDestination(window.location.pathname, window.location.search, firstDeviceVisit, localStorage.getItem(DEVICE_INTRO_AUTO_KEY) === "1");
    const initialUrl = new URL(destination, window.location.origin);
    const initialView = parseRoute(initialUrl.pathname, initialUrl.search);
    if (!firstDeviceVisit) localStorage.removeItem(DEVICE_INTRO_AUTO_KEY);
    if (destination !== window.location.pathname + window.location.search) {
      setView(initialView);
      window.history.replaceState(null, "", destination);
    }
    preloadFeature(initialView.kind);
    if (initialView.kind === "help") prefetchHelpDocument();
    void (async () => {
      setLoading(true);
      try {
        let activeToken = sessionToken();
        if (activeToken) {
          sessionSource.write(activeToken);
          setToken(activeToken);
        }
        try {
          if (!activeToken) {
            const result = await retryGateway(() => api.request<SessionResponse>("/api/auth/guest", {
              method: "POST",
              body: { deviceId: deviceId() },
              authenticated: false,
            }));
            const session = result.data;
            if (cancelled || sessionSource.read()) return;
            sessionSource.write(session.token);
            setToken(session.token);
            localStorage.setItem(SESSION_KEY, session.token);
            activeToken = session.token;
          }
          prefetchRouteData(api, initialView);
          await refreshBootstrap();
          if (cancelled || sessionSource.read() !== activeToken) return;
          if (consumeFirstDeviceVisit()) {
            setView({ kind: "help" });
            window.history.replaceState(null, "", "/help");
          } else if (leaveFinishedDeviceIntro()) {
            setView({ kind: "home" });
            window.history.replaceState(null, "", "/");
          }
        } catch (reason) {
          if (cancelled || sessionSource.read() !== activeToken) return;
          if (activeToken && reason instanceof GatewayError && (reason.status === 401 || reason.status === 403)) {
            api.beginSessionTransition();
            sessionSource.write(null);
            setToken(null);
            localStorage.removeItem(SESSION_KEY);
            const guest = await retryGateway(() => api.request<SessionResponse>("/api/auth/guest", {
              method: "POST",
              body: { deviceId: deviceId() },
              authenticated: false,
            }));
            const session = guest.data;
            if (cancelled || sessionSource.read()) return;
            sessionSource.write(session.token);
            setToken(session.token);
            localStorage.setItem(SESSION_KEY, session.token);
            activeToken = session.token;
            prefetchRouteData(api, initialView);
            await refreshBootstrap();
            if (cancelled || sessionSource.read() !== activeToken) return;
            if (consumeFirstDeviceVisit()) {
              setView({ kind: "help" });
              window.history.replaceState(null, "", "/help");
            } else if (leaveFinishedDeviceIntro()) {
              setView({ kind: "home" });
              window.history.replaceState(null, "", "/");
            }
          } else throw reason;
        }
        setError(null);
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "无法连接 EasyWork 服务");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [api, refreshBootstrap, sessionSource]);

  useEffect(() => () => realtime.close(), [realtime]);

  const authenticate = useCallback(async (kind: "login" | "register", username: string, password: string) => {
    const previousToken = sessionSource.read();
    const result = await api.request<SessionResponse>(`/api/auth/${kind}`, {
      method: "POST",
      body: { username, password, deviceId: deviceId() },
      authenticated: false,
    });
    if (previousToken) await api.post("/api/auth/logout").catch(() => undefined);
    api.beginSessionTransition();
    storeSession(result.data.token);
    realtime.reconnectIfSubscribed();
    await refreshBootstrap();
    localStorage.removeItem(DEVICE_INTRO_AUTO_KEY);
    setView({ kind: "home" });
    window.history.replaceState(null, "", "/");
    notify(kind === "login" ? "已登录" : "账号已创建", "success");
  }, [api, notify, realtime, refreshBootstrap, sessionSource, setView, storeSession]);

  const logout = useCallback(async () => {
    if (sessionSource.read()) await api.post("/api/auth/logout").catch(() => undefined);
    api.beginSessionTransition();
    realtime.close();
    storeSession(null);
    const session = await establishGuest();
    storeSession(session.token);
    realtime.reconnectIfSubscribed();
    await refreshBootstrap();
    localStorage.removeItem(DEVICE_INTRO_AUTO_KEY);
    setView({ kind: "home" });
    window.history.replaceState(null, "", "/");
  }, [api, establishGuest, realtime, refreshBootstrap, sessionSource, setView, storeSession]);

  const navigate = useCallback((next: AppView, options?: { replace?: boolean }) => {
    localStorage.removeItem(DEVICE_INTRO_AUTO_KEY);
    preloadFeature(next.kind);
    prefetchRouteData(api, next);
    if (next.kind === "help") prefetchHelpDocument();
    const keepsWorkspace = next.kind === "conversation" && workspaceSidebar?.conversationId === next.conversationId;
    if (!keepsWorkspace) {
      setWorkspaceSidebarState(null);
    }
    hideFilePreview();
    setView(next);
    setSidebarOpen(false);
    const method = options?.replace ? "replaceState" : "pushState";
    window.history[method](null, "", routeFor(next));
  }, [api, hideFilePreview, setSidebarOpen, setView, workspaceSidebar?.conversationId]);

  const value = useMemo<RuntimeValue>(() => ({
    api,
    realtime,
    token,
    bootstrap,
    loading,
    error,
    view,
    sidebarOpen,
    rightRailOpen,
    workspaceSidebar,
    ...filePreviews,
    toasts,
    navigate,
    setSidebarOpen,
    setRightRailOpen,
    setWorkspaceSidebar,
    refreshBootstrap,
    updateConversationNavigation,
    login: (username, password) => authenticate("login", username, password),
    register: (username, password) => authenticate("register", username, password),
    logout,
    notify,
  }), [api, authenticate, bootstrap, error, filePreviews, loading, logout, navigate, notify, realtime, refreshBootstrap, updateConversationNavigation, rightRailOpen, setWorkspaceSidebar, sidebarOpen, toasts, token, view, workspaceSidebar]);

  return <RuntimeContext.Provider value={value}>{children}</RuntimeContext.Provider>;
}

export function useAppRuntime() {
  const value = useContext(RuntimeContext);
  if (!value) throw new Error("AppRuntimeProvider is missing");
  return value;
}
