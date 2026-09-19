"use client";

import { createContext, memo, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import styles from "./DisclosureMotion.module.css";

type DisclosureGate = { setPending: (id: string, pending: boolean) => void; revealTogether: boolean; progressive: boolean };
const GateContext = createContext<DisclosureGate | null>(null);

export function useDisclosurePending(pending: boolean) {
  const gate = useContext(GateContext);
  const id = useId();
  const report = gate?.setPending;
  useLayoutEffect(() => {
    report?.(id, pending);
    return () => report?.(id, false);
  }, [id, pending, report]);
}

// Some callers stop providing detail text as soon as they close. Retain the
// rendered subtree, including its open descendants, throughout the exit.
const RetainedContent = memo(function RetainedContent({ children }: { open: boolean; children: ReactNode }) {
  return children;
}, (previous, next) => !next.open || previous.children === next.children);

export function DisclosureMotion({ open, ready = true, progressive = false, className = "", children }: {
  open: boolean;
  ready?: boolean;
  progressive?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const parent = useContext(GateContext);
  const revealProgressively = progressive || Boolean(parent?.progressive);
  const [motion, setMotion] = useState({ requestedOpen: open, mounted: open, expanded: false });
  const [pendingChildren, setPendingChildren] = useState<ReadonlySet<string>>(() => new Set());
  const [showPending, setShowPending] = useState(false);
  if (motion.requestedOpen !== open) {
    setMotion({ requestedOpen: open, mounted: open || motion.mounted, expanded: false });
  }
  const expanded = open && motion.expanded;
  const setPending = useCallback((id: string, pending: boolean) => {
    setPendingChildren(current => {
      if (current.has(id) === pending) return current;
      const next = new Set(current);
      if (pending) next.add(id); else next.delete(id);
      return next;
    });
  }, []);
  // Live output must paint as it arrives. A historical detail request in a
  // sibling must not hold the entire running activity at zero height.
  const waiting = open && !revealProgressively && (!ready || pendingChildren.size > 0);
  useDisclosurePending(waiting && !expanded);
  const gate = useMemo(() => ({ setPending, progressive: revealProgressively, revealTogether: !revealProgressively && (!expanded || Boolean(parent?.revealTogether)) }), [expanded, parent?.revealTogether, revealProgressively, setPending]);
  const preparing = waiting && !expanded;
  useEffect(() => {
    if (!preparing) return;
    const timer = window.setTimeout(() => setShowPending(true), 180);
    return () => { window.clearTimeout(timer); setShowPending(false); };
  }, [preparing]);

  useLayoutEffect(() => {
    if (!open) {
      if (!motion.mounted) return;
      // Keep the last rendered body intact until the closing transition ends.
      // The fallback also handles reduced motion and interrupted transitions.
      const timeout = window.setTimeout(() => setMotion((current) => ({ ...current, mounted: false })), window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 280);
      return () => window.clearTimeout(timeout);
    }
    // New live data or a nested click must never collapse an already open level.
    if (expanded || waiting) return;
    // Prepare the complete first view, including already-open descendants, at
    // zero height. One entrance prevents late activity rows displacing text.
    const reveal = () => setMotion((current) => ({ ...current, expanded: true }));
    let frame = requestAnimationFrame(() => {
      if (parent?.revealTogether) reveal();
      else frame = requestAnimationFrame(reveal);
    });
    return () => cancelAnimationFrame(frame);
  }, [expanded, open, parent?.revealTogether, motion.mounted, waiting]);

  if (!open && !motion.mounted) return null;
  return <><div
    className={`${styles.motion} ${className}`}
    data-disclosure-state={!open ? "closing" : expanded ? "open" : "preparing"}
    data-expanded={expanded}
    data-reveal-together={Boolean(parent?.revealTogether)}
    data-disclosure-pending={preparing && showPending || undefined}
    aria-busy={waiting || undefined}
    aria-hidden={!open || !expanded}
    inert={!open || !expanded}
    onTransitionEnd={(event) => {
      if (event.target === event.currentTarget && event.propertyName === "grid-template-rows" && !open) setMotion((current) => ({ ...current, mounted: false }));
    }}
  ><GateContext.Provider value={gate}><RetainedContent open={open}>{children}</RetainedContent></GateContext.Provider></div>
    {preparing && showPending ? <span className={styles.pendingAnnouncement} role="status">正在准备展开内容</span> : null}
  </>;
}
