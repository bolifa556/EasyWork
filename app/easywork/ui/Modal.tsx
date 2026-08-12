"use client";

import { X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button } from "./Button";
import styles from "./Modal.module.css";

type Props = {
  title: string;
  subtitle?: string;
  size?: "compact" | "normal" | "wide";
  panelClassName?: string;
  onClose: () => void;
  children: ReactNode;
};

export function Modal({ title, subtitle, size = "normal", panelClassName = "", onClose, children }: Props) {
  const panelRef = useRef<HTMLElement>(null);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const handle = window.setTimeout(() => setPortalTarget(document.body), 0);
    return () => window.clearTimeout(handle);
  }, []);
  useEffect(() => {
    if (!portalTarget) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    const focusable = () => [...(panel?.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? [])]
      .filter((element) => element.offsetParent !== null);
    window.setTimeout(() => focusable()[0]?.focus(), 0);
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) { event.preventDefault(); panel?.focus(); return; }
      const first = items[0];
      const last = items.at(-1) as HTMLElement;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", handleKey);
    return () => { window.removeEventListener("keydown", handleKey); previous?.focus(); };
  }, [onClose, portalTarget]);
  if (!portalTarget) return null;
  return createPortal(
    <div className={styles.backdrop} role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
      <section ref={panelRef} tabIndex={-1} className={`${styles.panel} ${size !== "normal" ? styles[size] : ""} ${panelClassName}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className={styles.header}>
          <div className={styles.heading}><h2>{title}</h2>{subtitle ? <p>{subtitle}</p> : null}</div>
          <Button variant="ghost" iconOnly aria-label="关闭" onClick={onClose} icon={<X size={18} />} />
        </header>
        <div className={styles.body}>{children}</div>
      </section>
    </div>,
    portalTarget,
  );
}
