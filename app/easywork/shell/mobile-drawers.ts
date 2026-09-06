import { bindMobileTouchSwipe, type MobileSwipePoint } from "../features/conversation/mobile-touch-swipe";
import { drawerDuration as duration, drawerEasing as easing, drawerProgress, drawerShouldOpen, type DrawerSide } from "./mobile-drawer-motion";

export type { DrawerSide } from "./mobile-drawer-motion";
type DrawerState = { left: boolean; right: boolean; allowRight: boolean; disabled: boolean };

// Both drawers remain mounted on phones. Only their transform changes while
// dragging; application state is committed once the shared settling motion ends.
export function bindMobileDrawers(surface: HTMLElement, options: {
  getState: () => DrawerState;
  setOpen: (side: DrawerSide, open: boolean) => void;
}) {
  const win = surface.ownerDocument.defaultView!;
  let timer: number | null = null;
  let frame: number | null = null;
  let animation: Animation | null = null;
  let activePanel: HTMLElement | null = null;
  let settling = false;
  let settlingTarget: { side: DrawerSide; open: boolean; width: number } | null = null;
  let suppressClickUntil = 0;
  const panels = new Map<DrawerSide, { element: HTMLElement; width: number }>();
  const preparePanels = () => {
    const measured = new Map<HTMLElement, number>();
    for (const side of ["left", "right"] as const) {
      const element = surface.querySelector<HTMLElement>(`[data-mobile-drawer-panel="${side}"]`);
      if (!element) { panels.delete(side); continue; }
      const mobile = win.innerWidth <= 719;
      element.inert = mobile && !options.getState()[side];
      if (element.inert) element.setAttribute("aria-hidden", "true");
      else element.removeAttribute("aria-hidden");
      if (!mobile) continue;
      const cached = panels.get(side);
      const width = cached?.element === element ? cached.width : measured.get(element) ?? (element.getBoundingClientRect().width || win.innerWidth - 40);
      measured.set(element, width);
      panels.set(side, { element, width });
    }
  };
  // Keep the off-screen layers ready before a finger starts moving. Drawer
  // dimensions are stable between viewport changes; no layout read on move.
  preparePanels();
  let gesture: { id: number; x: number; y: number; side: DrawerSide | null; wasOpen: boolean; width: number; progress: number; initialProgress: number; paintedProgress: number; tracking: boolean; interrupted: boolean } | null = null;
  surface.style.setProperty("--mobile-drawer-duration", `${duration}ms`);
  surface.style.setProperty("--mobile-drawer-easing", easing);
  const clear = () => {
    if (timer !== null) win.clearTimeout(timer);
    if (frame !== null) win.cancelAnimationFrame(frame);
    if (animation) { animation.onfinish = null; animation.cancel(); }
    timer = null;
    frame = null;
    animation = null;
    settling = false;
    settlingTarget = null;
    gesture = null;
    surface.removeAttribute("data-mobile-drawer-side");
    if (activePanel) {
      activePanel.removeAttribute("data-mobile-drawer-active");
      activePanel.removeAttribute("data-mobile-drawer-tracking");
      activePanel.style.removeProperty("transform");
      activePanel.style.removeProperty("transition");
      activePanel = null;
    }
  };
  const transform = (side: DrawerSide, progress: number, width: number) => `translate3d(${(side === "left" ? progress - 1 : 1 - progress) * width}px,0,0)`;
  const settle = (side: DrawerSide, open: boolean, width: number, from: number) => {
    const panel = activePanel!;
    settling = true;
    settlingTarget = { side, open, width };
    panel.removeAttribute("data-mobile-drawer-tracking");
    const remaining = Math.abs(Number(open) - from);
    const settleDuration = win.matchMedia("(prefers-reduced-motion: reduce)").matches || remaining === 0 ? 0 : Math.max(80, Math.round(duration * remaining));
    const finish = () => {
      if (!settling) return;
      settling = false;
      settlingTarget = null;
      if (timer !== null) win.clearTimeout(timer);
      timer = null;
      const changed = options.getState()[side] !== open;
      options.setOpen(side, open);
      // A changed state clears in the shell's layout effect, after the open
      // class has committed. A short drag has no React state change to await.
      if (!changed) clear();
    };
    const target = transform(side, Number(open), width);
    // Explicit keyframes join the last painted frame to the resting position
    // without a synchronous layout flush when the finger lifts.
    if (settleDuration && typeof panel.animate === "function") {
      animation = panel.animate([{ transform: transform(side, from, width) }, { transform: target }], { duration: settleDuration, easing });
      animation.onfinish = finish;
    } else if (settleDuration) {
      panel.style.transition = `transform ${settleDuration}ms ${easing}`;
    }
    panel.style.transform = target;
    timer = win.setTimeout(finish, settleDuration ? settleDuration + 34 : 0);
  };
  const start = (point: MobileSwipePoint) => {
    if (win.innerWidth > 719 || !point.isPrimary) return false;
    // A new press is intentional; suppress only the completed swipe's click.
    suppressClickUntil = 0;
    const state = options.getState();
    const target = point.target instanceof Element ? point.target : null;
    if (!target || !surface.contains(target)) return false;
    const interruptedTarget = settlingTarget;
    const side = interruptedTarget?.side ?? (state.left ? "left" : state.right ? "right" : null);
    if (!side && state.disabled) return false;
    if (target.closest("input,textarea,select,[contenteditable='true'],pre,table,[data-mobile-swipe-ignore]")) return false;
    if (!side && target.closest("button,a,[role='button'],[role='tab']")) return false;
    // A conversation can finish loading after the shell effect. Discover any
    // newly mounted panel at touch-down, still before the first move frame.
    preparePanels();
    let progress = Number(Boolean(side));
    if (interruptedTarget && activePanel) {
      // Read once at touch-down to take over the compositor's current position.
      // Subsequent movement and release need no layout reads.
      const rect = activePanel.getBoundingClientRect();
      progress = Math.max(0, Math.min(1, (side === "left" ? rect.right : win.innerWidth - rect.left) / interruptedTarget.width));
      if (timer !== null) win.clearTimeout(timer);
      if (animation) { animation.onfinish = null; animation.cancel(); }
      timer = null;
      animation = null;
      settling = false;
      settlingTarget = null;
      activePanel.style.transition = "none";
      activePanel.style.transform = transform(side!, progress, interruptedTarget.width);
    }
    gesture = { id: point.pointerId, x: point.clientX, y: point.clientY, side, wasOpen: interruptedTarget?.open ?? Boolean(side), width: interruptedTarget?.width ?? 0, progress, initialProgress: progress, paintedProgress: progress, tracking: false, interrupted: Boolean(interruptedTarget) };
    return true;
  };
  const move = (point: MobileSwipePoint) => {
    const current = gesture;
    if (!current || current.id !== point.pointerId) return;
    const dx = point.clientX - current.x;
    const dy = point.clientY - current.y;
    if (!current.tracking) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 4) return;
      if (Math.abs(dy) > Math.abs(dx) * 0.9) { end(point, true); return; }
      if (!current.side) {
        if (dx < 0 && !options.getState().allowRight) { gesture = null; return; }
        current.side = dx > 0 ? "left" : "right";
      }
      const prepared = panels.get(current.side);
      activePanel = prepared?.element ?? null;
      if (!activePanel) { gesture = null; return; }
      current.width ||= prepared!.width;
      current.tracking = true;
      surface.setAttribute("data-mobile-drawer-side", current.side);
      activePanel.style.transition = "none";
      activePanel.setAttribute("data-mobile-drawer-active", "");
      activePanel.setAttribute("data-mobile-drawer-tracking", "");
    }
    point.preventDefault();
    current.progress = drawerProgress(current.side!, current.wasOpen, dx, current.width, current.initialProgress);
    // Touch events can arrive faster than the display refreshes. Paint only
    // their latest position, directly on the drawer instead of inherited vars.
    if (frame === null) frame = win.requestAnimationFrame(() => {
      frame = null;
      if (!activePanel) return;
      current.paintedProgress = current.progress;
      activePanel.style.transform = transform(current.side!, current.progress, current.width);
    });
  };
  const end = (point: MobileSwipePoint, cancelled = false) => {
    const current = gesture;
    if (!current || current.id !== point.pointerId) return;
    gesture = null;
    if (!current.side) return;
    if (!current.tracking) {
      if (current.interrupted) settle(current.side, current.wasOpen, current.width, current.paintedProgress);
      return;
    }
    if (frame !== null) { win.cancelAnimationFrame(frame); frame = null; }
    suppressClickUntil = Date.now() + 250;
    point.preventDefault();
    settle(current.side, cancelled ? current.wasOpen : drawerShouldOpen(current.progress), current.width, current.paintedProgress);
  };
  const unbindTouch = bindMobileTouchSwipe(surface, {
    start, move, end,
    // Drawer rows also accept closing swipes; their normal edge taps must
    // still produce native button/link clicks.
    claimEdge: (point) => !(point.target instanceof Element && point.target.closest("button,a,[role='button'],[role='tab']")),
    blockVertical: (point) => point.target instanceof Element && Boolean(point.target.closest("[data-mobile-fixed-gesture]")),
  });
  const pointerStart = (event: PointerEvent) => { if (event.pointerType !== "touch") start(event); };
  const pointerMove = (event: PointerEvent) => { if (event.pointerType !== "touch") move(event); };
  const pointerEnd = (event: PointerEvent) => { if (event.pointerType !== "touch") end(event, event.type === "pointercancel"); };
  const click = (event: MouseEvent) => { if (Date.now() < suppressClickUntil) { event.preventDefault(); event.stopPropagation(); } };
  surface.addEventListener("pointerdown", pointerStart);
  surface.addEventListener("pointermove", pointerMove);
  surface.addEventListener("pointerup", pointerEnd);
  surface.addEventListener("pointercancel", pointerEnd);
  surface.addEventListener("click", click, true);
  const sync = () => { clear(); preparePanels(); };
  const resize = () => { panels.clear(); sync(); };
  win.addEventListener("resize", resize);
  return {
    sync,
    dispose: () => {
      clear(); unbindTouch();
      surface.removeEventListener("pointerdown", pointerStart);
      surface.removeEventListener("pointermove", pointerMove);
      surface.removeEventListener("pointerup", pointerEnd);
      surface.removeEventListener("pointercancel", pointerEnd);
      surface.removeEventListener("click", click, true);
      win.removeEventListener("resize", resize);
      surface.style.removeProperty("--mobile-drawer-duration");
      surface.style.removeProperty("--mobile-drawer-easing");
    },
  };
}
