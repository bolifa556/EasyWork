type Snapshot = { id: string; revision: number; status: string; updatedAt: string };
const terminal = new Set(["completed", "failed", "cancelled", "interrupted"]);

export function mergeTaskSnapshots<T extends Snapshot>(...groups: readonly (readonly T[])[]): T[] {
  const latest = new Map<string, T>();
  for (const group of groups) for (const task of group) {
    const previous = latest.get(task.id);
    if (!previous || task.revision > previous.revision || (task.revision === previous.revision
      && ((!terminal.has(previous.status) && terminal.has(task.status))
        || (terminal.has(previous.status) === terminal.has(task.status) && task.updatedAt > previous.updatedAt)))) latest.set(task.id, task);
  }
  return [...latest.values()];
}

export function isActiveTask(task: Snapshot): boolean { return !terminal.has(task.status); }
