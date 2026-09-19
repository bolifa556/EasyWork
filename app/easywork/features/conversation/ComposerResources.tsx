"use client";

import { useEffect, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import { Check, ChevronLeft, ChevronRight, FilePlus2, Folder, FolderSearch, Library, Paperclip, Plus, Sparkles, X } from "lucide-react";
import { useAppRuntime } from "../../runtime/AppRuntime";
import styles from "./ComposerResources.module.css";
import { isImageFile } from "../../../../shared/images.mjs";
import { LocalConversationImage } from "./ConversationImage";

type CollectionRecord = { id: string; name: string };
type SkillRecord = { skillId: string; name: string; description: string };
type SkillCatalog = { items: SkillRecord[] };

export type SelectedSkill = { skillId: string; displayName: string };
export type ComposerResourceSelection = {
  files: File[];
  collections: CollectionRecord[];
  skills: SelectedSkill[];
};

export const emptyComposerResources: ComposerResourceSelection = { files: [], collections: [], skills: [] };

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
  const [direction, setDirection] = useState<"up" | "down">("up");
  const [collections, setCollections] = useState<CollectionRecord[]>([]);
  const [skills, setSkills] = useState<SkillRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [collectionsLoaded, setCollectionsLoaded] = useState(false);
  const [skillsLoaded, setSkillsLoaded] = useState(false);

  useEffect(() => {
    const close = (event: PointerEvent) => {
      const target = event.target;
      if (!root.current || !(target instanceof Node) || root.current.contains(target)) return;
      if (target instanceof Element && target.closest("[data-composer-resource-chips]")) return;
      setOpen(false);
      window.setTimeout(() => setPage("root"), 220);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);

  const showCollections = async () => {
    setPage("collections");
    if (collectionsLoaded) return;
    setLoading(true);
    try {
      const result = await runtime.api.get<CollectionRecord[]>("/api/collections");
      setCollections(Array.isArray(result.data) ? result.data : []);
      setCollectionsLoaded(true);
    } catch (reason) { runtime.notify(reason instanceof Error ? reason.message : "文件集读取失败", "error"); }
    finally { setLoading(false); }
  };

  const showSkills = async () => {
    setPage("skills");
    if (skillsLoaded) return;
    setLoading(true);
    try {
      const result = await runtime.api.get<SkillCatalog>("/api/skill-center/installed");
      setSkills(Array.isArray(result.data?.items) ? result.data.items : []);
      setSkillsLoaded(true);
    } catch (reason) { runtime.notify(reason instanceof Error ? reason.message : "Skill 读取失败", "error"); }
    finally { setLoading(false); }
  };

  const toggleCollection = (collection: CollectionRecord) => {
    const selected = value.collections.some((item) => item.id === collection.id);
    onChange({ ...value, collections: selected ? value.collections.filter((item) => item.id !== collection.id) : [...value.collections, collection] });
  };

  const toggleSkill = (registry: SkillRecord) => {
    const pin = { skillId: registry.skillId, displayName: registry.name };
    const selected = value.skills.some((item) => item.skillId === pin.skillId);
    onChange({ ...value, skills: selected ? value.skills.filter((item) => item.skillId !== pin.skillId) : [...value.skills, pin] });
  };

  const activeSkills = skills;
  const skillMenuHeight = Math.min(54 + Math.max(activeSkills.length, 1) * 52, 314);
  const collectionMenuHeight = Math.min(54 + Math.max(collections.length, 1) * 48, 314);
  const menuStyle = {
    "--composer-skill-height": `${skillMenuHeight}px`,
    "--composer-collection-height": `${collectionMenuHeight}px`,
  } as CSSProperties;

  return <div className={styles.root} ref={root}>
    <button type="button" className={styles.trigger} disabled={disabled} aria-label="添加文件、文件集或 Skill" aria-expanded={open} onClick={() => {
      if (!open) {
        const rootRect = root.current?.getBoundingClientRect();
        const top = rootRect?.top ?? window.innerHeight;
        setDirection(top >= 326 ? "up" : "down");
        setPage("root");
      }
      setOpen((current) => !current);
    }}><Plus size={19} /></button>
    <input ref={fileInput} className={styles.hiddenInput} type="file" multiple onChange={(event) => {
      const next = [...(event.target.files ?? [])];
      if (next.length) onChange({ ...value, files: [...value.files, ...next] });
      event.target.value = "";
      setOpen(false);
    }} />
    {open ? <div className={`${styles.menu} ${styles[direction]} ${styles[`show${page[0].toUpperCase()}${page.slice(1)}`]}`} style={menuStyle}>
      <div className={styles.pages}>
        <div className={styles.page} aria-hidden={page !== "root"}>
          <button type="button" onClick={() => fileInput.current?.click()}><span data-ui-icon="" className={styles.menuIcon}><Paperclip size={17} /></span><span>上传文件</span></button>
          <button type="button" onClick={() => void showSkills()}><span data-ui-icon="" className={styles.menuIcon}><Sparkles size={17} /></span><span>选择技能</span><ChevronRight size={16} /></button>
          <button type="button" onClick={() => void showCollections()}><span data-ui-icon="" className={styles.menuIcon}><Library size={17} /></span><span>选择文件集</span><ChevronRight size={16} /></button>
        </div>
        <div className={styles.page} aria-hidden={page !== "skills"}>
          <button type="button" className={styles.pageBack} aria-label="返回" onClick={() => setPage("root")}><ChevronLeft size={16} /><span>返回</span></button>
          <div className={styles.options}>{loading && page === "skills" ? <p>正在读取…</p> : activeSkills.map((registry) => {
            const selected = value.skills.some((item) => item.skillId === registry.skillId);
            return <button type="button" key={registry.skillId} className={selected ? styles.selected : ""} onClick={() => toggleSkill(registry)}>
              <span data-ui-icon="" className={styles.menuIcon}><Sparkles size={16} /></span>
              <span className={styles.optionCopy}><strong>{registry.name}</strong>{registry.description ? <small>{registry.description}</small> : null}</span>
              <span className={styles.optionCheck}>{selected ? <Check size={14} /> : null}</span>
            </button>;
          })}{!loading && !activeSkills.length ? <p>暂无已安装的技能</p> : null}</div>
        </div>
        <div className={styles.page} aria-hidden={page !== "collections"}>
          <button type="button" className={styles.pageBack} aria-label="返回" onClick={() => setPage("root")}><ChevronLeft size={16} /><span>返回</span></button>
          <div className={styles.options}>{loading && page === "collections" ? <p>正在读取…</p> : collections.map((collection) => {
            const selected = value.collections.some((item) => item.id === collection.id);
            return <button type="button" key={collection.id} className={selected ? styles.selected : ""} onClick={() => toggleCollection(collection)}>
              <span data-ui-icon="" className={styles.menuIcon}><Folder size={16} /></span>
              <span className={styles.optionCopy}><strong>{collection.name}</strong></span>
              <span className={styles.optionCheck}>{selected ? <Check size={14} /> : null}</span>
            </button>;
          })}{!loading && !collections.length ? <p>还没有文件集</p> : null}</div>
        </div>
      </div>
    </div> : null}
  </div>;
}

export function ComposerResourceChips({ value, onChange }: { value: ComposerResourceSelection; onChange: (value: ComposerResourceSelection) => void }) {
  const remove = (event: MouseEvent<HTMLButtonElement>, next: ComposerResourceSelection) => {
    event.preventDefault();
    event.stopPropagation();
    onChange(next);
  };
  return <div className={styles.chips} data-composer-resource-chips onPointerDown={(event) => event.stopPropagation()}>
    {value.files.map((file, index) => isImageFile(file)
      ? <LocalConversationImage key={`${file.name}:${file.size}:${index}`} file={file} onRemove={() => onChange({ ...value, files: value.files.filter((_, item) => item !== index) })} />
      : <span className={styles.fileChip} key={`${file.name}:${file.size}:${index}`}><FilePlus2 size={13} /><span className={styles.chipLabel}>{file.name}</span><button type="button" aria-label={`移除 ${file.name}`} onClick={(event) => remove(event, { ...value, files: value.files.filter((_, item) => item !== index) })}><X size={12} /></button></span>)}
    {value.collections.map((collection) => <span key={collection.id}><FolderSearch size={13} /><span className={styles.chipLabel}>{collection.name}</span><button type="button" aria-label={`移除文件集 ${collection.name}`} onClick={(event) => remove(event, { ...value, collections: value.collections.filter((item) => item.id !== collection.id) })}><X size={12} /></button></span>)}
    {value.skills.map((skill) => <span key={skill.skillId}><Sparkles size={13} /><span className={styles.chipLabel}>{skill.displayName}</span><button type="button" aria-label={`移除 Skill ${skill.displayName}`} onClick={(event) => remove(event, { ...value, skills: value.skills.filter((item) => item.skillId !== skill.skillId) })}><X size={12} /></button></span>)}
  </div>;
}
