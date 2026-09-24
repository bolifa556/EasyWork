"use client";

import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import styles from "./UserMessageBubble.module.css";

export function UserMessageBubble({ children }: { children: ReactNode }) {
  const contentId = useId();
  const bubble = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const restorePosition = useRef(false);
  const [expanded, setExpanded] = useState(false);
  const [collapsible, setCollapsible] = useState(false);

  useLayoutEffect(() => {
    const element = content.current;
    if (!element) return;
    // Measure the full text independently of the collapsed scroll viewport.
    const measure = () => {
      const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
      setCollapsible(element.scrollHeight > lineHeight * 8 + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    document.fonts.addEventListener("loadingdone", measure);
    return () => {
      observer.disconnect();
      document.fonts.removeEventListener("loadingdone", measure);
    };
  }, [children]);

  useLayoutEffect(() => {
    const element = bubble.current;
    const scroller = viewport.current;
    if (!element || !scroller || !collapsible || expanded) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame: number | null = null;
    let target = scroller.scrollTop;
    let position = target;
    let previousTime = 0;
    const limit = (top: number) => Math.max(0, Math.min(scroller.scrollHeight - scroller.clientHeight, top));
    const cancel = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
    };
    // Smooth coarse wheel steps and forward gestures over the padding. Merge
    // their distance into one animation rather than restarting it per event.
    const advance = (time: number) => {
      target = limit(target);
      position = limit(position);
      const remaining = target - position;
      if (Math.abs(remaining) <= .5 || reducedMotion.matches) {
        scroller.scrollTop = target;
        frame = null;
        return;
      }
      const progress = 1 - Math.exp(-Math.max(0, time - previousTime) / 45);
      previousTime = time;
      // Keep fractional progress so scrollTop rounding cannot stall the tail.
      position += remaining * progress;
      scroller.scrollTop = position;
      frame = requestAnimationFrame(advance);
    };
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.shiftKey || !event.deltaY) return;
      const finePixels = event.deltaMode === WheelEvent.DOM_DELTA_PIXEL && Math.abs(event.deltaY) < 40;
      if (finePixels && event.target instanceof Node && scroller.contains(event.target)) {
        cancel();
        // Preserve fine-grained native input and inertia. Keep the outer
        // conversation's scroll bookkeeping idle while reading this message.
        if (event.deltaY < 0 ? scroller.scrollTop > 0 : scroller.scrollTop < limit(Infinity) - 1) event.stopPropagation();
        return;
      }
      const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? Number.parseFloat(getComputedStyle(scroller).lineHeight)
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? scroller.clientHeight : 1;
      const delta = event.deltaY * unit;
      const continuing = frame !== null && Math.sign(target - scroller.scrollTop) === Math.sign(delta);
      const top = limit((continuing ? target : scroller.scrollTop) + delta);
      if (frame === null && Math.abs(top - scroller.scrollTop) < 1) return;
      event.preventDefault();
      target = top;
      if (reducedMotion.matches) {
        cancel();
        scroller.scrollTop = target;
      } else if (frame === null) {
        position = scroller.scrollTop;
        previousTime = performance.now();
        frame = requestAnimationFrame(advance);
      }
    };
    element.addEventListener("wheel", wheel, { passive: false });
    element.addEventListener("pointerdown", cancel, { passive: true });
    element.addEventListener("keydown", cancel);
    return () => {
      cancel();
      element.removeEventListener("wheel", wheel);
      element.removeEventListener("pointerdown", cancel);
      element.removeEventListener("keydown", cancel);
    };
  }, [collapsible, expanded]);

  useLayoutEffect(() => {
    viewport.current?.scrollTo({ top: 0, left: 0, behavior: "instant" });
    if (expanded || !restorePosition.current) return;
    restorePosition.current = false;
    // A long message may start far above the current viewport. Bring its
    // collapsed preview into view before paint without moving visible ones.
    bubble.current?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
  }, [expanded]);

  return <div ref={bubble} className={styles.bubble} data-collapsible={collapsible}>
    <div id={contentId} ref={viewport} className={styles.viewport} data-collapsed={!expanded}
      tabIndex={collapsible && !expanded ? 0 : undefined}
      role={collapsible && !expanded ? "region" : undefined}
      aria-label={collapsible && !expanded ? "提问内容" : undefined}
    ><div ref={content} className={styles.content}>{children}</div></div>
    {collapsible ? <div className={styles.controls}><button
      type="button"
      className={styles.toggle}
      aria-label={expanded ? "收起提问" : "展开完整提问"}
      aria-expanded={expanded}
      aria-controls={contentId}
      onClick={() => {
        restorePosition.current = expanded;
        setExpanded(!expanded);
      }}
    ><ChevronDown size={16} /></button></div> : null}
  </div>;
}
