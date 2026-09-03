"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { GatewayClient } from "@/app/core/gateway/client";
import { randomIdentifier } from "@/app/core/identifiers";
import { RealtimeClient } from "@/app/core/realtime/client";
import { GatewayError, type BootstrapResponse, type ServerCapabilityProfile, type SessionResponse } from "@/app/core/contracts";

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
  | { kind: "conversation"; conversationId: string; panel?: ConversationPanel };

type Toast = { id: string; tone: "neutral" | "success" | "error"; message: string };

export type WorkspaceSidebarSession = {
  conversationId: string;
  serverId: string;
  workspaceId: string;
  workspacePath: string;
  branchId?: string;
  capabilities: ServerCapabilityProfile;
};

export type WorkspacePreviewTab = {
  id: string;
  conversationId: string;
  serverId: string;
  workspaceId: string;
  relativePath: string;
  name: string;
  size: number;
};

type RuntimeValue = {
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
  workspacePreviewTabs: WorkspacePreviewTab[];
  activeWorkspacePreviewTabId: string | null;
  toasts: Toast[];
  navigate: (view: AppView, options?: { replace?: boolean }) => void;
  setSidebarOpen: (open: boolean) => void;
  setRightRailOpen: (open: boolean) => void;
  setWorkspaceSidebar: (session: WorkspaceSidebarSession | null) => void;
  openWorkspacePreview: (tab: Omit<WorkspacePreviewTab, "id">) => void;
  selectWorkspacePreview: (id: string) => void;
  closeWorkspacePreview: (id: string) => void;
  closeWorkspacePreviews: (conversationId?: string) => void;
  refreshBootstrap: () => Promise<void>;
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
    return { kind: "conversation", conversationId: parts[1], panel };
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<AppView>(() => typeof window === "undefined"
    ? { kind: "home" }
    : parseRoute(window.location.pathname, window.location.search));
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [rightRailOpen, setRightRailOpen] = useState(false);
  const [workspaceSidebar, setWorkspaceSidebarState] = useState<WorkspaceSidebarSession | null>(null);
  const [workspacePreviewTabs, setWorkspacePreviewTabs] = useState<WorkspacePreviewTab[]>([]);
  const [activeWorkspacePreviewTabId, setActiveWorkspacePreviewTabId] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [api] = useState(() => new GatewayClient("", sessionSource.read));
  const [realtime] = useState(() => new RealtimeClient(websocketUrl, sessionSource.read));

  const storeSession = useCallback((next: string | null) => {
    sessionSource.write(next);
    setToken(next);
    if (next) localStorage.setItem(SESSION_KEY, next);
    else localStorage.removeItem(SESSION_KEY);
  }, [sessionSource, setToken]);

  const notify = useCallback((message: string, tone: Toast["tone"] = "neutral") => {
    const id = randomIdentifier();
    setToasts((current) => [...current, { id, tone, message }]);
    window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), tone === "error" ? 7000 : 3600);
  }, [setToasts]);

  const openWorkspacePreview = useCallback((input: Omit<WorkspacePreviewTab, "id">) => {
    const id = `${input.conversationId}:${input.serverId}:${input.workspaceId}:${input.relativePath}`;
    setWorkspacePreviewTabs((current) => {
      const existing = current.find((entry) => entry.id === id);
      if (existing) return current.map((entry) => entry.id === id ? { ...entry, ...input } : entry);
      return [...current, { ...input, id }].slice(-14);
    });
    setActiveWorkspacePreviewTabId(id);
  }, []);

  const selectWorkspacePreview = useCallback((id: string) => {
    setActiveWorkspacePreviewTabId(id);
  }, []);

  const closeWorkspacePreview = useCallback((id: string) => {
    setWorkspacePreviewTabs((current) => {
      const index = current.findIndex((entry) => entry.id === id);
      const next = current.filter((entry) => entry.id !== id);
      setActiveWorkspacePreviewTabId((active) => {
        if (active !== id) return active;
        return next[Math.min(Math.max(0, index), next.length - 1)]?.id ?? null;
      });
      return next;
    });
  }, []);

  const closeWorkspacePreviews = useCallback((conversationId?: string) => {
    setWorkspacePreviewTabs((current) => {
      const next = conversationId ? current.filter((entry) => entry.conversationId !== conversationId) : [];
      setActiveWorkspacePreviewTabId((active) => active && next.some((entry) => entry.id === active) ? active : next.at(-1)?.id ?? null);
      return next;
    });
  }, []);

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
    if (!sessionSource.read()) return;
    const result = await retryGateway(() => api.get<BootstrapResponse>("/api/bootstrap"));
    setBootstrap(result.data);
    setError(null);
  }, [api, sessionSource, setBootstrap]);

  useEffect(() => {
    const synchronizeSession = (event: StorageEvent) => {
      if (event.key !== SESSION_KEY || event.newValue === sessionSource.read()) return;
      sessionSource.write(event.newValue);
      setToken(event.newValue);
      realtime.reconnectIfSubscribed();
      if (event.newValue) {
        void refreshBootstrap().catch((reason) => {
          setError(reason instanceof Error ? reason.message : "登录会话同步失败");
        });
      } else {
        setBootstrap(null);
      }
    };
    window.addEventListener("storage", synchronizeSession);
    return () => window.removeEventListener("storage", synchronizeSession);
  }, [realtime, refreshBootstrap, sessionSource]);

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
      setWorkspacePreviewTabs([]);
      setActiveWorkspacePreviewTabId(null);
      setView(parseRoute(window.location.pathname, window.location.search));
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);

  useEffect(() => {
    let cancelled = false;
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
            sessionSource.write(session.token);
            setToken(session.token);
            localStorage.setItem(SESSION_KEY, session.token);
            activeToken = session.token;
          }
          const result = await retryGateway(() => api.get<BootstrapResponse>("/api/bootstrap"));
          if (cancelled) return;
          setBootstrap(result.data);
          if (consumeFirstDeviceVisit()) {
            setView({ kind: "help" });
            window.history.replaceState(null, "", "/help");
          } else if (leaveFinishedDeviceIntro()) {
            setView({ kind: "home" });
            window.history.replaceState(null, "", "/");
          }
        } catch (reason) {
          if (activeToken && reason instanceof GatewayError && (reason.status === 401 || reason.status === 403)) {
            sessionSource.write(null);
            setToken(null);
            localStorage.removeItem(SESSION_KEY);
            const guest = await retryGateway(() => api.request<SessionResponse>("/api/auth/guest", {
              method: "POST",
              body: { deviceId: deviceId() },
              authenticated: false,
            }));
            const session = guest.data;
            sessionSource.write(session.token);
            setToken(session.token);
            localStorage.setItem(SESSION_KEY, session.token);
            const result = await retryGateway(() => api.get<BootstrapResponse>("/api/bootstrap"));
            if (cancelled) return;
            setBootstrap(result.data);
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
  }, [api, sessionSource]);

  useEffect(() => () => realtime.close(), [realtime]);

  const authenticate = useCallback(async (kind: "login" | "register", username: string, password: string) => {
    const previousToken = sessionSource.read();
    const result = await api.request<SessionResponse>(`/api/auth/${kind}`, {
      method: "POST",
      body: { username, password, deviceId: deviceId() },
      authenticated: false,
    });
    if (previousToken) await api.post("/api/auth/logout").catch(() => undefined);
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
    const keepsWorkspace = next.kind === "conversation" && workspaceSidebar?.conversationId === next.conversationId;
    if (!keepsWorkspace) {
      setWorkspaceSidebarState(null);
      setWorkspacePreviewTabs([]);
      setActiveWorkspacePreviewTabId(null);
    }
    setView(next);
    setSidebarOpen(false);
    const method = options?.replace ? "replaceState" : "pushState";
    window.history[method](null, "", routeFor(next));
  }, [setSidebarOpen, setView, workspaceSidebar?.conversationId]);

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
    workspacePreviewTabs,
    activeWorkspacePreviewTabId,
    toasts,
    navigate,
    setSidebarOpen,
    setRightRailOpen,
    setWorkspaceSidebar,
    openWorkspacePreview,
    selectWorkspacePreview,
    closeWorkspacePreview,
    closeWorkspacePreviews,
    refreshBootstrap,
    login: (username, password) => authenticate("login", username, password),
    register: (username, password) => authenticate("register", username, password),
    logout,
    notify,
  }), [activeWorkspacePreviewTabId, api, authenticate, bootstrap, closeWorkspacePreview, closeWorkspacePreviews, error, loading, logout, navigate, notify, openWorkspacePreview, realtime, refreshBootstrap, rightRailOpen, selectWorkspacePreview, setWorkspaceSidebar, sidebarOpen, toasts, token, view, workspacePreviewTabs, workspaceSidebar]);

  return <RuntimeContext.Provider value={value}>{children}</RuntimeContext.Provider>;
}

export function useAppRuntime() {
  const value = useContext(RuntimeContext);
  if (!value) throw new Error("AppRuntimeProvider is missing");
  return value;
}
