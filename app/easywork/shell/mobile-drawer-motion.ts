export type DrawerSide = "left" | "right";
export const drawerDuration = 220;
export const drawerEasing = "cubic-bezier(.22,1,.36,1)";

export function drawerProgress(side: DrawerSide, wasOpen: boolean, dx: number, width: number, initialProgress = Number(wasOpen)) {
  return Math.max(0, Math.min(1, initialProgress + dx * (side === "left" ? 1 : -1) / Math.max(1, width)));
}

export function drawerShouldOpen(progress: number) {
  return progress > 0.5;
}
