"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight, FilePlus2, FolderSearch, Plus, Sparkles, X } from "lucide-react";
import { useAppRuntime } from "../../runtime/AppRuntime";
import styles from "./ComposerResources.module.css";

type CollectionRecord = { id: string; name: string };
type SkillRegistry = {
  skillId: string;
  displayName: string;
  description: string;
  activeVersionId: string | null;
  versions: Array<{ skillVersionId: string; version: string; sha256: string }>;
};
type SkillCatalog = { registries: SkillRegistry[] };

export type SelectedSkillPin = { skillId: string; displayName: string; version: string; sha256: string };
export type ComposerResourceSelection = {
  files: File[];
  collections: CollectionRecord[];
  skills: SelectedSkillPin[];
};

export const emptyComposerResources: ComposerResourceSelection = { files: [], collections: [], skills: [] };

function activePin(registry: SkillRegistry): SelectedSkillPin | null {
  const version = registry.versions.find((item) => item.skillVersionId === registry.activeVersionId);
  return version ? { skillId: registry.skillId, displayName: registry.displayName, version: version.version, sha256: version.sha256 } : null;
}

export function ComposerResources({ value, disabled, onChange }: {
  value: ComposerResourceSelection;
  disabled?: boolean;
  onChange: (value: ComposerResourceSelection) => void;
}) {
  const runtime = useAppRuntime();
  const root = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<"root" | "collections" | "skills">("root");
  const [collections, setCollections] = useState<CollectionRecord[]>([]);
  const [skills, setSkills] = useState<SkillRegistry[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const close = (event: PointerEvent) => { if (root.current && !root.current.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);

  const showCollections = async () => {
    setPage("collections");
    setLoading(true);
    try {
      const result = await runtime.api.get<CollectionRecord[]>("/api/collections");
      setCollections(Array.isArray(result.data) ? result.data : []);
    } catch (reason) { runtime.notify(reason instanceof Error ? reason.message : "文件集读取失败", "error"); }
    finally { setLoading(false); }
  };

  const showSkills = async () => {
    setPage("skills");
    setLoading(true);
    try {
      const result = await runtime.api.get<SkillCatalog>("/api/skills");
      setSkills(Array.isArray(result.data?.registries) ? result.data.registries : []);
    } catch (reason) { runtime.notify(reason instanceof Error ? reason.message : "Skill 读取失败", "error"); }
    finally { setLoading(false); }
  };

  const toggleCollection = (collection: CollectionRecord) => {
    const selected = value.collections.some((item) => item.id === collection.id);
    onChange({ ...value, collections: selected ? value.collections.filter((item) => item.id !== collection.id) : [...value.collections, collection] });
  };

  const toggleSkill = (registry: SkillRegistry) => {
    const pin = activePin(registry);
    if (!pin) return;
    const selected = value.skills.some((item) => item.skillId === pin.skillId);
    onChange({ ...value, skills: selected ? value.skills.filter((item) => item.skillId !== pin.skillId) : [...value.skills, pin] });
  };

  return <div className={styles.root} ref={root}>
    <button className={styles.trigger} disabled={disabled} aria-label="添加文件、文件集或 Skill" aria-expanded={open} onClick={() => { setOpen((current) => !current); setPage("root"); }}><Plus size={19} /></button>
    <input ref={fileInput} className={styles.hiddenInput} type="file" multiple onChange={(event) => {
      const next = [...(event.target.files ?? [])];
      if (next.length) onChange({ ...value, files: [...value.files, ...next] });
      event.target.value = "";
      setOpen(false);
    }} />
    {open ? <div className={styles.menu}>
      <div className={`${styles.pages} ${page !== "root" ? styles.detailPage : ""}`}>
        <div className={styles.page} aria-hidden={page !== "root"}>
          <button onClick={() => fileInput.current?.click()}><FilePlus2 size={17} /><span>上传文件</span></button>
          <button onClick={() => void showCollections()}><FolderSearch size={17} /><span>选择文件集</span><ChevronRight size={15} /></button>
          <button onClick={() => void showSkills()}><Sparkles size={17} /><span>选择 Skill</span><ChevronRight size={15} /></button>
        </div>
        <div className={styles.page} aria-hidden={page === "root"}>
          <div className={styles.pageTitle}><button aria-label="返回" onClick={() => setPage("root")}><ChevronLeft size={17} /></button><strong>{page === "collections" ? "文件集" : "Skill"}</strong></div>
          <div className={styles.options}>{loading ? <p>正在读取…</p> : page === "collections" ? collections.map((collection) => {
            const selected = value.collections.some((item) => item.id === collection.id);
            return <button key={collection.id} className={selected ? styles.selected : ""} onClick={() => toggleCollection(collection)}><span>{collection.name}</span>{selected ? <Check size={15} /> : null}</button>;
          }) : skills.map((registry) => {
            const pin = activePin(registry);
            const selected = value.skills.some((item) => item.skillId === registry.skillId);
            return <button key={registry.skillId} disabled={!pin} className={selected ? styles.selected : ""} title={pin ? undefined : "该 Skill 没有活动版本"} onClick={() => toggleSkill(registry)}><span><strong>{registry.displayName}</strong><small>{pin ? `v${pin.version}` : "未激活"}</small></span>{selected ? <Check size={15} /> : null}</button>;
          })}</div>
        </div>
      </div>
    </div> : null}
  </div>;
}

export function ComposerResourceChips({ value, onChange }: { value: ComposerResourceSelection; onChange: (value: ComposerResourceSelection) => void }) {
  return <div className={styles.chips}>
    {value.files.map((file, index) => <span key={`${file.name}:${file.size}:${index}`}><FilePlus2 size={13} />{file.name}<button aria-label={`移除 ${file.name}`} onClick={() => onChange({ ...value, files: value.files.filter((_, item) => item !== index) })}><X size={12} /></button></span>)}
    {value.collections.map((collection) => <span key={collection.id}><FolderSearch size={13} />{collection.name}<button aria-label={`移除文件集 ${collection.name}`} onClick={() => onChange({ ...value, collections: value.collections.filter((item) => item.id !== collection.id) })}><X size={12} /></button></span>)}
    {value.skills.map((skill) => <span key={skill.skillId}><Sparkles size={13} />{skill.displayName}<button aria-label={`移除 Skill ${skill.displayName}`} onClick={() => onChange({ ...value, skills: value.skills.filter((item) => item.skillId !== skill.skillId) })}><X size={12} /></button></span>)}
  </div>;
}
