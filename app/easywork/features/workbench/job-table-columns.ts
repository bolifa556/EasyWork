export const JOB_COLUMNS = [
  { label: "作业名称 / ID", width: 190, min: 120, grow: 1.4 },
  { label: "应用", width: 90, min: 64, grow: 0.6 },
  { label: "队列 / 资源", width: 200, min: 110, grow: 1.1 },
  { label: "运行时长", width: 166, min: 100, grow: 0.85 },
  { label: "开始时间", width: 172, min: 126, grow: 0 },
  { label: "结束时间", width: 172, min: 126, grow: 0 },
  { label: "作业状态", width: 110, min: 88, grow: 0.65 },
] as const;

export const JOB_COLUMN_WIDTHS_KEY = "easywork.scheduler-column-widths:v1";
export const MAX_JOB_COLUMN_WIDTH = 2400;
export const DEFAULT_JOB_COLUMNS = JOB_COLUMNS.map((column) => column.grow
  ? `minmax(${column.width}px, ${column.grow}fr)`
  : `${column.width}px`).join(" ");
export const DEFAULT_JOB_TABLE_WIDTH = JOB_COLUMNS.reduce((sum, column) => sum + column.width, 0);

export function normalizeJobColumnWidths(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length !== JOB_COLUMNS.length
    || value.some((width) => typeof width !== "number" || !Number.isFinite(width))) return null;
  return value.map((width, index) => Math.max(JOB_COLUMNS[index].min, Math.min(MAX_JOB_COLUMN_WIDTH, Math.round(width))));
}

export function resizeJobColumn(widths: readonly number[], index: number, delta: number): number[] {
  if (!JOB_COLUMNS[index] || !Number.isFinite(delta)) return [...widths];
  return widths.map((width, column) => column === index
    ? Math.max(JOB_COLUMNS[column].min, Math.min(MAX_JOB_COLUMN_WIDTH, Math.round(width + delta)))
    : width);
}
