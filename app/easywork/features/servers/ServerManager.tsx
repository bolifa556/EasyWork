"use client";

import {
  ArrowLeft,
  Cable,
  ChevronRight,
  FileKey2,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  Plus,
  Save,
  Server,
  ServerOff,
  Unplug,
  UsersRound,
  Wifi,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { GatewayError } from "@/app/core/contracts";
import { useAppRuntime } from "../../runtime/AppRuntime";
import { CONVERSATIONS_CHANGED_EVENT } from "../../runtime/cacheEvents";
import { Button } from "../../ui/Button";
import { Modal } from "../../ui/Modal";
import styles from "./ServerManager.module.css";

type ServerStatus = "disconnected" | "connecting" | "connected" | "failed";
export type ServerRecord = {
  profile: {
    id: string;
    revision: number;
    name: string;
    host: string;
    port: number;
    username: string;
    authMethod: "password" | "private-key";
    fingerprint: string | null;
    updatedAt: string;
  };
  connection: {
    status: ServerStatus;
    connectedAt: string | null;
    disconnectedAt: string | null;
    lastActiveAt: string | null;
    lastError: { code: string; message: string } | null;
  };
  conversationIds: string[];
  conversations?: Array<{ id: string; title: string }>;
};

type ServerDraft = {
  name: string;
  host: string;
  port: string;
  username: string;
  authMethod: "password" | "private-key";
  password: string;
  privateKey: string;
  passphrase: string;
  fileName: string;
};

const emptyDraft: ServerDraft = { name: "", host: "", port: "22", username: "", authMethod: "private-key", password: "", privateKey: "", passphrase: "", fileName: "private-key" };

function draftOf(server?: ServerRecord): ServerDraft {
  return server ? { ...emptyDraft, name: server.profile.name, host: server.profile.host, port: String(server.profile.port), username: server.profile.username, authMethod: server.profile.authMethod } : { ...emptyDraft };
}

function Status({ value }: { value: ServerStatus }) {
  const visible = value === "failed" ? "disconnected" : value;
  const labels = { connected: "已连接", connecting: "连接中", disconnected: "未连接" };
  return <span className={`${styles.status} ${styles[visible]}`}><i data-ui-icon="" />{labels[visible]}</span>;
}

function connectionErrorMessage(reason: unknown) {
  if (reason instanceof GatewayError && reason.code === "SSH_AUTH_FAILED") {
    return "SSH 认证失败，请检查用户名、登录凭据和动态验证码";
  }
  return reason instanceof Error ? reason.message : "连接失败";
}

export function ServerEditor({ server, onClose, onSaved, embedded = false }: { server?: ServerRecord; onClose: () => void; onSaved: (serverId?: string) => Promise<void>; embedded?: boolean }) {
  const runtime = useAppRuntime();
  const [draft, setDraft] = useState(() => draftOf(server));
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [credentialRevealed, setCredentialRevealed] = useState(false);
  const [credentialDirty, setCredentialDirty] = useState(false);
  const [revealingCredential, setRevealingCredential] = useState(false);
  const revealTimer = useRef<number | null>(null);
  const credentialDirtyRef = useRef(false);
  const keyInput = useRef<HTMLInputElement>(null);
  const editing = Boolean(server);
  const credentialPresent = draft.authMethod === "password" ? Boolean(draft.password) : Boolean(draft.privateKey);

  useEffect(() => () => { if (revealTimer.current) window.clearTimeout(revealTimer.current); }, []);

  const revealPassword = async () => {
    if (!server || server.profile.authMethod !== "password") { setShowPassword((value) => !value); return; }
    if (showPassword) {
      setShowPassword(false);
      if (credentialRevealed) {
        setCredentialRevealed(false);
        setDraft((current) => ({ ...current, password: "" }));
      }
      return;
    }
    if (draft.password) { setShowPassword(true); return; }
    setRevealingCredential(true);
    try {
      const result = await runtime.api.post<{ method: "password" | "private-key"; password?: string; expiresAt: string }>(`/api/servers/${encodeURIComponent(server.profile.id)}/credential/reveal`, {});
      if (result.data.method === "password" && result.data.password) {
        setDraft((current) => ({ ...current, password: result.data.password || "" }));
        setCredentialRevealed(true);
        setShowPassword(true);
        if (revealTimer.current) window.clearTimeout(revealTimer.current);
        revealTimer.current = window.setTimeout(() => {
          setShowPassword(false);
          setCredentialRevealed(false);
          if (!credentialDirtyRef.current) setDraft((current) => ({ ...current, password: "" }));
        }, Math.max(0, Date.parse(result.data.expiresAt) - Date.now()));
      }
    } catch (reason) { runtime.notify(reason instanceof Error ? reason.message : "无法读取已保存密码", "error"); }
    finally { setRevealingCredential(false); }
  };

  const keyFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const content = await file.text();
    setCredentialDirty(true);
    credentialDirtyRef.current = true;
    setDraft((current) => ({ ...current, privateKey: content, fileName: file.name }));
  };

  const save = async () => {
    setBusy(true);
    try {
      const profile = { name: draft.name.trim(), host: draft.host.trim(), port: Number(draft.port), username: draft.username.trim(), authMethod: draft.authMethod };
      const credential = draft.authMethod === "password"
        ? { method: "password", password: draft.password }
        : { method: "private-key", privateKey: draft.privateKey, passphrase: draft.passphrase, fileName: draft.fileName };
      let savedId = server?.profile.id;
      if (server) await runtime.api.patch(`/api/servers/${server.profile.id}`, { ...profile, ...(credentialDirty && credentialPresent ? { credential } : {}) }, { expectedRevision: server.profile.revision });
      else {
        const result = await runtime.api.post<{ id: string }>("/api/servers", { ...profile, credential });
        savedId = result.data.id;
      }
      runtime.notify(editing ? "服务器配置已保存" : "服务器已添加", "success");
      await onSaved(savedId);
      onClose();
    } catch (reason) { runtime.notify(reason instanceof Error ? reason.message : "保存失败", "error"); }
    finally { setBusy(false); }
  };

  const profileChanged = !server
    || draft.name.trim() !== server.profile.name
    || draft.host.trim() !== server.profile.host
    || Number(draft.port) !== server.profile.port
    || draft.username.trim() !== server.profile.username
    || draft.authMethod !== server.profile.authMethod;
  const authMethodChanged = Boolean(server && draft.authMethod !== server.profile.authMethod);
  const changed = !server || profileChanged || credentialDirty;
  const complete = draft.name.trim() && draft.host.trim() && draft.username.trim() && Number(draft.port) > 0
    && (!server ? credentialPresent : (!credentialDirty || credentialPresent) && (!authMethodChanged || (credentialDirty && credentialPresent)));
  const showStoredPasswordMask = Boolean(server && server.profile.authMethod === "password" && draft.authMethod === "password" && !showPassword && !credentialDirty && !credentialRevealed);
  const form = <form className={`${styles.editor} ${embedded ? styles.embeddedEditor : ""}`} onSubmit={(event) => { event.preventDefault(); void save(); }}>
      {embedded ? <header className={styles.editorHeading}><button type="button" aria-label="返回服务器详情" onClick={onClose}><ArrowLeft size={17} /></button><div><h2>{editing ? "服务器配置" : "添加服务器"}</h2>{editing ? <p>{server.profile.name}</p> : null}</div></header> : null}
      <section className={styles.identityFields}>
        <label><span>服务器名称</span><input autoFocus value={draft.name} placeholder="自定义称呼" onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
        <label className={styles.addressField}><span>服务器地址</span><input value={draft.host} placeholder="hostname 或 IP" onChange={(event) => setDraft({ ...draft, host: event.target.value })} /></label>
        <label><span>端口</span><input type="number" min="1" max="65535" value={draft.port} onChange={(event) => setDraft({ ...draft, port: event.target.value })} /></label>
        <label><span>用户名</span><input value={draft.username} placeholder="服务器用户名" onChange={(event) => setDraft({ ...draft, username: event.target.value })} /></label>
      </section>
      <section className={styles.authBox}>
        <div className={styles.authTabs} role="radiogroup"><button type="button" className={draft.authMethod === "private-key" ? styles.selectedAuth : ""} onClick={() => setDraft({ ...draft, authMethod: "private-key" })}><FileKey2 size={17} />私钥</button><button type="button" className={draft.authMethod === "password" ? styles.selectedAuth : ""} onClick={() => setDraft({ ...draft, authMethod: "password" })}><LockKeyhole size={17} />密码</button></div>
        {draft.authMethod === "password" ? <label><span>登录密码</span><div className={styles.passwordWrap}><input autoComplete="new-password" type={showPassword ? "text" : "password"} value={draft.password} placeholder={editing ? "" : "输入密码"} onChange={(event) => { setCredentialRevealed(false); setCredentialDirty(true); credentialDirtyRef.current = true; setDraft({ ...draft, password: event.target.value }); }} />{showStoredPasswordMask ? <span className={styles.storedSecretMask} aria-hidden="true">••••••••••••</span> : null}<button type="button" aria-label={showPassword ? "隐藏密码" : "显示密码"} disabled={revealingCredential} onClick={() => void revealPassword()}>{revealingCredential ? <LoaderCircle className={styles.spin} size={16} /> : showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button></div></label> : <div className={styles.keyFields}><input ref={keyInput} className={styles.hiddenInput} type="file" onChange={(event) => void keyFile(event)} /><button type="button" className={styles.keyPicker} onClick={() => keyInput.current?.click()}><FileKey2 size={19} /><span>{draft.privateKey ? draft.fileName : editing ? "当前私钥已保存；点击可替换" : "选择私钥文件"}</span><ChevronRight size={16} /></button><label><span>私钥密码</span><input type="password" value={draft.passphrase} placeholder="可选" onChange={(event) => setDraft({ ...draft, passphrase: event.target.value })} /></label></div>}
      </section>
      <footer className={styles.editorActions}><Button type="button" onClick={onClose}>取消</Button><Button type="submit" variant="primary" disabled={!complete || !changed || busy} icon={busy ? <LoaderCircle className={styles.spin} size={16} /> : <Save size={16} />}>{busy ? "保存中" : "保存"}</Button></footer>
    </form>;
  return embedded ? form : <Modal title={editing ? "服务器配置" : "添加服务器"} size="wide" onClose={onClose}>{form}</Modal>;
}

function ConnectDialog({ server, onClose, onChanged }: { server: ServerRecord; onClose: () => void; onChanged: () => Promise<void> }) {
  const runtime = useAppRuntime();
  const [twoFactorCode, setTwoFactorCode] = useState("");
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const connect = async (acceptedFingerprint?: string) => {
    setBusy(true);
    try {
      await runtime.api.post(`/api/servers/${server.profile.id}/connect`, { twoFactorCode: twoFactorCode.trim() || null, ...(acceptedFingerprint ? { acceptedFingerprint } : {}) });
      runtime.notify("SSH 已连接", "success");
      await onChanged();
      await runtime.refreshBootstrap();
      onClose();
    } catch (reason) {
      if (reason instanceof GatewayError && reason.code === "SSH_HOST_KEY_CONFIRMATION_REQUIRED") {
        const detail = reason.details as { fingerprint?: string } | null;
        if (detail?.fingerprint) setFingerprint(detail.fingerprint);
      } else runtime.notify(connectionErrorMessage(reason), "error");
    } finally { setBusy(false); }
  };
  return <Modal title="连接 SSH" subtitle={`${server.profile.username}@${server.profile.host}:${server.profile.port}`} size="compact" onClose={onClose}>
    <div className={styles.connectDialog}>
      {fingerprint ? <section className={styles.fingerprint}><ShieldFingerprint /><div><strong>确认主机指纹</strong><code>{fingerprint}</code></div></section> : null}
      <label><span>动态验证码</span><input autoFocus={!fingerprint} inputMode="numeric" value={twoFactorCode} placeholder="可选" onChange={(event) => setTwoFactorCode(event.target.value)} /></label>
      <footer><Button onClick={onClose}>取消</Button><Button variant="primary" disabled={busy} onClick={() => void connect(fingerprint || undefined)} icon={busy ? <LoaderCircle className={styles.spin} size={16} /> : <Cable size={16} />}>{busy ? "连接中" : fingerprint ? "确认并连接" : "连接"}</Button></footer>
    </div>
  </Modal>;
}

function ShieldFingerprint() { return <span data-ui-icon="" className={styles.fingerprintIcon}><KeyRound size={21} /></span>; }

function Detail({ server, onEdit, onConnect, onDisconnect }: { server: ServerRecord; onEdit: () => void; onConnect: () => void; onDisconnect: () => Promise<void> }) {
  const connected = server.connection.status === "connected";
  const conversations = server.conversations ?? server.conversationIds.map((id) => ({ id, title: "未命名对话" }));
  return <div className={styles.detail}>
    <header className={styles.detailHeading}><div data-ui-icon="" className={styles.serverMark}>{connected ? <Wifi size={23} /> : <ServerOff size={23} />}</div><div><h2>{server.profile.name}</h2><p>{server.profile.username}@{server.profile.host}:{server.profile.port}</p></div><Status value={server.connection.status} /></header>
    <div className={styles.facts}><div><span>认证方式</span><strong>{server.profile.authMethod === "private-key" ? "SSH 私钥" : "密码"}</strong></div><div><span>关联对话</span><strong>{server.conversationIds.length}</strong></div><div><span>最近活动</span><strong>{server.connection.lastActiveAt ? new Date(server.connection.lastActiveAt).toLocaleString("zh-CN") : "—"}</strong></div></div>
    <section className={styles.bindingSection}><div className={styles.subheading}><UsersRound size={17} /><h3>连接对话</h3></div>{conversations.length ? <div className={styles.bindingList}>{conversations.map((conversation) => <div key={conversation.id}><span title={conversation.title}>{conversation.title}</span><i>{connected ? "SSH 可用" : "等待连接"}</i></div>)}</div> : <div className={styles.noBindings}>还没有对话使用这台服务器</div>}</section>
    <footer className={styles.detailActions}><Button onClick={onEdit}>配置</Button>{connected ? <Button variant="danger" icon={<Unplug size={16} />} onClick={() => void onDisconnect()}>断开 SSH</Button> : <Button variant="primary" icon={<Cable size={16} />} onClick={onConnect} disabled={server.connection.status === "connecting"}>连接 SSH</Button>}</footer>
  </div>;
}

const serverPageCache = new Map<string, { servers: ServerRecord[]; selectedId: string | null; cachedAt: number }>();

export default function ServerManager() {
  const runtime = useAppRuntime();
  const { api, notify, refreshBootstrap } = runtime;
  const cacheKey = runtime.bootstrap?.actor.id || "unresolved";
  const initialCache = serverPageCache.get(cacheKey);
  const [servers, setServers] = useState<ServerRecord[]>(() => initialCache?.servers || []);
  const [selectedId, setSelectedId] = useState<string | null>(() => initialCache?.selectedId || null);
  const [loading, setLoading] = useState(() => !initialCache);
  const [editing, setEditing] = useState<"new" | "selected" | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);
  const savedInEditor = useRef(false);

  const load = useCallback(async (preferred?: string) => {
    try {
      const result = await api.get<ServerRecord[]>("/api/servers");
      setServers(result.data);
      setSelectedId((current) => {
        const next = preferred || (current && result.data.some((item) => item.profile.id === current) ? current : result.data[0]?.profile.id ?? null);
        serverPageCache.set(cacheKey, { servers: result.data, selectedId: next, cachedAt: Date.now() });
        return next;
      });
    } catch (reason) { notify(reason instanceof Error ? reason.message : "服务器读取失败", "error"); }
  }, [api, cacheKey, notify]);
  useEffect(() => {
    const cached = serverPageCache.get(cacheKey);
    // Server configuration is durable and every mutation in this view updates
    // this cache explicitly. Keep the last snapshot for the whole SPA session
    // instead of imposing an arbitrary five-minute reload on navigation.
    if (cached) return;
    const handle = window.setTimeout(() => { void load().finally(() => setLoading(false)); }, 0);
    return () => window.clearTimeout(handle);
  }, [cacheKey, load]);
  useEffect(() => {
    // Conversation titles and bindings are server-detail data too.  Refresh
    // only when an actual mutation announces an invalidation; navigation keeps
    // using the durable SPA cache and there is no polling loop.
    const changed = () => { void load().finally(() => setLoading(false)); };
    window.addEventListener(CONVERSATIONS_CHANGED_EVENT, changed);
    return () => window.removeEventListener(CONVERSATIONS_CHANGED_EVENT, changed);
  }, [load]);
  useEffect(() => {
    if (!loading) serverPageCache.set(cacheKey, { servers, selectedId, cachedAt: serverPageCache.get(cacheKey)?.cachedAt || Date.now() });
  }, [cacheKey, loading, selectedId, servers]);
  const selected = useMemo(() => servers.find((item) => item.profile.id === selectedId) ?? null, [servers, selectedId]);

  const disconnect = async () => {
    if (!selected) return;
    try { await api.post(`/api/servers/${selected.profile.id}/disconnect`, {}); notify("SSH 已断开", "success"); await load(selected.profile.id); await refreshBootstrap(); }
    catch (reason) { notify(reason instanceof Error ? reason.message : "断开失败", "error"); }
  };

  return <div className={`${styles.page} ${mobileDetailOpen ? styles.mobileDetailPage : ""}`}>
    <header className={styles.pageHeader}>
      <div className={styles.titleLine}>{mobileDetailOpen ? <button className={styles.mobileBack} aria-label="返回服务器列表" onClick={() => { setMobileDetailOpen(false); setEditing(null); }}><ArrowLeft size={17} /></button> : null}<span data-ui-icon="" className={styles.titleIcon}><Server size={19} /></span><h1>远程服务器</h1></div>
    </header>
    {loading ? <div className={styles.centerState}><LoaderCircle className={styles.spin} size={22} />正在读取远程服务器</div> : <div className={styles.manager}>
      <aside className={styles.serverList}>
        <div className={styles.serverItems}>
          {servers.map((server) => <button key={server.profile.id} className={server.profile.id === selectedId ? styles.selectedServer : ""} onClick={() => { setSelectedId(server.profile.id); setEditing(null); setMobileDetailOpen(true); }}><span data-ui-icon="" className={styles.listIcon}><Server size={18} /></span><span><strong>{server.profile.name}</strong><small>{server.profile.host}</small></span><Status value={server.connection.status} /></button>)}
          <button className={styles.addServer} onClick={() => { savedInEditor.current = false; setEditing("new"); setMobileDetailOpen(true); }}><span data-ui-icon="" className={styles.addServerIcon}><Plus size={17} /></span><strong>新建服务器</strong></button>
        </div>
      </aside>
      <section className={styles.detailPanel}>{editing ? <ServerEditor embedded server={editing === "selected" ? selected ?? undefined : undefined} onClose={() => { setEditing(null); if (editing === "new" && !savedInEditor.current) setMobileDetailOpen(false); }} onSaved={async (serverId) => { await load(serverId); await refreshBootstrap(); savedInEditor.current = true; }} /> : selected ? <Detail server={selected} onEdit={() => { savedInEditor.current = false; setEditing("selected"); }} onConnect={() => setConnecting(true)} onDisconnect={disconnect} /> : <div className={styles.emptyDetail}><Server size={25} /><strong>选择或新建一台服务器</strong></div>}</section>
    </div>}
    {connecting && selected ? <ConnectDialog server={selected} onClose={() => setConnecting(false)} onChanged={async () => load(selected.profile.id)} /> : null}
  </div>;
}
