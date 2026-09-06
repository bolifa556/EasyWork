export type MobileSwipePoint = {
  pointerId: number;
  clientX: number;
  clientY: number;
  isPrimary: boolean;
  target: EventTarget | null;
  preventDefault: () => void;
};

type SwipeHandlers = {
  start: (point: MobileSwipePoint) => boolean;
  claimEdge?: (point: MobileSwipePoint) => boolean;
  blockVertical?: (point: MobileSwipePoint) => boolean;
  move: (point: MobileSwipePoint) => void;
  end: (point: MobileSwipePoint, cancelled: boolean) => void;
};

// React's delegated touch listeners are passive. Native non-passive listeners
// must claim horizontal drags before a browser turns them into navigation.
export function bindMobileTouchSwipe(surface: HTMLElement, handlers: SwipeHandlers) {
  let active: { id: number; x: number; y: number; last: MobileSwipePoint; accepted: boolean; blockVertical: boolean; axis: "pending" | "horizontal" | "vertical" } | null = null;
  const pointFor = (event: TouchEvent, touch: Touch): MobileSwipePoint => ({
    pointerId: touch.identifier,
    clientX: touch.clientX,
    clientY: touch.clientY,
    isPrimary: true,
    target: event.target,
    preventDefault: () => { if (event.cancelable) event.preventDefault(); },
  });
  const cancel = () => {
    if (!active) return;
    const { last: point, accepted } = active;
    active = null;
    if (accepted) handlers.end(point, true);
  };
  const start = (event: TouchEvent) => {
    const width = surface.ownerDocument.defaultView?.innerWidth ?? 0;
    if (width > 719 || event.touches.length !== 1) { cancel(); return; }
    const touch = event.touches[0];
    const point = pointFor(event, touch);
    const accepted = handlers.start(point);
    const blockVertical = handlers.blockVertical?.(point) ?? false;
    if (!accepted && !blockVertical) return;
    active = { id: touch.identifier, x: touch.clientX, y: touch.clientY, last: point, axis: "pending", accepted, blockVertical };
    // WebKit and some Android browsers reserve edge swipes at touchstart.
    // Only claim an edge when the application accepted this gesture.
    if (accepted && (point.clientX <= 24 || point.clientX >= width - 24) && handlers.claimEdge?.(point) !== false) point.preventDefault();
  };
  const move = (event: TouchEvent) => {
    if (!active) return;
    if (event.touches.length !== 1) { cancel(); return; }
    const touch = Array.from(event.touches).find((item) => item.identifier === active!.id);
    if (!touch) { cancel(); return; }
    const point = pointFor(event, touch);
    active.last = point;
    const dx = Math.abs(point.clientX - active.x);
    const dy = Math.abs(point.clientY - active.y);
    if (active.axis === "pending" && Math.max(dx, dy) >= 4) {
      active.axis = dy > dx * 0.9 ? "vertical" : "horizontal";
      if (active.axis === "vertical") {
        if (!active.blockVertical) { cancel(); return; }
        if (active.accepted) handlers.end(point, true);
        active.accepted = false;
      }
    }
    if (active.axis === "vertical") { point.preventDefault(); return; }
    if (active.axis === "horizontal" && active.accepted) point.preventDefault();
    if (active.accepted) handlers.move(point);
  };
  const end = (event: TouchEvent) => {
    if (!active) return;
    const touch = Array.from(event.changedTouches).find((item) => item.identifier === active!.id);
    if (!touch) return;
    const point = pointFor(event, touch);
    if ((active.axis === "horizontal" && active.accepted) || (active.axis === "vertical" && active.blockVertical)) point.preventDefault();
    const accepted = active.accepted;
    active = null;
    if (accepted) handlers.end(point, event.type === "touchcancel");
  };
  const options = { passive: false };
  surface.addEventListener("touchstart", start, options);
  surface.addEventListener("touchmove", move, options);
  surface.addEventListener("touchend", end, options);
  surface.addEventListener("touchcancel", end, options);
  return () => {
    surface.removeEventListener("touchstart", start);
    surface.removeEventListener("touchmove", move);
    surface.removeEventListener("touchend", end);
    surface.removeEventListener("touchcancel", end);
    active = null;
  };
}
