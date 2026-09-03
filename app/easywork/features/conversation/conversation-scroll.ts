export const CONVERSATION_BOTTOM_THRESHOLD = 80;

export type ConversationScrollPosition = { top: number; following: boolean };
type ScrollMetrics = Pick<HTMLElement, "scrollHeight" | "clientHeight" | "scrollTop">;

export function isNearConversationBottom(viewport: ScrollMetrics) {
  return viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= CONVERSATION_BOTTOM_THRESHOLD;
}

// Observe rendered content, not just message counts: streaming, expanded
// details, images and a resized composer/workbench all change the scroll range.
export function followConversationScroll(
  viewport: HTMLElement,
  content: HTMLElement,
  saved: ConversationScrollPosition | undefined,
  remember: (position: ConversationScrollPosition) => void,
) {
  viewport.scrollTo({ top: !saved || saved.following ? viewport.scrollHeight : saved.top, behavior: "instant" });
  let following = saved?.following ?? isNearConversationBottom(viewport);
  let frame: number | null = null;
  let contentHeight = viewport.scrollHeight;
  let viewportHeight = viewport.clientHeight;
  let lastScrollTop = viewport.scrollTop;
  const measure = () => {
    contentHeight = viewport.scrollHeight;
    viewportHeight = viewport.clientHeight;
  };
  const save = () => remember({ top: viewport.scrollTop, following });
  const cancelFrame = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
  };
  const follow = () => {
    if (!following || frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      if (following) viewport.scrollTo({ top: viewport.scrollHeight, behavior: "instant" });
      lastScrollTop = viewport.scrollTop;
      measure();
      save();
    });
  };
  const scrolled = () => {
    const layoutChanged = contentHeight !== viewport.scrollHeight || viewportHeight !== viewport.clientHeight;
    // Don't mistake a layout change for the user scrolling away before the
    // pending bottom-follow frame has had a chance to run.
    if (viewport.scrollTop < lastScrollTop && !isNearConversationBottom(viewport)) {
      // Scrollbar drags and touch scrolling must also beat a pending frame,
      // even when they didn't produce a wheel or keyboard event.
      cancelFrame();
      following = false;
    } else if (frame === null && (!layoutChanged || !following)) following = isNearConversationBottom(viewport);
    if (layoutChanged) follow();
    lastScrollTop = viewport.scrollTop;
    measure();
    save();
  };
  const pause = () => {
    cancelFrame();
    following = false;
    measure();
  };
  const wheeled = (event: WheelEvent) => {
    if (!event.defaultPrevented && event.deltaY < 0) pause();
  };
  const keyed = (event: KeyboardEvent) => {
    if (!event.defaultPrevented && ["ArrowUp", "PageUp", "Home"].includes(event.key)) pause();
  };
  const observer = new ResizeObserver(() => {
    follow();
    measure();
    save();
  });
  observer.observe(content);
  observer.observe(viewport);
  viewport.addEventListener("scroll", scrolled, { passive: true });
  viewport.addEventListener("wheel", wheeled, { passive: true });
  viewport.addEventListener("keydown", keyed);
  save();
  return () => {
    save();
    cancelFrame();
    observer.disconnect();
    viewport.removeEventListener("scroll", scrolled);
    viewport.removeEventListener("wheel", wheeled);
    viewport.removeEventListener("keydown", keyed);
  };
}
