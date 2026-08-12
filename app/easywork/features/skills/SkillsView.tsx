"use client";

import {
  Check,
  ChevronDown,
  ChevronRight,
  CloudUpload,
  Code2,
  FileCode2,
  LoaderCircle,
  PackageCheck,
  Plus,
  Server,
  Shield,
  Sparkles,
  Upload,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type InputHTMLAttributes } from "react";
import { commandId } from "@/app/core/gateway/client";
import { useAppRuntime } from "../../runtime/AppRuntime";
import { Button } from "../../ui/Button";
import { LoadingState } from "../../ui/LoadingState";
import { Modal } from "../../ui/Modal";
import { PageFrame } from "../../ui/PageFrame";
import styles from "./SkillsView.module.css";

type SkillRegistry = {
  id: string;
  revision: number;
  skillId: string;
  displayName: string;
  description: string;
  activeVersionId: string | null;
  versions: Array<{ skillVersionId: string; version: string; sha256: string }>;
  updatedAt: string;
};

type SkillVersion = {
  id: string;
  skillId: string;
  version: string;
  sha256: string;
  manifest: { name: string; description: string; entrypoint: string; permissions: string[] };
  installedAt: string;
};

type SkillCatalog = {
  registries: SkillRegistry[];
  versions: SkillVersion[];
  taskPins: Array<{ skillId: string; version: string; taskId: string }>;
};

type SkillState = SkillCatalog & { revision: number };

type Deployment = { serverId: string; serverName: string; skillId: string; version: string; status: "ready" | "failed"; updatedAt?: string };
type PackageFile = { path: string; content: string };

function relativeFilePath(file: File) {
  const withPath = file as File & { webkitRelativePath?: string };
  return (withPath.webkitRelativePath || file.name).split("/").slice(withPath.webkitRelativePath ? 1 : 0).join("/") || file.name;
}

function UploadDialog({ revision, onClose, onUploaded }: { revision: number; onClose: () => void; onUploaded: () => Promise<void> }) {
  const runtime = useAppRuntime();
  const input = useRef<HTMLInputElement>(null);
  const [skillId, setSkillId] = useState("");
  const [version, setVersion] = useState("1.0.0");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [entrypoint, setEntrypoint] = useState("");
  const [permissions, setPermissions] = useState("");
  const [files, setFiles] = useState<PackageFile[]>([]);
  const [busy, setBusy] = useState(false);

  const choose = async (event: ChangeEvent<HTMLInputElement>) => {
    const selected = [...(event.target.files ?? [])];
    const loaded = await Promise.all(selected.map(async (file) => ({ path: relativeFilePath(file), content: await file.text() })));
    setFiles(loaded);
    if (!entrypoint) {
      const candidate = loaded.find((file) => /(^|\/)(index|main)\.(mjs|js|ts|py|sh)$/i.test(file.path)) ?? loaded.find((file) => !/\.(md|txt|json)$/i.test(file.path));
      if (candidate) setEntrypoint(candidate.path);
    }
    if (!name && selected[0]) setName(selected[0].webkitRelativePath?.split("/")[0] || selected[0].name.replace(/\.[^.]+$/, ""));
  };

  const submit = async () => {
    setBusy(true);
    try {
      await runtime.api.post("/api/skills", {
        skillId: skillId.trim(), version: version.trim(), activate: true,
        manifest: { name: name.trim(), description: description.trim(), entrypoint: entrypoint.trim(), permissions: permissions.split(/[\s,]+/).map((value) => value.trim()).filter(Boolean) },
        files, expectedRevision: revision,
      }, { expectedRevision: revision, idempotencyKey: commandId("skill-upload") });
      runtime.notify("技能版本已上传", "success");
      await onUploaded();
      onClose();
    } catch (reason) { runtime.notify(reason instanceof Error ? reason.message : "上传失败", "error"); }
    finally { setBusy(false); }
  };
  const complete = skillId.trim() && version.trim() && name.trim() && entrypoint.trim() && files.length > 0;
  return <Modal title="上传技能" size="wide" onClose={onClose}>
    <form className={styles.uploadForm} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <div className={styles.uploadGrid}>
        <label><span>技能 ID</span><input autoFocus value={skillId} placeholder="shell-helper" onChange={(event) => setSkillId(event.target.value)} /></label>
        <label><span>版本</span><input value={version} placeholder="1.0.0" onChange={(event) => setVersion(event.target.value)} /></label>
        <label className={styles.nameField}><span>名称</span><input value={name} placeholder="显示名称" onChange={(event) => setName(event.target.value)} /></label>
        <label className={styles.descriptionField}><span>说明</span><textarea value={description} placeholder="这个技能能做什么" onChange={(event) => setDescription(event.target.value)} /></label>
        <label><span>入口文件</span><input value={entrypoint} placeholder="scripts/main.mjs" onChange={(event) => setEntrypoint(event.target.value)} /></label>
        <label><span>权限</span><input value={permissions} placeholder="remote.read, remote.exec" onChange={(event) => setPermissions(event.target.value)} /></label>
      </div>
      <input ref={input} className={styles.hiddenInput} type="file" multiple {...({ webkitdirectory: "" } as InputHTMLAttributes<HTMLInputElement>)} onChange={(event) => void choose(event)} />
      <button type="button" className={styles.dropzone} onClick={() => input.current?.click()}><CloudUpload size={24} /><span><strong>{files.length ? `${files.length} 个文件` : "选择技能文件夹"}</strong><small>{files.length ? `${files.slice(0, 3).map((file) => file.path).join(" · ")}${files.length > 3 ? " …" : ""}` : "文件夹结构将原样保存"}</small></span></button>
      <footer className={styles.dialogActions}><Button type="button" onClick={onClose}>取消</Button><Button type="submit" variant="primary" disabled={!complete || busy} icon={busy ? <LoaderCircle className={styles.spin} size={16} /> : <Upload size={16} />}>{busy ? "上传中" : "上传"}</Button></footer>
    </form>
  </Modal>;
}

function DeploymentStatus({ deployments, available }: { deployments: Deployment[]; available: boolean }) {
  if (!available) return <div className={styles.deployUnavailable}><Server size={18} /><span>远端部署状态暂时不可用</span></div>;
  if (!deployments.length) return <div className={styles.deployUnavailable}><Server size={18} /><span>尚未部署到服务器</span></div>;
  return <div className={styles.deployments}>{deployments.map((item) => <div key={`${item.serverId}:${item.skillId}`}><Server size={15} /><span>{item.serverName}</span><strong className={styles[item.status]}>{item.status === "ready" ? "已同步" : "失败"}</strong></div>)}</div>;
}

function SkillCard({ registry, versions, deployments, deploymentAvailable, onActivate }: { registry: SkillRegistry; versions: SkillVersion[]; deployments: Deployment[]; deploymentAvailable: boolean; onActivate: (version: string) => Promise<void> }) {
  const [expanded, setExpanded] = useState(false);
  const active = versions.find((version) => version.id === registry.activeVersionId) ?? null;
  return <article className={styles.skillCard}>
    <button className={styles.skillSummary} onClick={() => setExpanded((value) => !value)}><span className={styles.skillIcon}><Sparkles size={19} /></span><span className={styles.skillName}><strong>{registry.displayName}</strong><small>{registry.description || registry.skillId}</small></span><span className={styles.activeVersion}>{active ? `v${active.version}` : "未激活"}</span>{expanded ? <ChevronDown size={17} /> : <ChevronRight size={17} />}</button>
    <div className={`${styles.skillDetails} ${expanded ? styles.detailsOpen : ""}`}>
      <div className={styles.detailInner}>
        <section className={styles.versionSection}><h3>版本</h3><div className={styles.versionList}>{versions.sort((a,b) => b.installedAt.localeCompare(a.installedAt)).map((version) => <div key={version.id} className={version.id === registry.activeVersionId ? styles.currentVersion : ""}><span className={styles.versionIcon}>{version.id === registry.activeVersionId ? <PackageCheck size={16} /> : <FileCode2 size={16} />}</span><span><strong>{version.version}</strong><small>{version.sha256.slice(0,12)} · {new Date(version.installedAt).toLocaleDateString("zh-CN")}</small></span>{version.id === registry.activeVersionId ? <em><Check size={13} />使用中</em> : <Button compact onClick={() => void onActivate(version.version)}>激活</Button>}</div>)}</div></section>
        <section className={styles.manifestSection}><h3>能力</h3><div className={styles.manifestFacts}><div><Code2 size={16} /><span>入口</span><strong>{active?.manifest.entrypoint ?? "—"}</strong></div><div><Shield size={16} /><span>权限</span><strong>{active?.manifest.permissions.join("、") || "无额外权限"}</strong></div></div><h3>服务器</h3><DeploymentStatus deployments={deployments.filter((item) => item.skillId === registry.skillId)} available={deploymentAvailable} /></section>
      </div>
    </div>
  </article>;
}

export default function SkillsView() {
  const runtime = useAppRuntime();
  const { api, notify } = runtime;
  const [state, setState] = useState<SkillState | null>(null);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [deploymentAvailable, setDeploymentAvailable] = useState(true);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const [skillsResult, deploymentsResult] = await Promise.allSettled([
      api.get<SkillCatalog>("/api/skills"),
      api.get<{ items: Deployment[] }>("/api/skills/deployments"),
    ]);
    if (skillsResult.status === "fulfilled") {
      const catalog = skillsResult.value.data;
      setState({
        revision: skillsResult.value.meta.revision ?? 0,
        registries: Array.isArray(catalog?.registries) ? catalog.registries : [],
        versions: Array.isArray(catalog?.versions) ? catalog.versions : [],
        taskPins: Array.isArray(catalog?.taskPins) ? catalog.taskPins : [],
      });
    }
    else notify(skillsResult.reason instanceof Error ? skillsResult.reason.message : "技能读取失败", "error");
    if (deploymentsResult.status === "fulfilled") { setDeployments(deploymentsResult.value.data.items); setDeploymentAvailable(true); }
    else setDeploymentAvailable(false);
  }, [api, notify]);
  useEffect(() => {
    const handle = window.setTimeout(() => { void load().finally(() => setLoading(false)); }, 0);
    return () => window.clearTimeout(handle);
  }, [load]);

  const activate = async (registry: SkillRegistry, version: string) => {
    try {
      await runtime.api.post(`/api/skills/${encodeURIComponent(registry.skillId)}/activate`, { version }, { expectedRevision: state?.revision, idempotencyKey: commandId("skill-activate") });
      await load();
    } catch (reason) {
      runtime.notify(reason instanceof Error ? reason.message : "版本切换不可用", "error");
    }
  };
  const count = state?.registries.length ?? 0;
  const groupedVersions = useMemo(() => new Map(state?.registries.map((registry) => [registry.skillId, state.versions.filter((version) => version.skillId === registry.skillId)]) ?? []), [state]);

  if (loading) return <LoadingState label="正在读取技能" />;
  return <PageFrame icon={<Sparkles size={19} />} title="技能" count={count} actions={<Button compact variant="primary" onClick={() => setUploadOpen(true)} icon={<Plus size={16} />}>上传技能</Button>}>
    {state?.registries.length ? <div className={styles.skillGrid}>{state.registries.map((registry) => <SkillCard key={registry.id} registry={registry} versions={groupedVersions.get(registry.skillId) ?? []} deployments={deployments} deploymentAvailable={deploymentAvailable} onActivate={(version) => activate(registry, version)} />)}</div> : <section className={styles.empty}><Sparkles size={28} /><strong>还没有技能</strong></section>}
    {uploadOpen && state ? <UploadDialog revision={state.revision} onClose={() => setUploadOpen(false)} onUploaded={load} /> : null}
  </PageFrame>;
}
