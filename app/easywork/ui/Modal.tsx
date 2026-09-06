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
  backdropClassName?: string;
  bodyClassName?: string;
  headerAction?: ReactNode;
  floating?: boolean;
  hideCloseButton?: boolean;
  onClose: () => void;
  children: ReactNode;
};

export function Modal({ title, subtitle, size = "normal", panelClassName = "", backdropClassName = "", bodyClassName = "", headerAction, floating = false, hideCloseButton = false, onClose, children }: Props) {
  const panelRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
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
    const focusHandle = !floating ? window.setTimeout(() => {
      const autofocus = panel?.querySelector<HTMLElement>("[autofocus]");
      const active = document.activeElement instanceof HTMLElement && panel?.contains(document.activeElement) ? document.activeElement : null;
      (autofocus && autofocus.offsetParent !== null ? autofocus : active && active.offsetParent !== null ? active : focusable()[0])?.focus();
    }, 0) : null;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onCloseRef.current(); return; }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) { event.preventDefault(); panel?.focus(); return; }
      const first = items[0];
      const last = items.at(-1) as HTMLElement;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", handleKey);
    return () => {
      if (focusHandle !== null) window.clearTimeout(focusHandle);
      window.removeEventListener("keydown", handleKey);
      previous?.focus();
    };
  }, [floating, portalTarget]);
  if (!portalTarget) return null;
  return createPortal(
    <div className={`${styles.backdrop} ${floating ? styles.floatingBackdrop : ""} ${backdropClassName}`} role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
      <section ref={panelRef} tabIndex={-1} className={`${styles.panel} ${size !== "normal" ? styles[size] : ""} ${floating ? styles.floatingPanel : ""} ${panelClassName}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className={`${styles.header} ${floating ? styles.floatingHeader : ""}`}>
          <div className={styles.heading}><h2>{title}</h2>{subtitle ? <p>{subtitle}</p> : null}</div>
          {headerAction || !hideCloseButton ? <div className={styles.headerActions}>{headerAction}{!hideCloseButton ? <Button variant="ghost" iconOnly aria-label="关闭" onClick={onClose} icon={<X size={18} />} /> : null}</div> : null}
        </header>
        <div className={`${styles.body} ${bodyClassName}`}>{children}</div>
      </section>
    </div>,
    portalTarget,
  );
}
