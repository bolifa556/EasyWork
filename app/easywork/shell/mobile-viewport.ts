// Android keyboards may resize only the visual viewport. Re-read it after
// returning to the tab as well as during keyboard open/close animations.
export function bindMobileViewport(win: Window) {
  const doc = win.document;
  const root = doc.documentElement;
  const viewport = win.visualViewport;
  let frame: number | null = null;
  let timers: number[] = [];
  const reset = () => {
    root.style.removeProperty("--ew-viewport-height");
    root.style.removeProperty("--ew-viewport-top");
  };
  const update = () => {
    frame = null;
    if (doc.visibilityState === "hidden") return;
    if (win.innerWidth > 719) { reset(); return; }
    const current = win.visualViewport;
    if (current && Math.abs(current.scale - 1) > .05) return;
    const height = `${Math.round(current?.height || win.innerHeight)}px`;
    const top = `${Math.max(0, Math.round(current?.offsetTop || 0))}px`;
    if (root.style.getPropertyValue("--ew-viewport-height") !== height) root.style.setProperty("--ew-viewport-height", height);
    if (root.style.getPropertyValue("--ew-viewport-top") !== top) root.style.setProperty("--ew-viewport-top", top);
  };
  const schedule = () => { if (frame === null) frame = win.requestAnimationFrame(update); };
  const resume = () => {
    schedule();
    timers.forEach((timer) => win.clearTimeout(timer));
    timers = [80, 250, 500].map((delay) => win.setTimeout(schedule, delay));
  };
  win.addEventListener("resize", schedule);
  win.addEventListener("pageshow", resume);
  win.addEventListener("focus", resume);
  viewport?.addEventListener("resize", schedule);
  viewport?.addEventListener("scroll", schedule);
  doc.addEventListener("visibilitychange", resume);
  doc.addEventListener("focusin", resume);
  doc.addEventListener("focusout", resume);
  update();
  return () => {
    if (frame !== null) win.cancelAnimationFrame(frame);
    timers.forEach((timer) => win.clearTimeout(timer));
    win.removeEventListener("resize", schedule);
    win.removeEventListener("pageshow", resume);
    win.removeEventListener("focus", resume);
    viewport?.removeEventListener("resize", schedule);
    viewport?.removeEventListener("scroll", schedule);
    doc.removeEventListener("visibilitychange", resume);
    doc.removeEventListener("focusin", resume);
    doc.removeEventListener("focusout", resume);
    reset();
  };
}
