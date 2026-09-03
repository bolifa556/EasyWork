"use client";

import { Suspense, lazy, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeft,
  ChevronRight,
  CircleUserRound,
  FileStack,
  Folder,
  FolderOpen,
  HelpCircle,
  Home,
  LayoutDashboard,
  LoaderCircle,
  Menu,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Pin,
  Plus,
  Search,
  Server,
  Settings2,
  Sparkles,
  SquarePen,
  Trash2,
} from "lucide-react";
import type { ConversationSummary, Page, ProjectSummary } from "@/app/core/contracts";
import { commandId } from "@/app/core/gateway/client";
import { useAppRuntime } from "../runtime/AppRuntime";
import { announceConversationsChanged } from "../runtime/cacheEvents";
import { LoadingState } from "../ui/LoadingState";
import { FeatureErrorBoundary } from "../ui/FeatureErrorBoundary";
import { AccountDialog } from "./AccountDialog";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { WorkspaceSidebar } from "../features/workspace/WorkspaceSidebar";
import styles from "./AppShell.module.css";

const loadConversationView = () => import("../features/conversation/ConversationView");
const loadLibraryView = () => import("../features/library/LibraryView");
const loadSkillsView = () => import("../features/skills/SkillsView");
const loadHelpView = () => import("../features/help/HelpView");
const loadAdminView = () => import("../features/admin/AdminView");
const loadServerManager = () => import("../features/servers/ServerManager");
const loadProjectView = () => import("../features/projects/ProjectView");

const ConversationView = lazy(loadConversationView);
const LibraryView = lazy(loadLibraryView);
const SkillsView = lazy(loadSkillsView);
const HelpView = lazy(loadHelpView);
const AdminView = lazy(loadAdminView);
const ServerManager = lazy(loadServerManager);
const ProjectView = lazy(loadProjectView);

function warmFeature(loader: () => Promise<unknown>) {
  void loader().catch(() => undefined);
}

type ShellMenu =
  | { kind: "conversation"; item: ConversationSummary; left: number; top: number; page: "main" | "projects"; trigger: HTMLButtonElement }
  | { kind: "project"; item: ProjectSummary; left: number; top: number; trigger: HTMLButtonElement };

type ConversationRename = { item: ConversationSummary; value: string; saving: boolean };
type ProjectRename = { item: ProjectSummary; value: string; saving: boolean };
type PendingProjectDelete = { item: ProjectSummary; idempotencyKey: string };
type ProjectConversationPage = {
  items: ConversationSummary[];
  nextCursor: string | null;
  loaded: boolean;
  loading: boolean;
  error: string | null;
};

const SIDEBAR_DEFAULT_WIDTH = 252;
const SIDEBAR_MIN_WIDTH = 232;
const SIDEBAR_MAX_WIDTH = 420;
const SIDEBAR_COLLAPSED_WIDTH = 56;
const INITIAL_CHAT_LIMIT = 8;
const INITIAL_PROJECT_CHAT_LIMIT = 4;
const EMPTY_PROJECT_IDS = new Set<string>();
const EMPTY_PROJECT_PAGES: Record<string, ProjectConversationPage> = {};

function mergeConversationPages(...pages: Array<ConversationSummary[] | null | undefined>) {
  const merged = new Map<string, ConversationSummary>();
  for (const page of pages) for (const item of page ?? []) merged.set(item.id, { ...item, runningTaskId: item.runningTaskId ?? null });
  return [...merged.values()];
}

function clampSidebarWidth(width: number) {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width));
}

function ScrollingTitle({ title }: { title: string }) {
  const viewportRef = useRef<HTMLSpanElement | null>(null);
  const textRef = useRef<HTMLSpanElement | null>(null);
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    const measure = () => {
      const viewport = viewportRef.current;
      const text = textRef.current;
      setOffset(viewport && text ? Math.max(0, Math.ceil(text.scrollWidth - viewport.clientWidth + 14)) : 0);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    if (viewportRef.current) observer?.observe(viewportRef.current);
    if (textRef.current) observer?.observe(textRef.current);
    return () => observer?.disconnect();
  }, [title]);

  return <span className={`${styles.treeLabel} ${styles.titleViewport} ${offset ? styles.titleScrollable : ""}`} ref={viewportRef} style={{ "--title-offset": `${offset}px` } as CSSProperties}><span ref={textRef}>{title}</span></span>;
}

export function AppShell() {
  const runtime = useAppRuntime();
  const [desktopSidebarCollapsed, setDesktopSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT_WIDTH);
  const [resizingSidebar, setResizingSidebar] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [projectsOpen, setProjectsOpen] = useState(true);
  const [chatsOpen, setChatsOpen] = useState(true);
  const [expandedProjectsCache, setExpandedProjectsCache] = useState<{ key: string; items: Set<string> }>({ key: "", items: new Set() });
  const [expandedProjectListsCache, setExpandedProjectListsCache] = useState<{ key: string; items: Set<string> }>({ key: "", items: new Set() });
  const [showAllProjects, setShowAllProjects] = useState(false);
  const [showAllChatsCache, setShowAllChatsCache] = useState<{ key: string; value: boolean }>({ key: "", value: false });
  const [standaloneChatsCache, setStandaloneChatsCache] = useState<{ key: string; items: ConversationSummary[] } | null>(null);
  const [loadingAllChatsKey, setLoadingAllChatsKey] = useState<string | null>(null);
  const [projectConversationCache, setProjectConversationCache] = useState<{ key: string; pages: Record<string, ProjectConversationPage> }>({ key: "", pages: {} });
  const [searchConversationCache, setSearchConversationCache] = useState<{ key: string; items: ConversationSummary[]; loading: boolean; error: string | null }>({ key: "", items: [], loading: false, error: null });
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState<ShellMenu | null>(null);
  const [conversationRename, setConversationRename] = useState<ConversationRename | null>(null);
  const [conversationPendingDelete, setConversationPendingDelete] = useState<ConversationSummary | null>(null);
  const [deletingConversation, setDeletingConversation] = useState(false);
  const [projectRename, setProjectRename] = useState<ProjectRename | null>(null);
  const [projectPendingDelete, setProjectPendingDelete] = useState<PendingProjectDelete | null>(null);
  const [deletingProject, setDeletingProject] = useState(false);
  const [projectDialog, setProjectDialog] = useState<{ conversationId?: string } | null>(null);
  const [projectName, setProjectName] = useState("");
  const [projectMemoryMode, setProjectMemoryMode] = useState<"project-only" | "global">("project-only");
  const [creatingProject, setCreatingProject] = useState(false);
  const renameInput = useRef<HTMLInputElement | null>(null);
  const renameInFlight = useRef(false);
  const renameCancelled = useRef(false);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const sidebarResizeCleanup = useRef<(() => void) | null>(null);
  const renamingConversationId = conversationRename?.item.id ?? null;
  const renameSaving = conversationRename?.saving ?? false;
  const projects = useMemo(() => runtime.bootstrap?.projects ?? [], [runtime.bootstrap?.projects]);
  const conversations = useMemo(() => runtime.bootstrap?.recentConversations ?? [], [runtime.bootstrap?.recentConversations]);
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const sidebarCollapsed = desktopSidebarCollapsed && !runtime.workspaceSidebar;
  const bootstrapReady = Boolean(runtime.bootstrap);
  const actorId = runtime.bootstrap?.actor.id;
  const actorIsAdmin = Boolean(runtime.bootstrap?.actor.roles.includes("admin"));
  const bootstrapConversationKey = `${actorId || "guest"}:${runtime.bootstrap?.conversationCursor || "end"}:${conversations.map((item) => `${item.id}:${item.revision}`).join(",")}:${projects.map((project) => `${project.id}:${project.revision}:${project.conversationCount}`).join(",")}`;
  const searchConversationKey = `${bootstrapConversationKey}\n${normalizedQuery}`;
  const expandedProjects = expandedProjectsCache.key === bootstrapConversationKey ? expandedProjectsCache.items : EMPTY_PROJECT_IDS;
  const expandedProjectLists = expandedProjectListsCache.key === bootstrapConversationKey ? expandedProjectListsCache.items : EMPTY_PROJECT_IDS;
  const showAllChats = showAllChatsCache.key === bootstrapConversationKey && showAllChatsCache.value;
  const allStandaloneChats = standaloneChatsCache?.key === bootstrapConversationKey ? standaloneChatsCache.items : null;
  const loadingAllChats = loadingAllChatsKey === bootstrapConversationKey;
  const projectConversationPages = projectConversationCache.key === bootstrapConversationKey ? projectConversationCache.pages : EMPTY_PROJECT_PAGES;
  const searchConversations = searchConversationCache.key === searchConversationKey ? searchConversationCache.items : [];
  const searchLoading = Boolean(normalizedQuery) && (searchConversationCache.key !== searchConversationKey || searchConversationCache.loading);
  const searchError = searchConversationCache.key === searchConversationKey ? searchConversationCache.error : null;
  const standaloneSource = normalizedQuery
    ? searchConversations.filter((item) => !item.projectId)
    : showAllChats && allStandaloneChats ? allStandaloneChats : conversations.slice(0, INITIAL_CHAT_LIMIT);
  const standalone = standaloneSource.filter((item) => !normalizedQuery || item.title.toLocaleLowerCase("zh-CN").includes(normalizedQuery));
  const grouped = new Map(projects.map((project) => [
    project.id,
    normalizedQuery
      ? searchConversations.filter((item) => item.projectId === project.id)
      : projectConversationPages[project.id]?.items ?? [],
  ]));
  const knownConversations = mergeConversationPages(
    conversations,
    allStandaloneChats,
    searchConversations,
    ...Object.values(projectConversationPages).map((page) => page.items),
  );
  const visibleProjects = projects.filter((project) => !normalizedQuery
    || project.name.toLocaleLowerCase("zh-CN").includes(normalizedQuery)
    || (grouped.get(project.id) ?? []).some((item) => item.title.toLocaleLowerCase("zh-CN").includes(normalizedQuery)));
  const displayedProjects = showAllProjects || normalizedQuery ? visibleProjects : visibleProjects.slice(0, 4);

  useEffect(() => () => sidebarResizeCleanup.current?.(), []);

  useEffect(() => {
    if (!normalizedQuery) return undefined;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setSearchConversationCache({ key: searchConversationKey, items: [], loading: true, error: null });
      void (async () => {
        const items: ConversationSummary[] = [];
        const visitedCursors = new Set<string>();
        let cursor: string | null = null;
        do {
          const params = new URLSearchParams({ limit: "100" });
          if (cursor) params.set("cursor", cursor);
          const result = await runtime.api.get<Page<ConversationSummary>>(`/api/conversations?${params}`, controller.signal);
          items.push(...result.data.items);
          const nextCursor = result.data.nextCursor ?? null;
          if (nextCursor && visitedCursors.has(nextCursor)) break;
          if (nextCursor) visitedCursors.add(nextCursor);
          cursor = nextCursor;
        } while (cursor && !controller.signal.aborted);
        if (!controller.signal.aborted) setSearchConversationCache((current) => current.key === searchConversationKey
          ? { ...current, items: mergeConversationPages(items) }
          : current);
      })().catch((reason) => {
        if (!controller.signal.aborted) setSearchConversationCache((current) => current.key === searchConversationKey
          ? { ...current, error: reason instanceof Error ? reason.message : "无法搜索对话" }
          : current);
      }).finally(() => {
        if (!controller.signal.aborted) setSearchConversationCache((current) => current.key === searchConversationKey
          ? { ...current, loading: false }
          : current);
      });
    }, 180);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [normalizedQuery, runtime.api, searchConversationKey]);

  useEffect(() => {
    if (runtime.loading || !bootstrapReady) return undefined;
    const queue: Array<() => Promise<unknown>> = [loadLibraryView, loadSkillsView, loadServerManager, loadHelpView, loadProjectView];
    if (actorIsAdmin) queue.push(loadAdminView);
    let cancelled = false;
    let timer: number | null = null;
    let idleHandle: number | null = null;
    let index = 0;
    const schedule = () => {
      if (cancelled || index >= queue.length) return;
      const run = () => {
        idleHandle = null;
        if (cancelled) return;
        const loader = queue[index++];
        void loader().catch(() => undefined).finally(schedule);
      };
      if (typeof window.requestIdleCallback === "function") idleHandle = window.requestIdleCallback(run, { timeout: 1_500 });
      else timer = window.setTimeout(run, 180);
    };
    timer = window.setTimeout(schedule, 900);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
      if (idleHandle !== null && typeof window.cancelIdleCallback === "function") window.cancelIdleCallback(idleHandle);
    };
  }, [actorId, actorIsAdmin, bootstrapReady, runtime.loading]);

  const toggleAllChats = async () => {
    if (showAllChats) {
      setShowAllChatsCache({ key: bootstrapConversationKey, value: false });
      return;
    }
    if (allStandaloneChats) {
      setShowAllChatsCache({ key: bootstrapConversationKey, value: true });
      return;
    }
    setShowAllChatsCache({ key: bootstrapConversationKey, value: false });
    setStandaloneChatsCache({ key: bootstrapConversationKey, items: [] });
    setLoadingAllChatsKey(bootstrapConversationKey);
    try {
      const items = [...conversations];
      const visitedCursors = new Set<string>();
      let cursor = runtime.bootstrap?.conversationCursor ?? null;
      while (cursor) {
        if (visitedCursors.has(cursor)) break;
        visitedCursors.add(cursor);
        const params = new URLSearchParams({ unassigned: "true", limit: "100", cursor });
        const result = await runtime.api.get<Page<ConversationSummary>>(`/api/conversations?${params}`);
        items.push(...result.data.items);
        cursor = result.data.nextCursor ?? null;
      }
      setStandaloneChatsCache((current) => current && current.key !== bootstrapConversationKey
        ? current
        : { key: bootstrapConversationKey, items: mergeConversationPages(items) });
      setShowAllChatsCache((current) => current.key !== bootstrapConversationKey
        ? current
        : { key: bootstrapConversationKey, value: true });
    } catch (reason) {
      setStandaloneChatsCache((current) => current?.key === bootstrapConversationKey ? null : current);
      runtime.notify(reason instanceof Error ? reason.message : "无法读取全部聊天", "error");
    } finally {
      setLoadingAllChatsKey((current) => current === bootstrapConversationKey ? null : current);
    }
  };

  const loadProjectConversations = async (projectId: string, loadAll = false) => {
    const current = projectConversationPages[projectId];
    if (current?.loading) return false;
    if (current?.loaded && (!loadAll || !current.nextCursor)) return true;
    setProjectConversationCache((cache) => {
      const pages = cache.key === bootstrapConversationKey ? cache.pages : EMPTY_PROJECT_PAGES;
      return {
        key: bootstrapConversationKey,
        pages: {
          ...pages,
          [projectId]: {
            items: pages[projectId]?.items ?? [],
            nextCursor: pages[projectId]?.nextCursor ?? null,
            loaded: pages[projectId]?.loaded ?? false,
            loading: true,
            error: null,
          },
        },
      };
    });
    try {
      const items = [...(current?.items ?? [])];
      const visitedCursors = new Set<string>();
      let cursor = current?.loaded ? current.nextCursor : null;
      do {
        const params = new URLSearchParams({
          projectId,
          limit: loadAll ? "100" : String(INITIAL_PROJECT_CHAT_LIMIT),
        });
        if (cursor) params.set("cursor", cursor);
        const result = await runtime.api.get<Page<ConversationSummary>>(`/api/conversations?${params}`);
        items.push(...result.data.items);
        const nextCursor = result.data.nextCursor ?? null;
        if (nextCursor && visitedCursors.has(nextCursor)) {
          cursor = null;
          break;
        }
        if (nextCursor) visitedCursors.add(nextCursor);
        cursor = nextCursor;
      } while (loadAll && cursor);
      setProjectConversationCache((cache) => cache.key !== bootstrapConversationKey ? cache : ({
        key: bootstrapConversationKey,
        pages: {
          ...cache.pages,
          [projectId]: { items: mergeConversationPages(items), nextCursor: cursor, loaded: true, loading: false, error: null },
        },
      }));
      return true;
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "无法读取项目对话";
      setProjectConversationCache((cache) => cache.key !== bootstrapConversationKey ? cache : ({
        key: bootstrapConversationKey,
        pages: {
          ...cache.pages,
          [projectId]: {
            items: cache.pages[projectId]?.items ?? current?.items ?? [],
            nextCursor: cache.pages[projectId]?.nextCursor ?? current?.nextCursor ?? null,
            loaded: cache.pages[projectId]?.loaded ?? current?.loaded ?? false,
            loading: false,
            error: message,
          },
        },
      }));
      return false;
    }
  };

  const toggleProjectConversationList = async (projectId: string, showAll: boolean) => {
    if (showAll) {
      setExpandedProjectListsCache((cache) => {
        const next = new Set(cache.key === bootstrapConversationKey ? cache.items : EMPTY_PROJECT_IDS);
        next.delete(projectId);
        return { key: bootstrapConversationKey, items: next };
      });
      return;
    }
    if (await loadProjectConversations(projectId, true)) {
      setExpandedProjectListsCache((cache) => {
        const next = new Set(cache.key === bootstrapConversationKey ? cache.items : EMPTY_PROJECT_IDS);
        next.add(projectId);
        return { key: bootstrapConversationKey, items: next };
      });
    }
  };

  const startSidebarResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (sidebarCollapsed || window.matchMedia("(max-width: 720px)").matches) return;
    event.preventDefault();
    sidebarResizeCleanup.current?.();
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    let latestWidth = startWidth;
    let frame: number | null = null;
    const paint = () => {
      frame = null;
      shellRef.current?.style.setProperty("--sidebar-current-width", `${latestWidth}px`);
    };
    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      latestWidth = clampSidebarWidth(startWidth + moveEvent.clientX - startX);
      if (frame === null) frame = window.requestAnimationFrame(paint);
    };
    const stop = (stopEvent?: PointerEvent) => {
      if (stopEvent && stopEvent.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      if (frame !== null) window.cancelAnimationFrame(frame);
      if (stopEvent) latestWidth = clampSidebarWidth(startWidth + stopEvent.clientX - startX);
      shellRef.current?.style.setProperty("--sidebar-current-width", `${latestWidth}px`);
      sidebarResizeCleanup.current = null;
      setResizingSidebar(false);
      setSidebarWidth(latestWidth);
    };
    sidebarResizeCleanup.current = stop;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    setResizingSidebar(true);
  };

  const resizeSidebarWithKeyboard = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      setSidebarWidth((current) => clampSidebarWidth(current + (event.key === "ArrowLeft" ? -12 : 12)));
    } else if (event.key === "Home") {
      event.preventDefault();
      setSidebarWidth(SIDEBAR_MIN_WIDTH);
    } else if (event.key === "End") {
      event.preventDefault();
      setSidebarWidth(SIDEBAR_MAX_WIDTH);
    }
  };

  useEffect(() => {
    if (!menu) return undefined;
    const focusFirst = window.requestAnimationFrame(() => {
      const root = document.querySelector<HTMLElement>(`[data-shell-menu="${menu.kind}"]`);
      root?.querySelectorAll("button").forEach((button) => button.setAttribute("role", "menuitem"));
      root?.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus();
    });
    const close = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      const trigger = menu.trigger;
      setMenu(null);
      window.requestAnimationFrame(() => trigger.focus());
    };
    document.addEventListener("keydown", close);
    return () => {
      window.cancelAnimationFrame(focusFirst);
      document.removeEventListener("keydown", close);
    };
  }, [menu]);

  useEffect(() => {
    if (!renamingConversationId || renameSaving) return undefined;
    const handle = window.requestAnimationFrame(() => {
      renameInput.current?.focus();
      renameInput.current?.select();
    });
    return () => window.cancelAnimationFrame(handle);
  }, [renameSaving, renamingConversationId]);

  const createProject = async () => {
    const name = projectName.trim();
    if (!name) return;
    setCreatingProject(true);
    try {
      const result = await runtime.api.post<{ id: string }>("/api/projects", { name, memoryMode: projectMemoryMode });
      const conversation = projectDialog?.conversationId
        ? knownConversations.find((item) => item.id === projectDialog.conversationId)
        : null;
      if (conversation) {
        await runtime.api.patch(`/api/conversations/${encodeURIComponent(conversation.id)}`, { projectId: result.data.id }, {
          expectedRevision: conversation.revision,
          idempotencyKey: commandId("conversation-move-new-project"),
        });
      }
      setProjectDialog(null);
      setProjectName("");
      setProjectMemoryMode("project-only");
      await runtime.refreshBootstrap();
      if (!conversation) runtime.navigate({ kind: "project", projectId: result.data.id });
    } catch (reason) {
      runtime.notify(reason instanceof Error ? reason.message : "无法创建项目", "error");
    } finally { setCreatingProject(false); }
  };

  const openProjectDialog = (conversationId?: string) => {
    setMenu(null);
    setProjectName("");
    setProjectMemoryMode("project-only");
    setProjectDialog({ conversationId });
  };

  const openMenu = (event: ReactMouseEvent<HTMLButtonElement>, next: Omit<ShellMenu, "left" | "top">) => {
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    setMenu({ ...next, trigger: event.currentTarget, left: Math.max(10, Math.min(window.innerWidth - 210, rect.right + 5)), top: Math.max(10, Math.min(window.innerHeight - 290, rect.top)) } as ShellMenu);
  };

  const moveMenuFocus = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not([disabled])')];
    if (!items.length) return;
    event.preventDefault();
    const current = Math.max(0, items.indexOf(document.activeElement as HTMLButtonElement));
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? items.length - 1
        : event.key === 'ArrowDown' ? (current + 1) % items.length
          : (current - 1 + items.length) % items.length;
    items[next].focus();
  };

  const conversationAction = async (item: ConversationSummary, action: "move" | "pin", projectId?: string | null) => {
    try {
      const body = action === "move" ? { projectId: projectId ?? null } : { pinned: !item.pinned };
      await runtime.api.patch(`/api/conversations/${encodeURIComponent(item.id)}`, body, { expectedRevision: item.revision, idempotencyKey: commandId(`conversation-${action}`) });
      setMenu(null);
      await runtime.refreshBootstrap();
    } catch (reason) { runtime.notify(reason instanceof Error ? reason.message : "对话操作失败", "error"); }
  };

  const beginConversationRename = (item: ConversationSummary) => {
    setMenu(null);
    renameCancelled.current = false;
    setConversationRename({ item, value: item.title, saving: false });
  };

  const saveConversationRename = async () => {
    const editing = conversationRename;
    if (!editing || renameInFlight.current) return;
    if (renameCancelled.current) {
      renameCancelled.current = false;
      setConversationRename(null);
      return;
    }
    const title = editing.value.trim();
    if (!title || title === editing.item.title) {
      setConversationRename(null);
      return;
    }
    renameInFlight.current = true;
    setConversationRename((current) => current?.item.id === editing.item.id ? { ...current, saving: true } : current);
    try {
      await runtime.api.patch(`/api/conversations/${encodeURIComponent(editing.item.id)}`, { title }, {
        expectedRevision: editing.item.revision,
        idempotencyKey: commandId("conversation-rename"),
      });
      setConversationRename(null);
      await runtime.refreshBootstrap();
      announceConversationsChanged({ conversationId: editing.item.id, kind: "renamed" });
      runtime.notify("对话已重命名", "success");
    } catch (reason) {
      setConversationRename((current) => current?.item.id === editing.item.id ? { ...current, saving: false } : current);
      runtime.notify(reason instanceof Error ? reason.message : "对话重命名失败", "error");
      window.requestAnimationFrame(() => renameInput.current?.focus());
    } finally { renameInFlight.current = false; }
  };

  const deleteConversation = async () => {
    const item = conversationPendingDelete;
    if (!item || deletingConversation) return;
    setDeletingConversation(true);
    try {
      // The title worker may advance the conversation revision after the
      // sidebar item was rendered. Resolve the latest revision at commit time
      // so an automatic title does not turn a user-confirmed delete into a
      // stale-revision failure.
      const latest = await runtime.api.get<{ summary: { revision: number } }>(`/api/conversations/${encodeURIComponent(item.id)}`);
      await runtime.api.delete(`/api/conversations/${encodeURIComponent(item.id)}`, {
        expectedRevision: latest.data.summary.revision,
        idempotencyKey: commandId("conversation-delete"),
      });
      setConversationPendingDelete(null);
      await runtime.refreshBootstrap();
      announceConversationsChanged({ conversationId: item.id, kind: "deleted" });
      if (runtime.view.kind === "conversation" && runtime.view.conversationId === item.id) runtime.navigate({ kind: "home" }, { replace: true });
      runtime.notify("对话已删除", "success");
    } catch (reason) { runtime.notify(reason instanceof Error ? reason.message : "对话删除失败", "error"); }
    finally { setDeletingConversation(false); }
  };

  const renameProject = async () => {
    if (!projectRename || projectRename.saving) return;
    const name = projectRename.value.trim();
    if (!name) return;
    const item = projectRename.item;
    setProjectRename((current) => current ? { ...current, saving: true } : current);
    try {
      await runtime.api.patch(`/api/projects/${encodeURIComponent(item.id)}`, { name }, { expectedRevision: item.revision });
      setProjectRename(null);
      await runtime.refreshBootstrap();
    } catch (reason) {
      runtime.notify(reason instanceof Error ? reason.message : "项目操作失败", "error");
      setProjectRename((current) => current ? { ...current, saving: false } : current);
    }
  };

  const deleteProject = async () => {
    const pending = projectPendingDelete;
    if (!pending || deletingProject) return;
    setDeletingProject(true);
    try {
      await runtime.api.delete(`/api/projects/${encodeURIComponent(pending.item.id)}`, {
        expectedRevision: pending.item.revision,
        idempotencyKey: pending.idempotencyKey,
      });
      setProjectPendingDelete(null);
      await runtime.refreshBootstrap();
      if (runtime.view.kind === "project" && runtime.view.projectId === pending.item.id) runtime.navigate({ kind: "home" }, { replace: true });
      runtime.notify("项目已删除", "success");
    } catch (reason) { runtime.notify(reason instanceof Error ? reason.message : "项目删除失败", "error"); }
    finally { setDeletingProject(false); }
  };

  const renderConversation = (conversation: ConversationSummary, nested = false) => {
    const active = runtime.view.kind === "conversation" && runtime.view.conversationId === conversation.id;
    const editing = conversationRename?.item.id === conversation.id ? conversationRename : null;
    return <div className={`${styles.conversationRow} ${editing ? styles.renamingConversation : ""}`} key={conversation.id}>
      {editing ? <form className={`${styles.treeItem} ${styles.renameItem} ${nested ? styles.nested : ""} ${active ? styles.active : ""}`} onSubmit={(event) => { event.preventDefault(); void saveConversationRename(); }}>
        <input
          ref={renameInput}
          className={styles.renameInput}
          aria-label={`重命名“${conversation.title}”`}
          disabled={editing.saving}
          maxLength={240}
          value={editing.value}
          onChange={(event) => setConversationRename((current) => current?.item.id === conversation.id ? { ...current, value: event.target.value } : current)}
          onBlur={() => void saveConversationRename()}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            renameCancelled.current = true;
            setConversationRename(null);
          }}
        />
        {editing.saving ? <LoaderCircle className={styles.spin} size={14} /> : null}
      </form> : <button className={`${styles.treeItem} ${nested ? styles.nested : ""} ${active ? styles.active : ""}`} onClick={() => runtime.navigate({ kind: "conversation", conversationId: conversation.id })}><ScrollingTitle title={conversation.title} /><span className={styles.kind}>{conversation.mode === "work" ? "工作" : "聊天"}</span></button>}
      {!editing ? <button className={styles.conversationMore} aria-label={`${conversation.title} 更多操作`} aria-haspopup="menu" aria-expanded={menu?.kind === "conversation" && menu.item.id === conversation.id} onClick={(event) => openMenu(event, { kind: "conversation", item: conversation, page: "main" })}><MoreHorizontal size={15} /></button> : null}
    </div>;
  };

  if (runtime.loading) return <div className={styles.app}><aside className={styles.sidebar} /><main className={`${styles.main} ${styles.loading}`}><LoadingState /></main></div>;
  if (runtime.error || !runtime.bootstrap) return <div className={styles.app}><main className={`${styles.main} ${styles.fatal}`}><h1>EasyWork 服务暂时不可用</h1><p>{runtime.error}</p><button onClick={() => window.location.reload()}>重新连接</button></main></div>;
  const actor = runtime.bootstrap.actor;
  const workspaceSidebarActive = runtime.view.kind === "conversation"
    && runtime.workspaceSidebar?.conversationId === runtime.view.conversationId
    ? runtime.workspaceSidebar
    : null;

  const main = (() => {
    if (runtime.view.kind === "home") return <ConversationView initialProjectId={runtime.view.projectId} initialMode={runtime.view.mode} />;
    if (runtime.view.kind === "conversation") return <ConversationView conversationId={runtime.view.conversationId} initialPanel={runtime.view.panel} />;
    if (runtime.view.kind === "library") return <LibraryView collectionId={runtime.view.collectionId} />;
    if (runtime.view.kind === "skills") return <SkillsView />;
    if (runtime.view.kind === "help") return <HelpView />;
    if (runtime.view.kind === "admin") return <AdminView />;
    if (runtime.view.kind === "servers") return <ServerManager />;
    if (runtime.view.kind === "project") return <ProjectView projectId={runtime.view.projectId} />;
    return <ConversationView />;
  })();

  return (
    <div
      ref={shellRef}
      className={`${styles.app} ${sidebarCollapsed ? styles.sidebarCollapsed : ""} ${resizingSidebar ? styles.sidebarResizing : ""}`}
      style={{ "--sidebar-current-width": `${sidebarCollapsed ? SIDEBAR_COLLAPSED_WIDTH : sidebarWidth}px` } as CSSProperties}
    >
      <button className={`${styles.scrim} ${runtime.sidebarOpen ? styles.open : ""}`} aria-label="关闭菜单" onClick={() => runtime.setSidebarOpen(false)} />
      <aside className={`${styles.sidebar} ${runtime.sidebarOpen ? styles.open : ""}`}>
        <div className={styles.collapsedRail}>
          <div className={styles.collapsedTop}>
            <button className={styles.openSidebarButton} aria-label="打开侧边栏" title="打开侧边栏" onClick={() => setDesktopSidebarCollapsed(false)}>
              <span className={styles.collapsedMark}>E</span>
              <PanelLeftOpen className={styles.openSidebarIcon} size={19} />
            </button>
            <button className={styles.collapsedAction} aria-label="新对话" title="新对话" onClick={() => runtime.navigate({ kind: "home" })}><SquarePen size={19} /></button>
          </div>
          <button className={styles.collapsedAccount} aria-label={actor.type === "user" ? actor.username : "登录或注册"} title={actor.type === "user" ? actor.username : "登录或注册"} onClick={() => setAccountOpen(true)}>
            <span className={styles.avatar}>{actor.type === "user" ? actor.username.slice(0, 1).toUpperCase() : <CircleUserRound size={16} />}</span>
          </button>
        </div>
        <div className={styles.expandedSidebar}>
          <div className={styles.brand}>
            <button className={styles.brandButton} onClick={() => runtime.navigate({ kind: "home" })}><span className={styles.mark}>E</span><span>EasyWork</span></button>
            {workspaceSidebarActive ? <button className={styles.sidebarReturn} aria-label="返回对话界面" title="返回" onClick={() => { setDesktopSidebarCollapsed(false); runtime.setWorkspaceSidebar(null); runtime.closeWorkspacePreviews(workspaceSidebarActive.conversationId); }}><ArrowLeft size={18} /></button> : <button className={`${styles.search} ${searchOpen ? styles.searchActive : ""}`} aria-label="搜索" onClick={() => { setSearchOpen((value) => !value); if (searchOpen) setQuery(""); }}><Search size={18} /></button>}
            <button className={styles.sidebarToggle} aria-label="关闭侧边栏" title="关闭侧边栏" onClick={() => setDesktopSidebarCollapsed(true)}><PanelLeftClose size={18} /></button>
          </div>
        {workspaceSidebarActive ? <>
          <WorkspaceSidebar key={`${workspaceSidebarActive.serverId}:${workspaceSidebarActive.workspaceId}`} session={workspaceSidebarActive} />
          <footer className={styles.footer}>
            {actor.roles.includes("admin") ? <button className={`${styles.footerItem} ${runtime.view.kind === "admin" ? styles.active : ""}`} onClick={() => runtime.navigate({ kind: "admin" })}><span className={styles.navIcon}><Settings2 size={17} /></span>管理员面板</button> : null}
            <button className={styles.footerItem} onClick={() => setAccountOpen(true)}><span className={styles.avatar}>{actor.type === "user" ? actor.username.slice(0, 1).toUpperCase() : <CircleUserRound size={16} />}</span><span className={styles.treeLabel}>{actor.type === "user" ? actor.username : "登录或注册"}</span></button>
          </footer>
        </> : <>
        <nav className={styles.fixedNav} aria-label="快捷操作">
          <button className={`${styles.navItem} ${runtime.view.kind === "home" ? styles.active : ""}`} onClick={() => runtime.navigate({ kind: "home" })}><span className={styles.navIcon}><Plus size={18} /></span>新对话</button>
          {searchOpen ? <div className={styles.searchBox}><span className={styles.navIcon}><Search size={17} /></span><input autoFocus aria-label="搜索项目和对话" placeholder="搜索项目和对话" value={query} onChange={(event) => setQuery(event.target.value)} /></div> : null}
        </nav>
        <div className={styles.navScroll}>
          <nav className={styles.primaryNav} aria-label="功能导航">
            <button className={`${styles.navItem} ${runtime.view.kind === "library" ? styles.active : ""}`} onPointerEnter={() => warmFeature(loadLibraryView)} onFocus={() => warmFeature(loadLibraryView)} onClick={() => runtime.navigate({ kind: "library" })}><span className={styles.navIcon}><FileStack size={17} /></span>文件库</button>
            <button className={`${styles.navItem} ${runtime.view.kind === "skills" ? styles.active : ""}`} onPointerEnter={() => warmFeature(loadSkillsView)} onFocus={() => warmFeature(loadSkillsView)} onClick={() => runtime.navigate({ kind: "skills" })}><span className={styles.navIcon}><Sparkles size={17} /></span>技能</button>
            <button className={`${styles.navItem} ${runtime.view.kind === "servers" ? styles.active : ""}`} onPointerEnter={() => warmFeature(loadServerManager)} onFocus={() => warmFeature(loadServerManager)} onClick={() => runtime.navigate({ kind: "servers" })}><span className={styles.navIcon}><Server size={17} /></span>远程服务器</button>
            <button className={`${styles.navItem} ${runtime.view.kind === "help" ? styles.active : ""}`} onPointerEnter={() => warmFeature(loadHelpView)} onFocus={() => warmFeature(loadHelpView)} onClick={() => runtime.navigate({ kind: "help" })}><span className={styles.navIcon}><HelpCircle size={17} /></span>帮助</button>
          </nav>
          <section className={styles.section}>
            <div className={styles.sectionHeading}>
              <button className={styles.sectionTitle} aria-expanded={projectsOpen} onClick={() => setProjectsOpen((value) => !value)}>项目 <ChevronRight className={`${styles.sectionChevron} ${projectsOpen ? styles.sectionChevronOpen : ""}`} size={13} /></button>
              <span className={styles.sectionSpacer} />
              <button className={styles.sectionAction} aria-label="新建项目" onClick={() => openProjectDialog()}><Plus size={16} /></button>
            </div>
            <div className={`${styles.sectionMotion} ${projectsOpen ? styles.expanded : ""}`} aria-hidden={!projectsOpen}><div><div className={styles.tree}>
              {displayedProjects.map((project) => {
                const expanded = Boolean(normalizedQuery) || expandedProjects.has(project.id);
                const projectConversations = (grouped.get(project.id) ?? []).filter((item) => !normalizedQuery || item.title.toLocaleLowerCase("zh-CN").includes(normalizedQuery));
                const showAll = expandedProjectLists.has(project.id) || Boolean(normalizedQuery);
                const displayed = showAll ? projectConversations : projectConversations.slice(0, INITIAL_PROJECT_CHAT_LIMIT);
                const projectPage = projectConversationPages[project.id];
                const canToggleProjectList = showAll ? projectConversations.length > INITIAL_PROJECT_CHAT_LIMIT : Boolean(projectPage?.nextCursor);
                return <div key={project.id}>
                  <div className={styles.treeProject}><button className={`${styles.treeItem} ${runtime.view.kind === "project" && runtime.view.projectId === project.id ? styles.active : ""}`} onClick={() => {
                    if (normalizedQuery) return;
                    setExpandedProjectsCache((cache) => {
                      const next = new Set(cache.key === bootstrapConversationKey ? cache.items : EMPTY_PROJECT_IDS);
                      if (expanded) next.delete(project.id); else next.add(project.id);
                      return { key: bootstrapConversationKey, items: next };
                    });
                    if (!expanded && !projectPage?.loaded) void loadProjectConversations(project.id);
                  }}>
                    <span className={styles.navIcon}>{expanded ? <FolderOpen size={17} /> : <Folder size={17} />}</span><span className={styles.treeLabel}>{project.name}</span>
                  </button><button className={styles.projectHome} aria-label={`${project.name} 项目主页`} onClick={() => runtime.navigate({ kind: "project", projectId: project.id })}><Home size={15} /></button><button className={styles.projectMenuButton} aria-label={`${project.name} 更多操作`} aria-haspopup="menu" aria-expanded={menu?.kind === "project" && menu.item.id === project.id} onClick={(event) => openMenu(event, { kind: "project", item: project })}><MoreHorizontal size={15} /></button></div>
                  {project.conversationCount > 0 || projectPage ? <div className={`${styles.projectChatsMotion} ${expanded ? styles.projectChatsExpanded : ""}`} aria-hidden={!expanded}><div><div>
                    {projectPage?.loading && !displayed.length ? <span className={`${styles.treeNotice} ${styles.nested}`}><LoaderCircle className={styles.spin} size={13} />正在读取对话</span> : null}
                    {projectPage?.error ? <button className={`${styles.more} ${styles.nested}`} onClick={() => void loadProjectConversations(project.id, showAll)}>加载失败，点击重试</button> : null}
                    {displayed.map((conversation) => renderConversation(conversation, true))}
                    {canToggleProjectList && !normalizedQuery && !projectPage?.error ? <button className={`${styles.more} ${styles.nested}`} disabled={projectPage?.loading} onClick={() => void toggleProjectConversationList(project.id, showAll)}>{projectPage?.loading ? "正在加载" : showAll ? "收起" : "显示更多"}</button> : null}
                  </div></div></div> : null}
                </div>;
              })}
              {visibleProjects.length > 4 && !normalizedQuery ? <button className={styles.more} onClick={() => setShowAllProjects((current) => !current)}>{showAllProjects ? "收起" : "显示更多"}</button> : null}
            </div></div></div>
          </section>

          <section className={styles.section}>
            <div className={styles.sectionHeading}>
              <button className={styles.sectionTitle} aria-expanded={chatsOpen} onClick={() => setChatsOpen((value) => !value)}>聊天 <ChevronRight className={`${styles.sectionChevron} ${chatsOpen ? styles.sectionChevronOpen : ""}`} size={13} /></button>
              <span className={styles.sectionSpacer} />
              <button className={styles.sectionAction} aria-label="新对话" onClick={() => runtime.navigate({ kind: "home" })}><Plus size={16} /></button>
            </div>
            <div className={`${styles.sectionMotion} ${chatsOpen ? styles.expanded : ""}`} aria-hidden={!chatsOpen}><div><div className={styles.tree}>
              {searchLoading ? <span className={styles.treeNotice}><LoaderCircle className={styles.spin} size={13} />正在搜索</span> : null}
              {searchError ? <span className={styles.treeNotice}>{searchError}</span> : null}
              {standalone.map((conversation) => renderConversation(conversation))}
              {!normalizedQuery && (Boolean(runtime.bootstrap?.conversationCursor) || Boolean(allStandaloneChats && allStandaloneChats.length > INITIAL_CHAT_LIMIT)) ? <button className={styles.more} disabled={loadingAllChats} onClick={() => void toggleAllChats()}>{loadingAllChats ? "正在加载" : showAllChats ? "收起" : "更多"}</button> : null}
            </div></div></div>
          </section>
        </div>
        <footer className={styles.footer}>
          {actor.roles.includes("admin") ? <button className={`${styles.footerItem} ${runtime.view.kind === "admin" ? styles.active : ""}`} onClick={() => runtime.navigate({ kind: "admin" })}><span className={styles.navIcon}><Settings2 size={17} /></span>管理员面板</button> : null}
          <button className={styles.footerItem} onClick={() => setAccountOpen(true)}><span className={styles.avatar}>{actor.type === "user" ? actor.username.slice(0, 1).toUpperCase() : <CircleUserRound size={16} />}</span><span className={styles.treeLabel}>{actor.type === "user" ? actor.username : "登录或注册"}</span></button>
        </footer>
        </>}
        </div>
        <button
          type="button"
          className={styles.resizeHandle}
          aria-label="调整侧边栏宽度"
          title="拖动调整侧边栏宽度"
          onPointerDown={startSidebarResize}
          onKeyDown={resizeSidebarWithKeyboard}
          onDoubleClick={() => setSidebarWidth(SIDEBAR_DEFAULT_WIDTH)}
        />
      </aside>
      <main className={styles.main}>
        <button className={styles.mobileTop} aria-label="打开菜单" onClick={() => runtime.setSidebarOpen(true)}><Menu size={19} /></button>
        <FeatureErrorBoundary resetKey={JSON.stringify(runtime.view)}><Suspense fallback={<LoadingState />}>{main}</Suspense></FeatureErrorBoundary>
      </main>
      <div className={styles.toastStack} aria-live="polite" aria-atomic="false">{runtime.toasts.map((toast) => <div key={toast.id} role={toast.tone === "error" ? "alert" : "status"} className={`${styles.toast} ${styles[toast.tone]}`}>{toast.message}</div>)}</div>
      {accountOpen ? <AccountDialog onClose={() => setAccountOpen(false)} /> : null}
      {projectDialog ? <Modal title="新建项目" size="compact" onClose={() => setProjectDialog(null)}><form className={styles.projectDialog} autoComplete="off" onSubmit={(event) => { event.preventDefault(); void createProject(); }}><label><span>项目名称</span><input autoFocus name="easywork-project-name" autoComplete="off" value={projectName} placeholder="输入项目名称" onChange={(event) => setProjectName(event.target.value)} /></label><fieldset><legend>记忆范围</legend><button type="button" className={projectMemoryMode === "project-only" ? styles.selectedMemory : ""} onClick={() => setProjectMemoryMode("project-only")}><strong>仅项目内</strong><span>只使用该项目中的对话和文件</span></button><button type="button" className={projectMemoryMode === "global" ? styles.selectedMemory : ""} onClick={() => setProjectMemoryMode("global")}><strong>全局记忆</strong><span>也可以使用账号的全局记忆</span></button></fieldset><footer><Button type="button" onClick={() => setProjectDialog(null)}>取消</Button><Button type="submit" variant="primary" disabled={!projectName.trim() || creatingProject}>{creatingProject ? "创建中" : "创建"}</Button></footer></form></Modal> : null}
      {projectRename ? <Modal title="重命名项目" size="compact" onClose={() => { if (!projectRename.saving) setProjectRename(null); }}><form className={styles.renameDialog} onSubmit={(event) => { event.preventDefault(); void renameProject(); }}><label><span>项目名称</span><input autoFocus value={projectRename.value} onChange={(event) => setProjectRename((current) => current ? { ...current, value: event.target.value } : current)} /></label><footer><Button type="button" disabled={projectRename.saving} onClick={() => setProjectRename(null)}>取消</Button><Button type="submit" variant="primary" disabled={projectRename.saving || !projectRename.value.trim() || projectRename.value.trim() === projectRename.item.name}>{projectRename.saving ? "保存中" : "保存"}</Button></footer></form></Modal> : null}
      {conversationPendingDelete ? <Modal title="删除对话？" size="compact" onClose={() => { if (!deletingConversation) setConversationPendingDelete(null); }}><div className={styles.deleteDialog}><p>“{conversationPendingDelete.title}”将从聊天记录中删除，此操作无法撤销。</p><footer><Button disabled={deletingConversation} onClick={() => setConversationPendingDelete(null)}>取消</Button><Button variant="danger" disabled={deletingConversation} icon={deletingConversation ? <LoaderCircle className={styles.spin} size={15} /> : <Trash2 size={15} />} onClick={() => void deleteConversation()}>{deletingConversation ? "正在删除" : "删除"}</Button></footer></div></Modal> : null}
      {projectPendingDelete ? <Modal title="删除项目？" size="compact" onClose={() => { if (!deletingProject) setProjectPendingDelete(null); }}><div className={styles.deleteDialog}><p>“{projectPendingDelete.item.name}”将被删除，项目中的对话会移出项目并继续保留。此操作无法撤销。</p><footer><Button disabled={deletingProject} onClick={() => setProjectPendingDelete(null)}>取消</Button><Button variant="danger" disabled={deletingProject} icon={deletingProject ? <LoaderCircle className={styles.spin} size={15} /> : <Trash2 size={15} />} onClick={() => void deleteProject()}>{deletingProject ? "正在删除" : "删除"}</Button></footer></div></Modal> : null}
      {menu && typeof document !== "undefined" ? createPortal(<><button className={styles.menuScrim} aria-label="关闭菜单" onClick={() => { const trigger = menu.trigger; setMenu(null); window.requestAnimationFrame(() => trigger.focus()); }} /><div className={`${styles.itemMenu} ${menu.kind === "conversation" && menu.page === "projects" ? styles.projectMoveMenu : ""}`} role="menu" aria-label={menu.kind === "conversation" ? `${menu.item.title} 操作` : `${menu.item.name} 操作`} data-shell-menu={menu.kind} onKeyDown={moveMenuFocus} style={{ left: menu.left, top: menu.top }}>{menu.kind === "conversation" ? menu.page === "projects" ? <><div className={styles.menuFixedActions}><button onClick={() => setMenu({ ...menu, page: "main" })}><ChevronRight className={styles.backChevron} size={16} />返回</button><button onClick={() => openProjectDialog(menu.item.id)}><Plus size={16} />新建项目</button>{menu.item.projectId ? <button onClick={() => void conversationAction(menu.item, "move", null)}><Folder size={16} />移出项目</button> : null}</div><span className={styles.menuSeparator} aria-hidden="true" /><div className={`${styles.projectDestinationList} ${projects.filter((project) => project.id !== menu.item.projectId).length > 4 ? styles.projectDestinationScrollable : ""}`}>{projects.filter((project) => project.id !== menu.item.projectId).map((project) => <button key={project.id} onClick={() => void conversationAction(menu.item, "move", project.id)}><Folder size={16} /><span>{project.name}</span></button>)}</div></> : <><button onClick={() => beginConversationRename(menu.item)}><Pencil size={16} />重命名</button><button onClick={() => setMenu({ ...menu, page: "projects" })}><FolderOpen size={16} />移至项目<ChevronRight className={styles.menuTail} size={16} /></button><button onClick={() => void conversationAction(menu.item, "pin")}><Pin size={16} />{menu.item.pinned ? "取消置顶" : "置顶聊天"}</button><button className={styles.dangerMenuItem} onClick={() => { setConversationPendingDelete(menu.item); setMenu(null); }}><Trash2 size={16} />删除</button></> : <><button onClick={() => { runtime.navigate({ kind: "home", projectId: menu.item.id, mode: "chat" }); setMenu(null); }}><Plus size={16} />新对话</button><button onClick={() => { setProjectRename({ item: menu.item, value: menu.item.name, saving: false }); setMenu(null); }}><Pencil size={16} />重命名项目</button><button onClick={() => { runtime.navigate({ kind: "project", projectId: menu.item.id }); setMenu(null); }}><LayoutDashboard size={16} />项目主页</button><button className={styles.dangerMenuItem} onClick={() => { setProjectPendingDelete({ item: menu.item, idempotencyKey: commandId("project-delete") }); setMenu(null); }}><Trash2 size={16} />删除项目</button></>}</div></>, document.body) : null}
    </div>
  );
}
