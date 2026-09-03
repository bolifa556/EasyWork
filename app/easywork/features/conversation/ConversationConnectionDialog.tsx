"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { Check, KeyRound, LoaderCircle, Plus, Save, Settings2, ShieldCheck, Upload, Wifi, WifiOff } from "lucide-react";
import { GatewayError } from "@/app/core/contracts";
import { useAppRuntime } from "../../runtime/AppRuntime";
import { Modal } from "../../ui/Modal";
import type { ServerRecord } from "../servers/ServerManager";
import styles from "./ConversationConnectionDialog.module.css";

type Draft = {
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

type ConnectionServerRecord = ServerRecord & { activeConversationIds?: string[] };

const blankDraft: Draft = {
  name: "",
  host: "",
  port: "22",
  username: "",
  authMethod: "private-key",
  password: "",
  privateKey: "",
  passphrase: "",
  fileName: "private-key",
};

function draftFor(server: ServerRecord | null): Draft {
  return server
    ? {
        ...blankDraft,
        name: server.profile.name,
        host: server.profile.host,
        port: String(server.profile.port),
        username: server.profile.username,
        authMethod: server.profile.authMethod,
        fileName: "已保存的私钥",
      }
    : { ...blankDraft };
}

function errorText(reason: unknown) {
  if (reason instanceof GatewayError && reason.code === "SSH_AUTH_FAILED") return "SSH 认证失败，请检查用户名、登录凭据和动态验证码";
  return reason instanceof Error ? reason.message : "操作失败";
}

export function ConversationConnectionDialog({
  selectedServerId,
  conversationId = null,
  conversationEnabled = true,
  conversationScoped,
  onClose,
  onConnected,
  onConversationConnectionChanged,
  onChanged,
}: {
  selectedServerId: string | null;
  conversationId?: string | null;
  conversationEnabled?: boolean;
  conversationScoped?: boolean;
  onClose: () => void;
  onConnected: (serverId: string) => Promise<void>;
  onConversationConnectionChanged?: (enabled: boolean, serverId: string | null) => Promise<void>;
  onChanged: () => Promise<void>;
}) {
  const runtime = useAppRuntime();
  const notify = runtime.notify;
  const [servers, setServers] = useState<ConnectionServerRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(selectedServerId);
  const [loading, setLoading] = useState(true);
  const [configurationOpen, setConfigurationOpen] = useState(!selectedServerId);
  const [draft, setDraft] = useState<Draft>({ ...blankDraft });
  const [twoFactorCode, setTwoFactorCode] = useState("");
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const [trustHost, setTrustHost] = useState(false);
  const [pasteKeyOpen, setPasteKeyOpen] = useState(false);
  const [busy, setBusy] = useState<"save" | "connect" | "disconnect" | null>(null);
  const [connectionAttemptError, setConnectionAttemptError] = useState<{ serverId: string; message: string } | null>(null);
  const keyFileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async (preferred?: string | null, keepConfiguration = false) => {
    const result = await runtime.api.get<ConnectionServerRecord[]>("/api/servers");
    const requestedId = preferred === undefined ? selectedServerId : preferred;
    const nextServer = result.data.find((item) => item.profile.id === requestedId) ?? (requestedId ? null : result.data[0] ?? null);
    setServers(result.data);
    setSelectedId(nextServer?.profile.id ?? null);
    setDraft(draftFor(nextServer));
    setTwoFactorCode("");
    setFingerprint(null);
    setTrustHost(false);
    setPasteKeyOpen(false);
    setConfigurationOpen(keepConfiguration || !nextServer);
    return result.data;
  }, [runtime.api, selectedServerId]);

  useEffect(() => {
    let active = true;
    const handle = window.setTimeout(() => {
      void load(selectedServerId)
        .catch((reason) => notify(errorText(reason), "error"))
        .finally(() => { if (active) setLoading(false); });
    }, 0);
    return () => { active = false; window.clearTimeout(handle); };
  }, [load, notify, selectedServerId]);

  const selected = useMemo(
    () => servers.find((server) => server.profile.id === selectedId) ?? null,
    [selectedId, servers],
  );
  const selectedSshConnected = selected?.connection.status === "connected";
  const displayedConnected = Boolean(selectedSshConnected && (!conversationScoped || conversationEnabled));
  const displayedStatus = busy === "connect" ? "connecting" : displayedConnected ? "connected" : "disconnected";
  const displayedError = busy !== "connect"
    && selected
    && connectionAttemptError?.serverId === selected.profile.id
    && !fingerprint
    ? connectionAttemptError.message
    : null;

  const chooseServer = (server: ServerRecord) => {
    setSelectedId(server.profile.id);
    setDraft(draftFor(server));
    setTwoFactorCode("");
    setFingerprint(null);
    setTrustHost(false);
    setPasteKeyOpen(false);
    setConnectionAttemptError(null);
    setConfigurationOpen(false);
  };

  const startNewProfile = () => {
    setSelectedId(null);
    setDraft({ ...blankDraft });
    setTwoFactorCode("");
    setFingerprint(null);
    setTrustHost(false);
    setPasteKeyOpen(false);
    setConnectionAttemptError(null);
    setConfigurationOpen(true);
  };

  const readPrivateKey = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const privateKey = await file.text();
    setDraft((current) => ({ ...current, privateKey, fileName: file.name }));
    setPasteKeyOpen(false);
  };

  const credentialPresent = draft.authMethod === "password" ? Boolean(draft.password) : Boolean(draft.privateKey);
  const savedCredentialReusable = Boolean(
    selected
      && selected.profile.host === draft.host.trim()
      && selected.profile.port === Number(draft.port)
      && selected.profile.username === draft.username.trim()
      && selected.profile.authMethod === draft.authMethod,
  );
  const complete = Boolean(
    draft.host.trim()
      && draft.username.trim()
      && Number.isSafeInteger(Number(draft.port))
      && Number(draft.port) > 0
      && (savedCredentialReusable || credentialPresent),
  );

  const persist = async ({ notify = false }: { notify?: boolean } = {}) => {
    const profile = {
      name: draft.name.trim() || draft.host.trim(),
      host: draft.host.trim(),
      port: Number(draft.port),
      username: draft.username.trim(),
      authMethod: draft.authMethod,
    };
    const credential = draft.authMethod === "password"
      ? { method: "password", password: draft.password }
      : { method: "private-key", privateKey: draft.privateKey, passphrase: draft.passphrase, fileName: draft.fileName };
    if (!complete) {
      runtime.notify("请完整填写服务器与登录认证信息", "error");
      return null;
    }
    let id = selected?.profile.id ?? null;
    if (selected) {
      const patch: Record<string, unknown> = { ...profile };
      if (credentialPresent) patch.credential = credential;
      await runtime.api.patch(`/api/servers/${encodeURIComponent(selected.profile.id)}`, {
        ...patch,
      }, { expectedRevision: selected.profile.revision });
    } else {
      const result = await runtime.api.post<{ id: string }>("/api/servers", { ...profile, credential });
      id = result.data.id;
    }
    if (!id) return null;
    await load(id, false);
    await onChanged();
    if (notify) runtime.notify(selected ? "服务器配置已保存" : "服务器已添加", "success");
    return id;
  };

  const save = async () => {
    if (busy) return;
    setBusy("save");
    try {
      const id = await persist({ notify: true });
      if (id) {
        setConfigurationOpen(false);
      }
    } catch (reason) {
      runtime.notify(errorText(reason), "error");
    } finally {
      setBusy(null);
    }
  };

  const connect = async () => {
    if (busy) return;
    setBusy("connect");
    setConnectionAttemptError(null);
    try {
      let id = selected?.profile.id ?? null;
      if (!id || configurationOpen) id = await persist();
      if (!id) return;
      const current = servers.find((server) => server.profile.id === id) ?? selected;
      if (current?.connection.status !== "connected") {
        try {
          await runtime.api.post(`/api/servers/${encodeURIComponent(id)}/connect`, {
            twoFactorCode: twoFactorCode.trim() || null,
            ...(fingerprint && trustHost ? { acceptedFingerprint: fingerprint } : {}),
          });
        } catch (reason) {
          if (reason instanceof GatewayError && reason.code === "SSH_HOST_KEY_CONFIRMATION_REQUIRED") {
            const details = reason.details as { fingerprint?: string } | null;
            if (details?.fingerprint) setFingerprint(details.fingerprint);
          } else {
            const message = errorText(reason);
            await load(id).catch(() => undefined);
            setConnectionAttemptError({ serverId: id, message });
            runtime.notify(message, "error");
          }
          return;
        }
      }
      setConnectionAttemptError(null);
      setFingerprint(null);
      try {
        if (conversationId) {
          await runtime.api.post(`/api/conversations/${encodeURIComponent(conversationId)}/server-binding`, { serverId: id });
          await onConversationConnectionChanged?.(true, id);
        }
      } catch (reason) {
        await load(id).catch(() => undefined);
        runtime.notify(`SSH 已连接，但当前对话关联失败：${errorText(reason)}`, "error");
        return;
      }
      await load(id).catch(() => undefined);
      // The SSH connection and conversation binding are already authoritative.
      // A transient bootstrap refresh must not turn a successful connection
      // into a red "SSH connection failed" notification.
      await onConnected(id).catch(() => onChanged().catch(() => undefined));
      runtime.notify("SSH 已连接", "success");
      onClose();
    } catch (reason) {
      runtime.notify(errorText(reason), "error");
    } finally {
      setBusy(null);
    }
  };

  const selectConnectedServer = async () => {
    if (!selected || busy) return;
    setBusy("connect");
    try {
      const id = selected.profile.id;
      if (conversationId) {
        await runtime.api.post(`/api/conversations/${encodeURIComponent(conversationId)}/server-binding`, { serverId: id });
        await onConversationConnectionChanged?.(true, id);
      }
      await runtime.refreshBootstrap();
      await onConnected(id);
      onClose();
    } catch (reason) {
      runtime.notify(errorText(reason), "error");
    } finally {
      setBusy(null);
    }
  };

  const disconnectConversation = async () => {
    if (!selected || busy) return;
    setBusy("disconnect");
    try {
      if (conversationScoped && conversationId) {
        await runtime.api.delete(`/api/conversations/${encodeURIComponent(conversationId)}/server-binding`, { body: {} });
        await onConversationConnectionChanged?.(false, null);
      } else {
        await runtime.api.post(`/api/servers/${encodeURIComponent(selected.profile.id)}/disconnect`, {});
      }
      await load(selected.profile.id);
      await runtime.refreshBootstrap();
      await onChanged();
      runtime.notify(conversationScoped ? "此对话已断开远程服务器" : "SSH 已断开", "success");
    } catch (reason) {
      runtime.notify(errorText(reason), "error");
    } finally {
      setBusy(null);
    }
  };

  const panelReady = selected && !configurationOpen;
  const showSidebar = !conversationScoped;

  return <Modal title="远程连接" size="wide" floating panelClassName={styles.panel} bodyClassName={styles.body} onClose={onClose}>
    {loading ? <div className={styles.loading}><LoaderCircle className={styles.spin} size={18} />正在读取服务器</div> : <div className={`${styles.manager} ${conversationScoped ? styles.compact : ""}`}>
      {showSidebar ? <aside className={styles.serverSidebar}>
        <div className={styles.serverHeading}><span>服务器</span><button type="button" aria-label="添加服务器" onClick={startNewProfile}><Plus size={15} /></button></div>
        <div className={styles.serverList}>{servers.map((server) => <button type="button" className={server.profile.id === selectedId ? styles.activeServer : ""} key={server.profile.id} onClick={() => chooseServer(server)}>
          <i className={`${styles.serverDot} ${server.connection.status === "connected" ? styles.dotConnected : server.connection.status === "connecting" ? styles.dotConnecting : ""}`} />
          <span><strong>{server.profile.name || server.profile.host}</strong><small>{server.profile.username ? `${server.profile.username}@` : ""}{server.profile.host}</small></span>
        </button>)}</div>
        {!servers.length ? <span className={styles.serverEmpty}>还没有保存的服务器</span> : null}
      </aside> : null}
      <div className={styles.connectionBody}>
        {!conversationScoped && servers.length > 1 ? <label className={styles.mobileServerSelect}><span>服务器</span><select value={selectedId ?? ""} onChange={(event) => { const next = servers.find((item) => item.profile.id === event.target.value); if (next) chooseServer(next); }}><option value="" disabled>选择已保存的服务器</option>{servers.map((server) => <option key={server.profile.id} value={server.profile.id}>{server.profile.name || server.profile.host}</option>)}</select></label> : null}
        {panelReady ? <div className={`${styles.quickPanel} ${styles[displayedStatus]}`}>
          <span className={styles.connectedHero}>{displayedStatus === "connecting" ? <LoaderCircle className={styles.spin} size={24} /> : displayedConnected ? <Wifi size={24} /> : <WifiOff size={24} />}</span>
          <h3>{selected.profile.name || selected.profile.host}</h3>
          <p>{selected.profile.username}@{selected.profile.host}</p>
          <div className={styles.connectionFacts}>
            <span><strong>{displayedConnected ? `已连接 ${(selected.activeConversationIds ?? selected.conversationIds).length} 个对话` : displayedStatus === "connecting" ? "连接中" : "未连接"}</strong><small>连接状态</small></span>
            <span><strong>{selected.profile.port || 22}</strong><small>SSH 端口</small></span>
          </div>
          {displayedError ? <div className={styles.formError} role="alert">{displayedError}</div> : null}
          {fingerprint ? <div className={styles.hostConfirm}>
            <span><ShieldCheck size={16} /><strong>确认主机指纹</strong></span>
            <code>{fingerprint}</code>
            <label><input type="checkbox" checked={trustHost} onChange={(event) => setTrustHost(event.target.checked)} />我已核对并信任此主机</label>
          </div> : null}
          <div className={`${styles.quickActions} ${displayedConnected ? styles.quickActionsConnected : ""}`}>
            <button className={styles.quickButton} type="button" onClick={() => setConfigurationOpen(true)}><Settings2 size={15} />配置</button>
            {displayedConnected ? conversationScoped ? <button className={`${styles.quickButton} ${styles.quickDisconnect}`} type="button" disabled={Boolean(busy)} onClick={() => void disconnectConversation()}>{busy === "disconnect" ? <LoaderCircle className={styles.spin} size={15} /> : <WifiOff size={15} />}{busy === "disconnect" ? "断开中" : "断开连接"}</button> : <button className={`${styles.quickButton} ${styles.quickUse}`} type="button" disabled={Boolean(busy)} onClick={() => void selectConnectedServer()}>{busy === "connect" ? <LoaderCircle className={styles.spin} size={15} /> : <Check size={15} />}{busy === "connect" ? "使用中" : "使用此连接"}</button> : <>
              <input className={styles.quickOtp} value={twoFactorCode} inputMode="numeric" onChange={(event) => setTwoFactorCode(event.target.value.replace(/\D/g, ""))} placeholder="请输入2FA验证码（可选）" aria-label="2FA 验证码（可选）" autoComplete="one-time-code" />
              <button className={styles.quickButton} type="button" disabled={busy === "connect" || Boolean(fingerprint && !trustHost)} onClick={() => void connect()}>{busy === "connect" ? <LoaderCircle className={styles.spin} size={15} /> : <KeyRound size={15} />}{busy === "connect" ? "连接中" : "连接"}</button>
            </>}
          </div>
        </div> : <form className={styles.form} onSubmit={(event) => { event.preventDefault(); void connect(); }}>
          {conversationScoped && servers.length > 1 ? <label className={styles.field}><span>服务器</span><select value={selectedId ?? ""} onChange={(event) => { const next = servers.find((item) => item.profile.id === event.target.value); if (next) chooseServer(next); }}><option value="" disabled>选择已保存的服务器</option>{servers.map((server) => <option key={server.profile.id} value={server.profile.id}>{server.profile.name || server.profile.host}</option>)}</select></label> : null}
          <label className={styles.field}><span>服务器名称</span><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="您可以自定义对该服务器的称呼" /></label>
          <div className={styles.targetGrid}>
            <label className={styles.field}><span>服务器地址</span><input required value={draft.host} onChange={(event) => setDraft({ ...draft, host: event.target.value })} /></label>
            <label className={styles.field}><span>端口</span><input required inputMode="numeric" value={draft.port} onChange={(event) => setDraft({ ...draft, port: event.target.value.replace(/\D/g, "") })} /></label>
          </div>
          <label className={styles.field}><span>用户名</span><input required value={draft.username} onChange={(event) => setDraft({ ...draft, username: event.target.value })} placeholder="请输入您在服务器上的用户名" /></label>
          <fieldset className={styles.authentication}>
            <legend>登录认证</legend>
            <div className={`${styles.field} ${styles.authMethod}`}><span>登录方式</span><div className={styles.authSwitch} role="group" aria-label="选择登录方式">
              <button type="button" className={draft.authMethod === "password" ? styles.activeAuth : ""} onClick={() => setDraft({ ...draft, authMethod: "password" })}><KeyRound size={15} />密码</button>
              <button type="button" className={draft.authMethod === "private-key" ? styles.activeAuth : ""} onClick={() => setDraft({ ...draft, authMethod: "private-key" })}><ShieldCheck size={15} />私钥</button>
            </div></div>
            {draft.authMethod === "password" ? <div className={`${styles.field} ${styles.credential}`}><span>登录密码</span>{selected?.profile.authMethod === "password" && !draft.password ? <button type="button" className={styles.savedCredential}><ShieldCheck size={16} /><span><strong>已保存的密码</strong><small>使用账号中加密保存的凭据</small></span><Check size={15} /></button> : null}<input type="password" value={draft.password} onChange={(event) => setDraft({ ...draft, password: event.target.value })} placeholder={selected ? "输入新密码" : "输入登录密码"} /></div> : <div className={`${styles.field} ${styles.credential}`}>
              <span>SSH 私钥</span>
              {selected?.profile.authMethod === "private-key" && !draft.privateKey ? <button type="button" className={styles.savedCredential}><ShieldCheck size={16} /><span><strong>已保存的私钥</strong><small>使用账号中加密保存的私钥</small></span><Check size={15} /></button> : null}
              <div className={styles.keyActions}><button type="button" onClick={() => keyFileInput.current?.click()}><Upload size={15} />{selected ? "更换文件" : "选择文件"}</button><input ref={keyFileInput} hidden type="file" onChange={(event) => void readPrivateKey(event)} /><button type="button" onClick={() => setPasteKeyOpen((open) => !open)}>{pasteKeyOpen ? "收起" : "粘贴私钥"}</button></div>
              {draft.privateKey && !pasteKeyOpen ? <div className={styles.selectedKey}><Check size={14} />{draft.fileName}</div> : null}
              {pasteKeyOpen ? <textarea rows={4} value={draft.privateKey} onChange={(event) => setDraft({ ...draft, privateKey: event.target.value })} placeholder="粘贴 SSH 私钥" /> : null}
              <label className={styles.nestedField}><span>私钥密码（可选）</span><input type="password" value={draft.passphrase} onChange={(event) => setDraft({ ...draft, passphrase: event.target.value })} placeholder="私钥未加密可留空" /></label>
            </div>}
          </fieldset>
          <label className={styles.field}><span>2FA 验证码（可选）</span><input value={twoFactorCode} inputMode="numeric" onChange={(event) => setTwoFactorCode(event.target.value.replace(/\D/g, ""))} placeholder="请输入当前动态验证码" aria-label="2FA 验证码（可选）" autoComplete="one-time-code" /></label>
          {fingerprint ? <div className={styles.hostConfirm}><span><ShieldCheck size={16} /><strong>确认主机指纹</strong></span><code>{fingerprint}</code><label><input type="checkbox" checked={trustHost} onChange={(event) => setTrustHost(event.target.checked)} />我已核对并信任此主机</label></div> : null}
          <div className={styles.formActions}>
            <button type="button" disabled={!complete || Boolean(busy)} onClick={() => void save()}>{busy === "save" ? <LoaderCircle className={styles.spin} size={15} /> : <Save size={15} />}{busy === "save" ? "保存中" : "保存"}</button>
            {selectedSshConnected ? <button className={styles.formDisconnect} type="button" disabled={Boolean(busy)} onClick={() => void disconnectConversation()}><WifiOff size={16} />断开 SSH</button> : <button type="submit" disabled={!complete || busy === "connect" || Boolean(fingerprint && !trustHost)}>{busy === "connect" ? <LoaderCircle className={styles.spin} size={16} /> : <KeyRound size={16} />}{busy === "connect" ? "连接中" : "连接 SSH"}</button>}
          </div>
        </form>}
      </div>
    </div>}
  </Modal>;
}
