"use client";

import { Children, isValidElement, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { Check, Copy } from "lucide-react";
import styles from "./MarkdownContent.module.css";

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

const languageLabels: Record<string, string> = {
  javascript: "JavaScript", js: "JavaScript", typescript: "TypeScript", ts: "TypeScript",
  python: "Python", py: "Python", json: "JSON", yaml: "YAML", yml: "YAML", toml: "TOML",
  css: "CSS", html: "HTML", jsx: "JSX", tsx: "TSX",
};

export function MarkdownContent({ content, compact = false }: { content: string; compact?: boolean }) {
  const normalizedContent = String(content || "").replace(
    /^(\s*(?:#{1,6}\s+.+|\*\*[^*\n]+\*\*|__[^_\n]+__))\r?\n(?=\s*\d+[.)]\s+)/gm,
    "$1\n\n",
  );
  return <div className={`${styles.markdown} ${compact ? styles.compact : ""}`}>
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      components={{
        a: ({ children, ...props }) => <a {...props} target="_blank" rel="noreferrer">{children}</a>,
        pre: ({ children }) => {
          const language = fencedCodeLanguage(children);
          const terminal = /^(?:bash|sh|shell|console|terminal|zsh|fish|powershell|pwsh|cmd)$/.test(language);
          const source = nodeText(children).replace(/\n$/, "");
          return <div className={styles.copyableCodeBlock}>
            <BlockCopyButton content={source} label="复制代码" />
            <pre className={`${styles.remoteTerminal} ${styles.markdownTerminal} ${terminal ? styles.terminalFence : styles.codeFence}`}>
              <span className={styles.terminalCaption}><i />{terminal ? "终端" : languageLabels[language] || language || "代码"}</span>
              {children}
            </pre>
          </div>;
        },
        code: ({ children, className }) => {
          const value = String(children).replace(/\n$/, "");
          const block = Boolean(className) || value.includes("\n");
          return <code className={block || compact ? className : `${styles.inlineField} ${styles[`tone${inlineTone(value)}`]}`}>{children}</code>;
        },
        table: ({ children }) => <div className={styles.tableWrap}>
          <BlockCopyButton content={nodeText(children)} label="复制表格内容" />
          <table>{children}</table>
        </div>,
        blockquote: ({ children }) => <blockquote className={styles.quoteBlock}>
          <BlockCopyButton content={nodeText(children)} label="复制引用内容" />
          {children}
        </blockquote>,
      }}
    >{normalizedContent}</ReactMarkdown>
  </div>;
}
