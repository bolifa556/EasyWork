import { useLayoutEffect, type RefObject } from "react";
import { mobileMenuPosition } from "./menu-position";

export function useMobileMenuAnchor(anchor: HTMLElement | null | undefined, menuRef: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!anchor || !menu) return;
    const original = { left: menu.style.left, top: menu.style.top, maxHeight: menu.style.maxHeight };
    const update = () => {
      if (window.innerWidth > 719) { Object.assign(menu.style, original); return; }
      const viewport = window.visualViewport;
      const position = mobileMenuPosition(anchor.getBoundingClientRect(), { width: menu.offsetWidth, height: menu.scrollHeight }, {
        width: viewport?.width || window.innerWidth,
        height: viewport?.height || window.innerHeight,
        top: viewport?.offsetTop || 0,
        left: viewport?.offsetLeft || 0,
      });
      menu.style.left = `${position.left}px`;
      menu.style.top = `${position.top}px`;
      menu.style.maxHeight = `${position.maxHeight}px`;
    };
    update();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(menu);
    window.addEventListener("resize", update);
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("scroll", update);
    };
  }, [anchor, menuRef]);
}
