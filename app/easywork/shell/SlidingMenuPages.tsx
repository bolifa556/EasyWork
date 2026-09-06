import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import styles from "./AppShell.module.css";

export type ConversationMenuPage = "main" | "projects" | "copy";

export function SlidingMenuPages({ page, pages }: { page: ConversationMenuPage; pages: Record<ConversationMenuPage, ReactNode> }) {
  const root = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number>();
  useLayoutEffect(() => {
    const active = root.current?.querySelector<HTMLElement>(`[data-menu-page="${page}"]`);
    if (!active) return;
    const update = () => {
      setHeight(active.offsetHeight);
      const menu = root.current?.parentElement;
      if (page === "copy" && menu) {
        const style = getComputedStyle(menu);
        const frame = [style.paddingLeft, style.paddingRight, style.borderLeftWidth, style.borderRightWidth].reduce((total, value) => total + (parseFloat(value) || 0), 0);
        menu.style.setProperty("--copy-menu-width", `${Math.ceil(active.getBoundingClientRect().width + frame)}px`);
      }
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(active);
    return () => observer.disconnect();
  }, [page]);
  return <div ref={root} className={styles.menuPages} style={{ height }}>
    {(Object.keys(pages) as ConversationMenuPage[]).map((name) => <div key={name}
      className={`${styles.menuPage} ${name === page ? styles.menuPageActive : name === "main" ? styles.menuPageBefore : styles.menuPageAfter}`}
      data-menu-page={name} aria-hidden={name !== page} inert={name !== page}>
      {pages[name]}
    </div>)}
  </div>;
}
