// Return null at a horizontal boundary so the wheel can reach the surrounding
// document. This is shared by message blocks and file previews.
export function codeWheelPosition(viewport: { scrollLeft: number; scrollWidth: number; clientWidth: number }, event: { deltaX: number; deltaY: number; deltaMode: number; ctrlKey?: boolean }) {
  if (event.ctrlKey) return null;
  const max = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
  const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
  if (max <= 1 || !delta) return null;
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientWidth : 1;
  const next = Math.min(max, Math.max(0, viewport.scrollLeft + delta * unit));
  return next === viewport.scrollLeft ? null : next;
}
