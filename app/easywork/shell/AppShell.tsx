"use client";

import { Suspense, lazy, useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import {
  Archive,
  Boxes,
  ChevronRight,
  CircleUserRound,
  FileStack,
  Folder,
  FolderOpen,
  HelpCircle,
  Home,
  LayoutDashboard,
  Menu,
  MoreHorizontal,
  Pencil,
  Pin,
  Plus,
  Search,
  Server,
  Settings2,
  Sparkles,
  Trash2,
} from "lucide-react";
import type { ConversationSummary, ProjectSummary } from "@/app/core/contracts";
import { commandId } from "@/app/core/gateway/client";
import { useAppRuntime } from "../runtime/AppRuntime";
import { LoadingState } from "../ui/LoadingState";
import { FeatureErrorBoundary } from "../ui/FeatureErrorBoundary";
import { AccountDialog } from "./AccountDialog";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import styles from "./AppShell.module.css";

const ConversationView = lazy(() => import("../features/conversation/ConversationView"));
const LibraryView = lazy(() => import("../features/library/LibraryView"));
const SkillsView = lazy(() => import("../features/skills/SkillsView"));
const HelpView = lazy(() => import("../features/help/HelpView"));
const AdminView = lazy(() => import("../features/admin/AdminView"));
const ServerManager = lazy(() => import("../features/servers/ServerManager"));
const TaskCenter = lazy(() => import("../features/tasks/TaskCenter"));
const ArtifactCenter = lazy(() => import("../features/artifacts/ArtifactCenter"));
const ProjectView = lazy(() => import("../features/projects/ProjectView"));

type ShellMenu =
  | { kind: "conversation"; item: ConversationSummary; left: number; top: number; page: "main" | "projects"; trigger: HTMLButtonElement }
  | { kind: "project"; item: ProjectSummary; left: number; top: number; trigger: HTMLButtonElement };

export function AppShell() {
  const runtime = useAppRuntime();
  const [accountOpen, setAccountOpen] = useState(false);
  const [projectsOpen, setProjectsOpen] = useState(true);
  const [chatsOpen, setChatsOpen] = useState(true);
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  const [expandedProjectLists, setExpandedProjectLists] = useState<Set<string>>(new Set());
  const [allChatsVisible, setAllChatsVisible] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState<ShellMenu | null>(null);
  const [projectDialog, setProjectDialog] = useState<{ conversationId?: string } | null>(null);
  const [projectName, setProjectName] = useState("");
  const [projectMemoryMode, setProjectMemoryMode] = useState<"project-only" | "global">("project-only");
  const [creatingProject, setCreatingProject] = useState(false);
  const projects = useMemo(() => runtime.bootstrap?.projects ?? [], [runtime.bootstrap?.projects]);
  const conversations = useMemo(() => runtime.bootstrap?.recentConversations ?? [], [runtime.bootstrap?.recentConversations]);
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const standalone = conversations.filter((item) => !item.projectId && (!normalizedQuery || item.title.toLocaleLowerCase("zh-CN").includes(normalizedQuery)));
  const grouped = useMemo(() => new Map(projects.map((project) => [project.id, conversations.filter((item) => item.projectId === project.id)])), [projects, conversations]);
  const visibleProjects = projects.filter((project) => !normalizedQuery
    || project.name.toLocaleLowerCase("zh-CN").includes(normalizedQuery)
    || (grouped.get(project.id) ?? []).some((item) => item.title.toLocaleLowerCase("zh-CN").includes(normalizedQuery)));

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

  const createProject = async () => {
    const name = projectName.trim();
    if (!name) return;
    setCreatingProject(true);
    try {
      const result = await runtime.api.post<{ id: string }>("/api/projects", { name, memoryMode: projectMemoryMode });
      const conversation = projectDialog?.conversationId
        ? conversations.find((item) => item.id === projectDialog.conversationId)
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

  const conversationAction = async (item: ConversationSummary, action: "rename" | "move" | "pin" | "delete", projectId?: string | null) => {
    try {
      if (action === "delete") {
        if (!window.confirm(`删除“${item.title}”？`)) return;
        await runtime.api.delete(`/api/conversations/${encodeURIComponent(item.id)}`, { expectedRevision: item.revision, idempotencyKey: commandId("conversation-delete") });
      } else {
        const body = action === "rename"
          ? { title: window.prompt("重命名对话", item.title)?.trim() }
          : action === "move" ? { projectId: projectId ?? null } : { pinned: !item.pinned };
        if (action === "rename" && !body.title) return;
        await runtime.api.patch(`/api/conversations/${encodeURIComponent(item.id)}`, body, { expectedRevision: item.revision, idempotencyKey: commandId(`conversation-${action}`) });
      }
      setMenu(null);
      await runtime.refreshBootstrap();
      if (action === "delete" && runtime.view.kind === "conversation" && runtime.view.conversationId === item.id) runtime.navigate({ kind: "home" }, { replace: true });
    } catch (reason) { runtime.notify(reason instanceof Error ? reason.message : "对话操作失败", "error"); }
  };

  const projectAction = async (item: ProjectSummary, action: "rename" | "delete") => {
    try {
      if (action === "delete") {
        if (!window.confirm(`删除项目“${item.name}”？`)) return;
        await runtime.api.delete(`/api/projects/${encodeURIComponent(item.id)}`, { expectedRevision: item.revision });
      } else {
        const name = window.prompt("重命名项目", item.name)?.trim();
        if (!name) return;
        await runtime.api.patch(`/api/projects/${encodeURIComponent(item.id)}`, { name }, { expectedRevision: item.revision });
      }
      setMenu(null);
      await runtime.refreshBootstrap();
      if (action === "delete" && runtime.view.kind === "project" && runtime.view.projectId === item.id) runtime.navigate({ kind: "home" }, { replace: true });
    } catch (reason) { runtime.notify(reason instanceof Error ? reason.message : "项目操作失败", "error"); }
  };

  if (runtime.loading) return <div className={styles.app}><aside className={styles.sidebar} /><main className={`${styles.main} ${styles.loading}`}><LoadingState /></main></div>;
  if (runtime.error || !runtime.bootstrap) return <div className={styles.app}><main className={`${styles.main} ${styles.fatal}`}><h1>EasyWork 服务暂时不可用</h1><p>{runtime.error}</p><button onClick={() => window.location.reload()}>重新连接</button></main></div>;
  const actor = runtime.bootstrap.actor;

  const main = (() => {
    if (runtime.view.kind === "home") return <ConversationView initialProjectId={runtime.view.projectId} initialMode={runtime.view.mode} />;
    if (runtime.view.kind === "conversation") return <ConversationView conversationId={runtime.view.conversationId} initialPanel={runtime.view.panel} />;
    if (runtime.view.kind === "library") return <LibraryView collectionId={runtime.view.collectionId} />;
    if (runtime.view.kind === "skills") return <SkillsView />;
    if (runtime.view.kind === "help") return <HelpView />;
    if (runtime.view.kind === "admin") return <AdminView />;
    if (runtime.view.kind === "servers") return <ServerManager />;
    if (runtime.view.kind === "tasks") return <TaskCenter />;
    if (runtime.view.kind === "artifacts") return <ArtifactCenter />;
    if (runtime.view.kind === "project") return <ProjectView projectId={runtime.view.projectId} />;
    return <ConversationView />;
  })();

  return (
    <div className={styles.app}>
      <button className={`${styles.scrim} ${runtime.sidebarOpen ? styles.open : ""}`} aria-label="关闭菜单" onClick={() => runtime.setSidebarOpen(false)} />
      <aside className={`${styles.sidebar} ${runtime.sidebarOpen ? styles.open : ""}`}>
        <div className={styles.brand}>
          <button className={styles.brandButton} onClick={() => runtime.navigate({ kind: "home" })}><span className={styles.mark}>E</span><span>EasyWork</span></button>
          <button className={`${styles.search} ${searchOpen ? styles.searchActive : ""}`} aria-label="搜索" onClick={() => { setSearchOpen((value) => !value); if (searchOpen) setQuery(""); }}><Search size={18} /></button>
        </div>
        {searchOpen ? <div className={styles.searchBox}><Search size={15} /><input autoFocus aria-label="搜索项目和对话" placeholder="搜索项目和对话" value={query} onChange={(event) => setQuery(event.target.value)} /></div> : null}
        <div className={styles.navScroll}>
          <nav className={styles.primaryNav}>
            <button className={`${styles.navItem} ${runtime.view.kind === "home" ? styles.active : ""}`} onClick={() => runtime.navigate({ kind: "home" })}><span className={styles.navIcon}><Plus size={18} /></span>新对话</button>
            <button className={`${styles.navItem} ${runtime.view.kind === "library" ? styles.active : ""}`} onClick={() => runtime.navigate({ kind: "library" })}><span className={styles.navIcon}><FileStack size={17} /></span>文件库</button>
            <button className={`${styles.navItem} ${runtime.view.kind === "skills" ? styles.active : ""}`} onClick={() => runtime.navigate({ kind: "skills" })}><span className={styles.navIcon}><Sparkles size={17} /></span>技能</button>
            <button className={`${styles.navItem} ${runtime.view.kind === "servers" ? styles.active : ""}`} onClick={() => runtime.navigate({ kind: "servers" })}><span className={styles.navIcon}><Server size={17} /></span>远程服务器</button>
            <button className={`${styles.navItem} ${runtime.view.kind === "tasks" ? styles.active : ""}`} onClick={() => runtime.navigate({ kind: "tasks" })}><span className={styles.navIcon}><Boxes size={17} /></span>任务</button>
            <button className={`${styles.navItem} ${runtime.view.kind === "artifacts" ? styles.active : ""}`} onClick={() => runtime.navigate({ kind: "artifacts" })}><span className={styles.navIcon}><Archive size={17} /></span>产物</button>
            <button className={`${styles.navItem} ${runtime.view.kind === "help" ? styles.active : ""}`} onClick={() => runtime.navigate({ kind: "help" })}><span className={styles.navIcon}><HelpCircle size={17} /></span>帮助</button>
          </nav>

          <section className={styles.section}>
            <div className={styles.sectionHeading}>
              <button className={styles.sectionTitle} aria-expanded={projectsOpen} onClick={() => setProjectsOpen((value) => !value)}>项目 <ChevronRight className={`${styles.sectionChevron} ${projectsOpen ? styles.sectionChevronOpen : ""}`} size={13} /></button>
              <span className={styles.sectionSpacer} />
              <button className={styles.sectionAction} aria-label="新建项目" onClick={() => openProjectDialog()}><Plus size={16} /></button>
            </div>
            <div className={`${styles.sectionMotion} ${projectsOpen ? styles.expanded : ""}`} aria-hidden={!projectsOpen}><div><div className={styles.tree}>
              {visibleProjects.map((project) => {
                const expanded = expandedProjects.has(project.id);
                const projectConversations = (grouped.get(project.id) ?? []).filter((item) => !normalizedQuery || item.title.toLocaleLowerCase("zh-CN").includes(normalizedQuery));
                const showAll = expandedProjectLists.has(project.id) || Boolean(normalizedQuery);
                const displayed = showAll ? projectConversations : projectConversations.slice(0, 4);
                return <div key={project.id}>
                  <div className={styles.treeProject}><button className={`${styles.treeItem} ${runtime.view.kind === "project" && runtime.view.projectId === project.id ? styles.active : ""}`} onClick={() => setExpandedProjects((current) => { const next = new Set(current); if (expanded) next.delete(project.id); else next.add(project.id); return next; })}>
                    <span className={styles.navIcon}>{expanded ? <FolderOpen size={17} /> : <Folder size={17} />}</span><span className={styles.treeLabel}>{project.name}</span>
                  </button><button className={styles.projectHome} aria-label={`${project.name} 项目主页`} onClick={() => runtime.navigate({ kind: "project", projectId: project.id })}><Home size={15} /></button><button className={styles.projectMenuButton} aria-label={`${project.name} 更多操作`} aria-haspopup="menu" aria-expanded={menu?.kind === "project" && menu.item.id === project.id} onClick={(event) => openMenu(event, { kind: "project", item: project })}><MoreHorizontal size={15} /></button></div>
                  {expanded ? <>{displayed.map((conversation) => <div className={styles.conversationRow} key={conversation.id}><button className={`${styles.treeItem} ${styles.nested} ${runtime.view.kind === "conversation" && runtime.view.conversationId === conversation.id ? styles.active : ""}`} onClick={() => runtime.navigate({ kind: "conversation", conversationId: conversation.id })}><span className={styles.treeLabel}>{conversation.title}</span><span className={styles.kind}>{conversation.mode === "work" ? "工作" : "聊天"}</span></button><button className={styles.conversationMore} aria-label={`${conversation.title} 更多操作`} aria-haspopup="menu" aria-expanded={menu?.kind === "conversation" && menu.item.id === conversation.id} onClick={(event) => openMenu(event, { kind: "conversation", item: conversation, page: "main" })}><MoreHorizontal size={15} /></button></div>)}{projectConversations.length > 4 && !normalizedQuery ? <button className={`${styles.more} ${styles.nested}`} onClick={() => setExpandedProjectLists((current) => { const next = new Set(current); if (showAll) next.delete(project.id); else next.add(project.id); return next; })}>{showAll ? "收起" : "显示更多"}</button> : null}</> : null}
                </div>;
              })}
            </div></div></div>
          </section>

          <section className={styles.section}>
            <div className={styles.sectionHeading}>
              <button className={styles.sectionTitle} aria-expanded={chatsOpen} onClick={() => setChatsOpen((value) => !value)}>聊天 <ChevronRight className={`${styles.sectionChevron} ${chatsOpen ? styles.sectionChevronOpen : ""}`} size={13} /></button>
              <span className={styles.sectionSpacer} />
              <button className={styles.sectionAction} aria-label="新对话" onClick={() => runtime.navigate({ kind: "home" })}><Plus size={16} /></button>
            </div>
            <div className={`${styles.sectionMotion} ${chatsOpen ? styles.expanded : ""}`} aria-hidden={!chatsOpen}><div><div className={styles.tree}>{(allChatsVisible || normalizedQuery ? standalone : standalone.slice(0, 8)).map((conversation) => <div className={styles.conversationRow} key={conversation.id}><button className={`${styles.treeItem} ${runtime.view.kind === "conversation" && runtime.view.conversationId === conversation.id ? styles.active : ""}`} onClick={() => runtime.navigate({ kind: "conversation", conversationId: conversation.id })}><span className={styles.treeLabel}>{conversation.title}</span><span className={styles.kind}>{conversation.mode === "work" ? "工作" : "聊天"}</span></button><button className={styles.conversationMore} aria-label={`${conversation.title} 更多操作`} aria-haspopup="menu" aria-expanded={menu?.kind === "conversation" && menu.item.id === conversation.id} onClick={(event) => openMenu(event, { kind: "conversation", item: conversation, page: "main" })}><MoreHorizontal size={15} /></button></div>)}{standalone.length > 8 && !normalizedQuery ? <button className={styles.more} onClick={() => setAllChatsVisible((value) => !value)}>{allChatsVisible ? "收起" : "显示更多"}</button> : null}</div></div></div>
          </section>
        </div>
        <footer className={styles.footer}>
          {actor.roles.includes("admin") ? <button className={`${styles.footerItem} ${runtime.view.kind === "admin" ? styles.active : ""}`} onClick={() => runtime.navigate({ kind: "admin" })}><span className={styles.navIcon}><Settings2 size={17} /></span>管理员面板</button> : null}
          <button className={styles.footerItem} onClick={() => setAccountOpen(true)}><span className={styles.avatar}>{actor.type === "user" ? actor.username.slice(0, 1).toUpperCase() : <CircleUserRound size={16} />}</span><span className={styles.treeLabel}>{actor.type === "user" ? actor.username : "登录或注册"}</span></button>
        </footer>
      </aside>
      <main className={styles.main}>
        <button className={styles.mobileTop} aria-label="打开菜单" onClick={() => runtime.setSidebarOpen(true)}><Menu size={19} /></button>
        <FeatureErrorBoundary resetKey={JSON.stringify(runtime.view)}><Suspense fallback={<LoadingState />}>{main}</Suspense></FeatureErrorBoundary>
      </main>
      <div className={styles.toastStack} aria-live="polite" aria-atomic="false">{runtime.toasts.map((toast) => <div key={toast.id} role={toast.tone === "error" ? "alert" : "status"} className={`${styles.toast} ${styles[toast.tone]}`}>{toast.message}</div>)}</div>
      {accountOpen ? <AccountDialog onClose={() => setAccountOpen(false)} /> : null}
      {projectDialog ? <Modal title="新建项目" size="compact" onClose={() => setProjectDialog(null)}><form className={styles.projectDialog} onSubmit={(event) => { event.preventDefault(); void createProject(); }}><label><span>项目名称</span><input autoFocus value={projectName} placeholder="输入项目名称" onChange={(event) => setProjectName(event.target.value)} /></label><fieldset><legend>记忆范围</legend><button type="button" className={projectMemoryMode === "project-only" ? styles.selectedMemory : ""} onClick={() => setProjectMemoryMode("project-only")}><strong>仅项目内</strong><span>只使用该项目中的对话和文件</span></button><button type="button" className={projectMemoryMode === "global" ? styles.selectedMemory : ""} onClick={() => setProjectMemoryMode("global")}><strong>全局记忆</strong><span>也可以使用账号的全局记忆</span></button></fieldset><footer><Button type="button" onClick={() => setProjectDialog(null)}>取消</Button><Button type="submit" variant="primary" disabled={!projectName.trim() || creatingProject}>{creatingProject ? "创建中" : "创建"}</Button></footer></form></Modal> : null}
      {menu && typeof document !== "undefined" ? createPortal(<><button className={styles.menuScrim} aria-label="关闭菜单" onClick={() => { const trigger = menu.trigger; setMenu(null); window.requestAnimationFrame(() => trigger.focus()); }} /><div className={styles.itemMenu} role="menu" aria-label={menu.kind === "conversation" ? `${menu.item.title} 操作` : `${menu.item.name} 操作`} data-shell-menu={menu.kind} onKeyDown={moveMenuFocus} style={{ left: menu.left, top: menu.top }}>{menu.kind === "conversation" ? menu.page === "projects" ? <><button onClick={() => setMenu({ ...menu, page: "main" })}><ChevronRight className={styles.backChevron} size={16} />返回</button><button onClick={() => openProjectDialog(menu.item.id)}><Plus size={16} />新建项目</button>{menu.item.projectId ? <button onClick={() => void conversationAction(menu.item, "move", null)}><Folder size={16} />移出项目</button> : null}{projects.filter((project) => project.id !== menu.item.projectId).map((project) => <button key={project.id} onClick={() => void conversationAction(menu.item, "move", project.id)}><Folder size={16} />{project.name}</button>)}</> : <><button onClick={() => void conversationAction(menu.item, "rename")}><Pencil size={16} />重命名</button><button onClick={() => setMenu({ ...menu, page: "projects" })}><FolderOpen size={16} />移至项目<ChevronRight className={styles.menuTail} size={16} /></button><button onClick={() => void conversationAction(menu.item, "pin")}><Pin size={16} />{menu.item.pinned ? "取消置顶" : "置顶聊天"}</button><button className={styles.dangerMenuItem} onClick={() => void conversationAction(menu.item, "delete")}><Trash2 size={16} />删除</button></> : <><button onClick={() => { runtime.navigate({ kind: "home", projectId: menu.item.id, mode: "chat" }); setMenu(null); }}><Plus size={16} />新对话</button><button onClick={() => void projectAction(menu.item, "rename")}><Pencil size={16} />重命名项目</button><button onClick={() => { runtime.navigate({ kind: "project", projectId: menu.item.id }); setMenu(null); }}><LayoutDashboard size={16} />项目主页</button><button className={styles.dangerMenuItem} onClick={() => void projectAction(menu.item, "delete")}><Trash2 size={16} />删除项目</button></>}</div></>, document.body) : null}
    </div>
  );
}
