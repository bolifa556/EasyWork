// Keep the thumb proportional even when a line only slightly overflows. Capping
// its width makes a long drag move just a few pixels of content.
export function codeScrollThumbWidth(clientWidth: number, scrollWidth: number, trackWidth: number) {
  if (scrollWidth <= clientWidth || scrollWidth <= 0) return trackWidth;
  return Math.min(trackWidth, Math.max(32, trackWidth * clientWidth / scrollWidth));
}

// Vertical wheels scroll normally over the text. Over the scrollbar row they
// move horizontally, as do horizontal gestures and Shift+wheel anywhere.
export function codeWheelPosition(viewport: { scrollLeft: number; scrollWidth: number; clientWidth: number }, event: { deltaX: number; deltaY: number; deltaMode: number; ctrlKey?: boolean; shiftKey?: boolean }, overScrollbar = false) {
  if (event.ctrlKey) return null;
  const max = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
  const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.shiftKey || overScrollbar ? event.deltaY : 0;
  if (max <= 1 || !delta) return null;
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientWidth : 1;
  const next = Math.min(max, Math.max(0, viewport.scrollLeft + delta * unit));
  // At a track edge, consume the gesture so it cannot suddenly scroll the page.
  return next === viewport.scrollLeft && !overScrollbar ? null : next;
}
