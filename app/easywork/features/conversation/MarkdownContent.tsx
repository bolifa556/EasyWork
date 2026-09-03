"use client";

import { Children, isValidElement, useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { Check, Copy } from "lucide-react";
import styles from "./MarkdownContent.module.css";
import { ensureBlankLineBeforeTables, protectShellVariablesFromInlineMath } from "./markdown-normalization.mjs";

type MarkdownAstNode = {
  type: string;
  depth?: number;
  value?: string;
  url?: string;
  children?: MarkdownAstNode[];
  data?: { hProperties?: Record<string, unknown> };
};

function markdownAstText(node: MarkdownAstNode): string {
  if (typeof node.value === "string") return node.value;
  return (node.children || []).map(markdownAstText).join("");
}

function standaloneStrongChildren(node: MarkdownAstNode) {
  if (node.type !== "paragraph" || !node.children?.length) return null;
  const meaningful = node.children.filter((child) => child.type !== "text" || Boolean(child.value?.trim()));
  if (meaningful.length !== 1 || meaningful[0].type !== "strong" || !meaningful[0].children?.length) return null;
  return meaningful[0].children;
}

function isInstalledSkillsHeading(node: MarkdownAstNode) {
  if (node.type !== "heading" && !standaloneStrongChildren(node)) return false;
  const compact = markdownAstText(node).replace(/[\s:：]/g, "").toLowerCase();
  return /^(?:已安装(?:的)?(?:技能|skills?)|installedskills?)$/.test(compact);
}

function skillNameChildren(node: MarkdownAstNode, sectionDepth: number) {
  if (node.type === "heading" && (node.depth ?? 0) > sectionDepth) return node.children || null;
  return standaloneStrongChildren(node);
}

function markSkillSummaryRow(node: MarkdownAstNode) {
  node.data = {
    ...node.data,
    hProperties: { ...node.data?.hProperties, className: "skill-summary-row" },
  };
  return node;
}

function skillSummaryInlineChildren(node: MarkdownAstNode) {
  const result: MarkdownAstNode[] = [];
  for (const child of node.children || []) {
    const text = markdownAstText(child).trim();
    if (!text || text === "|") continue;
    const inline = ["paragraph", "heading"].includes(child.type) && child.children?.length
      ? child.children
      : [{ type: "text", value: text }];
    if (result.length) result.push({ type: "text", value: " " });
    result.push(...inline);
  }
  return result;
}

function compactSkillSummaryRow(node: MarkdownAstNode) {
  const children = skillSummaryInlineChildren(node);
  if (children.length) node.children = [{ type: "paragraph", children }];
  return markSkillSummaryRow(node);
}

function looseStrongTextNodes(value: string) {
  const nodes: MarkdownAstNode[] = [];
  const expression = /(\*\*|__)([ \t]*)([^\r\n]*?\S)([ \t]*)\1/g;
  let cursor = 0;
  let replaced = false;
  for (const match of value.matchAll(expression)) {
    const index = match.index ?? 0;
    const [raw, marker, , content] = match;
    const before = value[index - 1] || "";
    const after = value[index + raw.length] || "";
    if (marker === "__" && (/\w/.test(before) || /\w/.test(after))) continue;
    if (index > cursor) nodes.push({ type: "text", value: value.slice(cursor, index) });
    nodes.push({ type: "strong", children: [{ type: "text", value: content.trim() }] });
    cursor = index + raw.length;
    replaced = true;
  }
  if (!replaced) return null;
  if (cursor < value.length) nodes.push({ type: "text", value: value.slice(cursor) });
  return nodes;
}

function remarkLooseStrongMarkers() {
  const opaqueNodes = new Set(["code", "inlineCode", "html", "math", "inlineMath"]);
  const rewrite = (node: MarkdownAstNode) => {
    if (opaqueNodes.has(node.type) || !node.children?.length) return;
    const children: MarkdownAstNode[] = [];
    for (const child of node.children) {
      if (child.type === "text" && typeof child.value === "string") {
        children.push(...(looseStrongTextNodes(child.value) || [child]));
      } else {
        rewrite(child);
        children.push(child);
      }
    }
    node.children = children;
  };
  return (root: MarkdownAstNode) => rewrite(root);
}

const PLAIN_URL_BOUNDARY = /[）】》」』〉〕］｝，。；：！？、]/u;

function remarkPlainUrlBoundaries() {
  const rewrite = (node: MarkdownAstNode) => {
    if (!node.children?.length) return;
    const children: MarkdownAstNode[] = [];
    for (const child of node.children) {
      rewrite(child);
      const text = markdownAstText(child);
      const boundary = child.type === "link" && /^https?:\/\//i.test(String(child.url || "")) && text === child.url
        ? String(child.url).search(PLAIN_URL_BOUNDARY)
        : -1;
      if (boundary <= 0) {
        children.push(child);
        continue;
      }
      const url = String(child.url).slice(0, boundary);
      children.push({ ...child, url, children: [{ type: "text", value: url }] });
      children.push({ type: "text", value: text.slice(boundary) });
    }
    node.children = children;
  };
  return (root: MarkdownAstNode) => rewrite(root);
}

function remarkInstalledSkillRows() {
  return (root: MarkdownAstNode) => {
    if (root.type !== "root" || !root.children) return;
    let sectionDepth: number | null = null;
    for (let index = 0; index < root.children.length; index += 1) {
      const node = root.children[index];
      if (isInstalledSkillsHeading(node)) {
        sectionDepth = node.type === "heading" ? node.depth ?? 2 : 2;
        continue;
      }
      if (node.type === "heading" && sectionDepth !== null && (node.depth ?? 7) <= sectionDepth) {
        sectionDepth = null;
        continue;
      }
      if (sectionDepth === null) continue;
      if (node.type === "blockquote") {
        compactSkillSummaryRow(node);
        continue;
      }
      const nameChildren = skillNameChildren(node, sectionDepth);
      if (!nameChildren?.length) continue;
      const quote = root.children[index + 1];
      const descriptionChildren = quote?.type === "blockquote" ? skillSummaryInlineChildren(quote) : [];
      if (!descriptionChildren.length) continue;
      const row = markSkillSummaryRow({
        type: "blockquote",
        children: [{
          type: "paragraph",
          children: [
            { type: "strong", children: nameChildren },
            { type: "text", value: " " },
            ...descriptionChildren,
          ],
        }],
      });
      root.children.splice(index, 2, row);
    }
  };
}

function nodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return nodeText(node.props.children);
  return "";
}

async function copyPlainText(content: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(content);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = content;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

function BlockCopyButton({ content, label = "复制内容" }: { content: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  if (!content.trim()) return null;
  return <button
    className={`${styles.blockCopyButton} ${copied ? styles.copied : ""}`}
    type="button"
    aria-label={copied ? "已复制" : label}
    title={copied ? "已复制" : label}
    onClick={(event) => {
      event.preventDefault();
      event.stopPropagation();
      void copyPlainText(content).then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1_400);
      });
    }}
  >{copied ? <Check size={13} /> : <Copy size={13} />}</button>;
}

type CodeScrollState = { max: number; value: number; thumbWidth: number; visible: boolean };

function MarkdownCodeBlock({ children, source, terminal, activity }: { children: ReactNode; source: string; terminal: boolean; activity: boolean }) {
  const blockRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLPreElement>(null);
  const scrollbarRef = useRef<HTMLInputElement>(null);
  const [scroll, setScroll] = useState<CodeScrollState>({ max: 0, value: 0, thumbWidth: 30, visible: false });
  const syncScroll = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const max = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
    const trackWidth = Math.max(0, scrollbarRef.current?.clientWidth || viewport.clientWidth);
    const proportionalThumb = viewport.scrollWidth > 0 ? Math.round(trackWidth * viewport.clientWidth / viewport.scrollWidth) : trackWidth;
    const maximumThumb = Math.min(180, Math.max(72, Math.round(trackWidth * 0.24)));
    const thumbWidth = max > 1
      ? Math.min(trackWidth, maximumThumb, Math.max(32, proportionalThumb))
      : trackWidth;
    const value = Math.min(max, Math.max(0, viewport.scrollLeft));
    setScroll((current) => current.max === max
      && current.value === value
      && current.thumbWidth === thumbWidth
      && current.visible === (max > 1)
      ? current
      : { max, value, thumbWidth, visible: max > 1 });
  }, []);
  useEffect(() => {
    const block = blockRef.current;
    const viewport = viewportRef.current;
    if (!block || !viewport) return;
    syncScroll();
    const handleWheel = (event: WheelEvent) => {
      const max = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
      if (max <= 1) return;
      const rawDelta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (!rawDelta) return;
      const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? 16
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? viewport.clientWidth
          : 1;
      const next = Math.min(max, Math.max(0, viewport.scrollLeft + rawDelta * unit));
      event.preventDefault();
      event.stopPropagation();
      if (next === viewport.scrollLeft) return;
      viewport.scrollLeft = next;
      syncScroll();
    };
    block.addEventListener("wheel", handleWheel, { passive: false });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(syncScroll);
    observer?.observe(viewport);
    if (viewport.firstElementChild instanceof HTMLElement) observer?.observe(viewport.firstElementChild);
    let cancelled = false;
    void document.fonts?.ready.then(() => { if (!cancelled) syncScroll(); });
    return () => {
      cancelled = true;
      block.removeEventListener("wheel", handleWheel);
      observer?.disconnect();
    };
  }, [source, syncScroll]);
  const withCopy = !activity && Boolean(source.trim());
  return <div ref={blockRef} className={`${styles.copyableCodeBlock} ${withCopy ? styles.copyableCodeBlockWithCopy : ""}`}>
    {withCopy ? <BlockCopyButton content={source} label="复制代码" /> : null}
    <pre
      ref={viewportRef}
      className={`${styles.remoteTerminal} ${styles.markdownTerminal} ${terminal ? styles.terminalFence : styles.codeFence}`}
      onScroll={syncScroll}
    >{children}</pre>
    <input
      ref={scrollbarRef}
      className={`${styles.codeScrollbar} ${scroll.visible ? "" : styles.codeScrollbarHidden}`}
      style={{ "--code-scroll-thumb-width": `${scroll.thumbWidth}px` } as CSSProperties}
      type="range"
      min={0}
      max={Math.max(1, scroll.max)}
      step="any"
      value={scroll.value}
      tabIndex={scroll.visible ? 0 : -1}
      aria-label="横向滚动代码"
      aria-hidden={!scroll.visible}
      onChange={(event) => {
        if (!viewportRef.current) return;
        viewportRef.current.scrollLeft = Number(event.currentTarget.value);
        syncScroll();
      }}
    />
  </div>;
}

function inlineTone(value: string) {
  let hash = 0;
  for (const character of value) hash = (hash * 31 + character.codePointAt(0)!) >>> 0;
  return hash % 5;
}

function fencedCodeLanguage(children: ReactNode) {
  const child = Children.toArray(children)[0];
  if (!isValidElement<{ className?: string }>(child)) return "";
  return String(child.props.className || "").match(/(?:^|\s)language-([^\s]+)/i)?.[1]?.toLowerCase() || "";
}

export function MarkdownContent({ content, compact = false, activity = false }: { content: string; compact?: boolean; activity?: boolean }) {
  const normalizedContent = ensureBlankLineBeforeTables(protectShellVariablesFromInlineMath(String(content || "").replace(/<\/?think>/gi, "").replace(
    /^(\s*(?:#{1,6}\s+.+|\*\*[^*\n]+\*\*|__[^_\n]+__))\r?\n(?=\s*\d+[.)]\s+)/gm,
    "$1\n\n",
  )));
  return <div className={`${styles.markdown} ${compact ? styles.compact : ""} ${activity ? styles.activity : ""}`}>
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath, remarkPlainUrlBoundaries, remarkLooseStrongMarkers, remarkInstalledSkillRows]}
      rehypePlugins={[rehypeKatex]}
      components={{
        a: ({ children, ...props }) => <a {...props} target="_blank" rel="noreferrer">{children}</a>,
        pre: ({ children }) => {
          const language = fencedCodeLanguage(children);
          const terminal = /^(?:bash|sh|shell|console|terminal|zsh|fish|powershell|pwsh|cmd)$/.test(language);
          const source = nodeText(children).replace(/\n$/, "");
          return <MarkdownCodeBlock source={source} terminal={terminal} activity={activity}>{children}</MarkdownCodeBlock>;
        },
        code: ({ children, className }) => {
          const value = String(children).replace(/\n$/, "");
          const block = Boolean(className) || value.includes("\n");
          return <code className={block ? className : activity ? styles.activityInline : compact ? className : `${styles.inlineField} ${styles[`tone${inlineTone(value)}`]}`}>{children}</code>;
        },
        table: ({ children }) => <div className={styles.tableWrap}>
          {!activity ? <BlockCopyButton content={nodeText(children)} label="复制表格内容" /> : null}
          <table>{children}</table>
        </div>,
        blockquote: ({ children, className }) => <blockquote className={`${styles.quoteBlock} ${String(className || "").includes("skill-summary-row") ? styles.skillSummaryRow : ""}`}>
          {!activity ? <BlockCopyButton content={nodeText(children)} label="复制引用内容" /> : null}
          {children}
        </blockquote>,
      }}
    >{normalizedContent}</ReactMarkdown>
  </div>;
}
