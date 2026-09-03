import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import Image from "next/image";
import { Camera, Copy, Eye, EyeOff, LoaderCircle, LogOut, Plus, Save, Trash2 } from "lucide-react";
import { commandId } from "@/app/core/gateway/client";
import { useAppRuntime } from "../runtime/AppRuntime";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import styles from "./AccountDialog.module.css";

type Provider = {
  id: string;
  revision: number;
  name: string;
  baseUrl: string;
  protocol: string;
  hasKey: boolean;
  maskedKey: string;
};

type Profile = {
  userId: string;
  revision: number;
  username: string;
  avatar: { url: string; mime: string; size: number; updatedAt: string } | null;
  admin: boolean;
};

export function AccountDialog({ onClose }: { onClose: () => void }) {
  const runtime = useAppRuntime();
  const actor = runtime.bootstrap?.actor;
  const authenticated = actor?.type === "user";
  const [authTab, setAuthTab] = useState<"login" | "register">("login");
  const [accountTab, setAccountTab] = useState<"profile" | "providers">("profile");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [providerRevision, setProviderRevision] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState({ name: "", baseUrl: "", apiKey: "" });
  const [showKey, setShowKey] = useState(false);
  const [keyDirty, setKeyDirty] = useState(false);
  const [revealingKey, setRevealingKey] = useState(false);
  const [providerPendingDelete, setProviderPendingDelete] = useState<Provider | null>(null);
  const revealTimer = useRef<number | null>(null);
  const keyDirtyRef = useRef(false);
  const [profileRevision, setProfileRevision] = useState(0);
  const [profileName, setProfileName] = useState(actor?.username ?? "");
  const [avatarPatch, setAvatarPatch] = useState<string | null | undefined>(undefined);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const avatarInput = useRef<HTMLInputElement>(null);
  const authSubmitting = useRef(false);

  useEffect(() => {
    if (!authenticated) return;
    let active = true;
    let objectUrl: string | null = null;
    void runtime.api.get<Profile>("/api/profile").then(async (result) => {
      if (!active) return;
      setProfileRevision(result.data.revision);
      setProfileName(result.data.username);
      if (result.data.avatar) {
        const response = await runtime.api.raw("/api/profile/avatar", { method: "GET" });
        if (!active) return;
        objectUrl = URL.createObjectURL(await response.blob());
        setAvatarPreview(objectUrl);
      }
    }).catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "无法读取个人资料"); });
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [authenticated, runtime.api]);

  const selectProvider = (provider: Provider | null, id: string) => {
    if (revealTimer.current) window.clearTimeout(revealTimer.current);
    setError(null);
    setSelectedId(id);
    setDraft(provider
      ? { name: provider.name, baseUrl: provider.baseUrl, apiKey: "" }
      : { name: "", baseUrl: "", apiKey: "" });
    setShowKey(false);
    setKeyDirty(false);
    keyDirtyRef.current = false;
  };

  useEffect(() => () => { if (revealTimer.current) window.clearTimeout(revealTimer.current); }, []);

  const changeApiKey = (value: string) => {
    setDraft((current) => ({ ...current, apiKey: value }));
    setKeyDirty(true);
    keyDirtyRef.current = true;
  };

  const toggleKey = async () => {
    if (showKey) {
      setShowKey(false);
      if (!keyDirtyRef.current && selectedId !== "new") setDraft((current) => ({ ...current, apiKey: "" }));
      return;
    }
    if (selectedId === "new" || keyDirtyRef.current) { setShowKey(true); return; }
    if (!selectedId) return;
    setRevealingKey(true);
    setError(null);
    try {
      const result = await runtime.api.post<{ apiKey: string; expiresAt: string }>(`/api/providers/${encodeURIComponent(selectedId)}/reveal`, {});
      setDraft((current) => ({ ...current, apiKey: result.data.apiKey }));
      setShowKey(true);
      const remaining = Math.max(0, Date.parse(result.data.expiresAt) - Date.now());
      if (revealTimer.current) window.clearTimeout(revealTimer.current);
      revealTimer.current = window.setTimeout(() => {
        setShowKey(false);
        if (!keyDirtyRef.current) setDraft((current) => ({ ...current, apiKey: "" }));
      }, remaining);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法显示 API Key");
    } finally { setRevealingKey(false); }
  };

  const copyKey = async () => {
    if (!draft.apiKey) return;
    await navigator.clipboard.writeText(draft.apiKey);
    runtime.notify("API Key 已复制", "success");
  };

  const loadProviders = async (preferredId = selectedId) => {
    const result = await runtime.api.get<{ revision: number; providers: Provider[] }>("/api/providers/manage");
    setProviders(result.data.providers);
    setProviderRevision(result.data.revision);
    const selected = result.data.providers.find((item) => item.id === preferredId) ?? result.data.providers[0] ?? null;
    if (selected) selectProvider(selected, selected.id);
    else selectProvider(null, "new");
  };

  const openProviders = async () => {
    setAccountTab("providers");
    setError(null);
    try { await loadProviders(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "无法读取模型 API"); }
  };

  const submitAuth = async (event: FormEvent) => {
    event.preventDefault();
    if (authSubmitting.current) return;
    authSubmitting.current = true;
    setBusy(true); setError(null);
    try {
      if (authTab === "login") await runtime.login(username, password);
      else await runtime.register(username, password);
      onClose();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "操作失败"); }
    finally { authSubmitting.current = false; setBusy(false); }
  };

  const saveProvider = async () => {
    setBusy(true); setError(null);
    try {
      if (selectedId === "new") {
        await runtime.api.post("/api/providers", {
          provider: { name: draft.name, baseUrl: draft.baseUrl, protocol: "auto" },
          apiKey: draft.apiKey,
          expectedRevision: providerRevision,
        }, { expectedRevision: providerRevision, idempotencyKey: commandId("provider-create") });
      } else if (selectedId) {
        await runtime.api.patch(`/api/providers/${selectedId}`, {
          patch: { name: draft.name, baseUrl: draft.baseUrl, protocol: "auto" },
          ...(keyDirty && draft.apiKey ? { apiKey: draft.apiKey } : {}),
        }, { expectedRevision: providerRevision, idempotencyKey: commandId("provider-update") });
      }
      await loadProviders();
      runtime.notify("模型 API 已保存", "success");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "保存失败"); }
    finally { setBusy(false); }
  };

  const removeProvider = async () => {
    if (!providerPendingDelete) return;
    setBusy(true);
    setError(null);
    try {
      await runtime.api.delete(`/api/providers/${providerPendingDelete.id}`, { body: {}, expectedRevision: providerRevision, idempotencyKey: commandId("provider-delete") });
      setProviderPendingDelete(null);
      await loadProviders(null);
      runtime.notify("模型 API 已删除", "success");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "删除失败"); }
    finally { setProviderPendingDelete(null); setBusy(false); }
  };

  const chooseAvatar = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) { setError("请选择 PNG、JPG 或 WebP 图片"); return; }
    if (file.size > 2_500_000) { setError("头像文件不能超过 2.5 MB"); return; }
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    setAvatarPatch(dataUrl);
    setAvatarPreview(dataUrl);
    setError(null);
  };

  const saveProfile = async () => {
    setBusy(true); setError(null);
    try {
      await runtime.api.patch("/api/profile", {
        username: profileName.trim(),
        ...(avatarPatch !== undefined ? { avatar: avatarPatch } : {}),
      }, { expectedRevision: profileRevision, idempotencyKey: commandId("profile-update") });
      await runtime.refreshBootstrap();
      runtime.notify("个人资料已保存", "success");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "保存失败"); }
    finally { setBusy(false); }
  };

  const selectedProvider = providers.find((item) => item.id === selectedId) ?? null;
  const providerChanged = selectedId === "new"
    ? Boolean(draft.name.trim() || draft.baseUrl.trim() || draft.apiKey)
    : Boolean(selectedProvider && (
      draft.name.trim() !== selectedProvider.name
      || draft.baseUrl.trim() !== selectedProvider.baseUrl
      || keyDirty
    ));
  const showStoredKeyMask = Boolean(selectedProvider?.hasKey && !showKey && !keyDirty);

  return (
    <>
    <Modal title={authenticated ? "账号设置" : "登录 EasyWork"} size={authenticated ? "normal" : "compact"} onClose={onClose}>
      {authenticated ? (
        <div className={styles.accountFrame}>
          <div className={styles.accountTabs}>
            <button className={`${styles.tab} ${accountTab === "profile" ? styles.active : ""}`} onClick={() => { setError(null); setAccountTab("profile"); }}>个人资料</button>
            <button className={`${styles.tab} ${accountTab === "providers" ? styles.active : ""}`} onClick={() => void openProviders()}>模型 API</button>
          </div>
          {accountTab === "profile" ? <div className={styles.profile}>
            <div className={styles.avatarEditor}><input ref={avatarInput} type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void chooseAvatar(event)} /><button type="button" className={styles.profileAvatar} aria-label="更换头像" onClick={() => avatarInput.current?.click()}>{avatarPreview ? <Image unoptimized fill sizes="76px" src={avatarPreview} alt="" /> : actor.username.slice(0, 1).toUpperCase()}<span><Camera size={15} /></span></button><button type="button" className={styles.avatarAction} onClick={() => avatarInput.current?.click()}>更换头像</button></div>
            <div className={styles.profileBody}>
              <label className={styles.field}><span>用户名</span><input className={styles.input} value={profileName} onChange={(event) => setProfileName(event.target.value)} /></label>
              <span className={styles.profileSpacer} />
              {error ? <div className={styles.error}>{error}</div> : null}
            </div>
            <div className={styles.profileActions}><Button variant="danger" icon={<LogOut size={16} />} onClick={() => void runtime.logout().then(onClose)}>退出登录</Button><Button className={styles.saveAction} variant="primary" disabled={busy || profileName.trim().length < 2 || profileName.trim() === actor.username} icon={<Save size={16} />} onClick={() => void saveProfile()}>{busy ? "保存中" : "保存"}</Button></div>
          </div> : <div className={styles.providerLayout}>
            <aside className={styles.providerNav}>
              {providers.map((provider) => <button key={provider.id} className={`${styles.providerItem} ${selectedId === provider.id ? styles.active : ""}`} onClick={() => selectProvider(provider, provider.id)}><span>{provider.name}</span></button>)}
              <button className={`${styles.providerItem} ${styles.providerAdd} ${selectedId === "new" ? styles.active : ""}`} onClick={() => selectProvider(null, "new")}><Plus size={15} /><span>新建 API</span></button>
            </aside>
            <section className={styles.providerForm}>
              {selectedId ? <>
                <label className={styles.field}><span>API 名称</span><input className={styles.input} value={draft.name} onChange={(event) => setDraft((value) => ({ ...value, name: event.target.value }))} /></label>
                <label className={styles.field}><span>API URL</span><input className={styles.input} value={draft.baseUrl} placeholder="https://api.example.com" onChange={(event) => setDraft((value) => ({ ...value, baseUrl: event.target.value }))} /></label>
                <label className={styles.field}><span>API Key</span><div className={styles.keyWrap}><input className={styles.input} autoComplete="new-password" type={showKey ? "text" : "password"} value={draft.apiKey} placeholder={selectedId === "new" || !selectedProvider?.hasKey ? "输入 API Key" : ""} onChange={(event) => changeApiKey(event.target.value)} />{showStoredKeyMask ? <span className={styles.storedSecretMask} aria-hidden="true">••••••••••••</span> : null}<div className={styles.keyActions}>{showKey && draft.apiKey ? <button className={styles.keyToggle} type="button" aria-label="复制 API Key" onClick={() => void copyKey()}><Copy size={16} /></button> : null}<button className={styles.keyToggle} type="button" aria-label={showKey ? "隐藏 API Key" : "显示 API Key"} disabled={revealingKey} onClick={() => void toggleKey()}>{revealingKey ? <LoaderCircle className={styles.spin} size={16} /> : showKey ? <EyeOff size={17} /> : <Eye size={17} />}</button></div></div></label>
                {error ? <div className={styles.error}>{error}</div> : null}
                <div className={styles.providerFooter}>{selectedId !== "new" ? <Button variant="danger" icon={<Trash2 size={15} />} onClick={() => selectedProvider && setProviderPendingDelete(selectedProvider)}>删除</Button> : <span />}<Button className={styles.saveAction} variant="primary" disabled={busy || !providerChanged || !draft.name.trim() || !draft.baseUrl.trim() || ((selectedId === "new" || keyDirty) && !draft.apiKey)} onClick={() => void saveProvider()}>{busy ? "保存中" : "保存"}</Button></div>
              </> : <div>选择一个 API，或新建配置。</div>}
            </section>
          </div>}
        </div>
      ) : (
        <>
          <div className={styles.tabs}><button className={`${styles.tab} ${authTab === "login" ? styles.active : ""}`} onClick={() => setAuthTab("login")}>登录</button><button className={`${styles.tab} ${authTab === "register" ? styles.active : ""}`} onClick={() => setAuthTab("register")}>注册</button></div>
          <form className={styles.form} onSubmit={submitAuth}>
            <label className={styles.field}><span>用户名</span><input className={styles.input} autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} /></label>
            <label className={styles.field}><span>密码</span><input className={styles.input} type="password" autoComplete={authTab === "login" ? "current-password" : "new-password"} value={password} onChange={(event) => setPassword(event.target.value)} /></label>
            {error ? <div className={styles.error}>{error}</div> : null}
            <div className={styles.actions}><Button variant="primary" disabled={busy || username.length < 2 || password.length < 8}>{busy ? "请稍候" : authTab === "login" ? "登录" : "创建账号"}</Button></div>
          </form>
        </>
      )}
    </Modal>
    {providerPendingDelete ? <Modal title="删除 API 配置？" size="compact" onClose={() => { if (!busy) setProviderPendingDelete(null); }}>
      <div className={styles.deleteConfirm}>
        <p>“{providerPendingDelete.name}”将从账号中删除，此操作无法撤销。</p>
        <div className={styles.deleteActions}>
          <Button disabled={busy} onClick={() => setProviderPendingDelete(null)}>取消</Button>
          <Button variant="danger" disabled={busy} icon={busy ? <LoaderCircle className={styles.spin} size={15} /> : <Trash2 size={15} />} onClick={() => void removeProvider()}>{busy ? "正在删除" : "删除"}</Button>
        </div>
      </div>
    </Modal> : null}
    </>
  );
}
