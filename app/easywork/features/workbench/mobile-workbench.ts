export function mobileWorkbenchBounds(available: number) {
  const max = Math.max(100, available - 132);
  return { min: Math.min(160, max), max };
}

export function bindMobileWorkbench(drawer: HTMLElement, header: HTMLElement, onClose: () => void) {
  const win = drawer.ownerDocument.defaultView!;
  let frame: number | null = null;
  let closeTimer: number | null = null;
  let suppressClick = false;
  let gesture: { id: number; x: number; y: number; height: number; latest: number; max: number; header: boolean; dragging: boolean } | null = null;
  const paint = (height: number) => drawer.style.setProperty("--mobile-workbench-height", `${height}px`);
  const available = () => drawer.parentElement?.clientHeight || win.innerHeight;
  if (win.innerWidth <= 719) {
    const { min, max } = mobileWorkbenchBounds(available());
    let saved = 0;
    try { saved = Number(win.localStorage.getItem("easywork.mobile-workbench-height")); } catch { /* Private browser storage may be unavailable. */ }
    paint(Math.max(min, Math.min(max, saved || available() * .46)));
  }
  const canPullDown = (target: Element) => {
    for (let node: Element | null = target; node && node !== drawer; node = node.parentElement) {
      if (node.scrollTop > 0) return false;
    }
    return true;
  };
  const start = (id: number, x: number, y: number, target: EventTarget | null) => {
    if (win.innerWidth > 719 || closeTimer !== null || !(target instanceof Element)) return;
    suppressClick = false;
    if (target.closest("input,textarea,select,[contenteditable='true'],[role='menu']")) return;
    const onHeader = header.contains(target);
    if (!onHeader && !canPullDown(target)) return;
    const height = drawer.getBoundingClientRect().height;
    gesture = { id, x, y, height, latest: height, max: mobileWorkbenchBounds(available()).max, header: onHeader, dragging: false };
  };
  const move = (id: number, x: number, y: number, preventDefault: () => void) => {
    const current = gesture;
    if (!current || current.id !== id) return;
    const dx = Math.abs(x - current.x);
    const dy = y - current.y;
    if (!current.dragging) {
      if (Math.max(dx, Math.abs(dy)) < 6) return;
      if (dx > Math.abs(dy) || (!current.header && dy < 0)) { gesture = null; return; }
      current.dragging = true;
      drawer.setAttribute("data-mobile-resizing", "");
      drawer.style.transition = "none";
    }
    preventDefault();
    current.latest = Math.max(0, Math.min(current.max, current.height - dy));
    if (frame === null) frame = win.requestAnimationFrame(() => { frame = null; paint(current.latest); });
  };
  const finish = (id: number, cancelled = false) => {
    const current = gesture;
    if (!current || current.id !== id) return;
    gesture = null;
    if (!current.dragging) return;
    suppressClick = true;
    if (frame !== null) win.cancelAnimationFrame(frame);
    frame = null;
    drawer.removeAttribute("data-mobile-resizing");
    const close = !cancelled && (current.header ? current.latest < 96 : current.height - current.latest > Math.min(90, current.height * .28));
    drawer.style.transition = win.matchMedia("(prefers-reduced-motion: reduce)").matches ? "none" : "height 180ms cubic-bezier(.22,1,.36,1)";
    if (close) {
      paint(0);
      closeTimer = win.setTimeout(onClose, 180);
      return;
    }
    const next = cancelled || !current.header ? current.height : Math.max(mobileWorkbenchBounds(available()).min, current.latest);
    paint(next);
    try { win.localStorage.setItem("easywork.mobile-workbench-height", String(Math.round(next))); } catch { /* Keep resizing functional without storage. */ }
  };
  const pointerDown = (event: PointerEvent) => { if (event.pointerType !== "touch" && event.isPrimary && header.contains(event.target as Node)) start(event.pointerId, event.clientX, event.clientY, event.target); };
  const pointerMove = (event: PointerEvent) => { if (event.pointerType !== "touch") move(event.pointerId, event.clientX, event.clientY, () => event.preventDefault()); };
  const pointerUp = (event: PointerEvent) => { if (event.pointerType !== "touch") finish(event.pointerId, event.type === "pointercancel"); };
  const touchStart = (event: TouchEvent) => {
    if (event.touches.length !== 1) { if (gesture) finish(gesture.id, true); return; }
    const touch = event.touches[0];
    start(touch.identifier, touch.clientX, touch.clientY, event.target);
  };
  const touchMove = (event: TouchEvent) => {
    if (event.touches.length !== 1) { if (gesture) finish(gesture.id, true); return; }
    const touch = event.touches[0];
    move(touch.identifier, touch.clientX, touch.clientY, () => { if (event.cancelable) event.preventDefault(); });
  };
  const touchEnd = (event: TouchEvent) => {
    if (!gesture || !Array.from(event.changedTouches).some((touch) => touch.identifier === gesture!.id)) return;
    if (gesture.dragging && event.cancelable) event.preventDefault();
    finish(gesture.id, event.type === "touchcancel");
  };
  const click = (event: MouseEvent) => { if (suppressClick) { suppressClick = false; event.preventDefault(); event.stopPropagation(); } };
  const outside = (event: MouseEvent) => {
    if (win.innerWidth <= 719 && event.target instanceof Element && !drawer.contains(event.target) && !event.target.closest("[data-workbench-trigger]")) onClose();
  };
  drawer.addEventListener("pointerdown", pointerDown);
  win.addEventListener("pointermove", pointerMove);
  win.addEventListener("pointerup", pointerUp);
  win.addEventListener("pointercancel", pointerUp);
  drawer.addEventListener("touchstart", touchStart, { passive: true });
  drawer.addEventListener("touchmove", touchMove, { passive: false });
  drawer.addEventListener("touchend", touchEnd, { passive: false });
  drawer.addEventListener("touchcancel", touchEnd, { passive: false });
  drawer.addEventListener("click", click, true);
  drawer.ownerDocument.addEventListener("click", outside);
  return () => {
    if (frame !== null) win.cancelAnimationFrame(frame);
    if (closeTimer !== null) win.clearTimeout(closeTimer);
    drawer.removeEventListener("pointerdown", pointerDown);
    win.removeEventListener("pointermove", pointerMove);
    win.removeEventListener("pointerup", pointerUp);
    win.removeEventListener("pointercancel", pointerUp);
    drawer.removeEventListener("touchstart", touchStart);
    drawer.removeEventListener("touchmove", touchMove);
    drawer.removeEventListener("touchend", touchEnd);
    drawer.removeEventListener("touchcancel", touchEnd);
    drawer.removeEventListener("click", click, true);
    drawer.ownerDocument.removeEventListener("click", outside);
  };
}
