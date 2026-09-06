type Rect = { left: number; right: number; top: number; bottom: number };

export function mobileMenuPosition(anchor: Rect, menu: { width: number; height: number }, viewport: { width: number; height: number; top: number; left: number }) {
  const margin = 8;
  const gap = 4;
  const topEdge = viewport.top + margin;
  const bottomEdge = viewport.top + viewport.height - margin;
  const below = Math.max(0, bottomEdge - anchor.bottom - gap);
  const above = Math.max(0, anchor.top - gap - topEdge);
  const down = menu.height <= below || below >= above;
  const maxHeight = Math.max(32, Math.min(viewport.height - margin * 2, down ? below : above));
  const height = Math.min(menu.height, maxHeight);
  return {
    left: Math.max(viewport.left + margin, Math.min(anchor.right - menu.width, viewport.left + viewport.width - menu.width - margin)),
    top: Math.max(topEdge, Math.min(down ? anchor.bottom + gap : anchor.top - gap - height, bottomEdge - height)),
    maxHeight,
  };
}
