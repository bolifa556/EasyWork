"use client";

import { createContext, memo, useCallback, useContext, useId, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import styles from "./DisclosureMotion.module.css";

type DisclosureGate = {
  setPending: (id: string, pending: boolean) => void;
  revealTogether: boolean;
};

const GateContext = createContext<DisclosureGate | null>(null);

// Some callers stop providing detail text as soon as they close. Retain the
// rendered subtree, including its open descendants, throughout the exit.
const RetainedContent = memo(function RetainedContent({ children }: { open: boolean; children: ReactNode }) {
  return children;
}, (previous, next) => !next.open || previous.children === next.children);

// Open descendants prepare while their enclosing disclosure is still hidden.
// The enclosing level is revealed only when all of its visible content is ready.
export function useDisclosurePending(pending: boolean) {
  const gate = useContext(GateContext);
  const id = useId();
  const report = gate?.setPending;
  useLayoutEffect(() => {
    report?.(id, pending);
    return () => report?.(id, false);
  }, [id, pending, report]);
}

export function DisclosureMotion({ open, ready = true, className = "", children }: {
  open: boolean;
  ready?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const parent = useContext(GateContext);
  const [motion, setMotion] = useState({ requestedOpen: open, mounted: open, expanded: false });
  const [pendingChildren, setPendingChildren] = useState<ReadonlySet<string>>(() => new Set());
  if (motion.requestedOpen !== open) {
    setMotion({ requestedOpen: open, mounted: open || motion.mounted, expanded: false });
  }
  const expanded = open && motion.expanded;
  const setPending = useCallback((id: string, pending: boolean) => {
    setPendingChildren((current) => {
      if (current.has(id) === pending) return current;
      const next = new Set(current);
      if (pending) next.add(id); else next.delete(id);
      return next;
    });
  }, []);
  const waiting = open && (!ready || pendingChildren.size > 0);
  useDisclosurePending(waiting);
  const gate = useMemo(() => ({ setPending, revealTogether: !expanded || Boolean(parent?.revealTogether) }), [expanded, parent?.revealTogether, setPending]);

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
    // Commit the complete body at zero height before starting its one transition.
    // Nested bodies settle first, without a separate entrance animation.
    const reveal = () => setMotion((current) => ({ ...current, expanded: true }));
    let frame = requestAnimationFrame(() => {
      if (parent?.revealTogether) reveal();
      else frame = requestAnimationFrame(reveal);
    });
    return () => cancelAnimationFrame(frame);
  }, [expanded, open, parent?.revealTogether, motion.mounted, waiting]);

  if (!open && !motion.mounted) return null;
  return <div
    className={`${styles.motion} ${className}`}
    data-disclosure-state={!open ? "closing" : expanded ? "open" : "preparing"}
    data-expanded={expanded}
    data-reveal-together={Boolean(parent?.revealTogether)}
    aria-busy={waiting || undefined}
    aria-hidden={!open || !expanded}
    inert={!open || !expanded}
    onTransitionEnd={(event) => {
      if (event.target === event.currentTarget && event.propertyName === "grid-template-rows" && !open) setMotion((current) => ({ ...current, mounted: false }));
    }}
  ><GateContext.Provider value={gate}><RetainedContent open={open}>{children}</RetainedContent></GateContext.Provider></div>;
}
