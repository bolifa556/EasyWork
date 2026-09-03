import { invariant } from "../errors.mjs";

const clone = (value) => structuredClone(value);
const shellQuote = (value) => `'${String(value).replace(/'/g, `'"'"'`)}'`;

const MONITOR_SCRIPT = String.raw`
printf '%s\n' '__EW_CPU_A__'
head -n 1 /proc/stat
sleep 0.15
printf '%s\n' '__EW_CPU_B__'
head -n 1 /proc/stat
printf '%s\n' '__EW_CORES__'
getconf _NPROCESSORS_ONLN 2>/dev/null || printf '0\n'
printf '%s\n' '__EW_MEMORY__'
grep -E '^(MemTotal|MemAvailable):' /proc/meminfo 2>/dev/null || true
printf '%s\n' '__EW_GPU__'
if command -v nvidia-smi >/dev/null 2>&1; then
  nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits 2>/dev/null || true
fi
printf '%s\n' '__EW_PROCESSES__'
ps -eo pid=,user=,pcpu=,pmem=,stat=,comm= --sort=-pcpu 2>/dev/null | head -n 30
`;

function sections(output) {
  const result = new Map();
  let current = "";
  for (const line of String(output || "").replace(/\r/g, "").split("\n")) {
    const marker = line.match(/^__EW_([A-Z_]+)__$/);
    if (marker) {
      current = marker[1];
      result.set(current, []);
    } else if (current) result.get(current).push(line);
  }
  return result;
}

function cpuCounters(line) {
  const fields = String(line || "").trim().split(/\s+/);
  if (fields[0] !== "cpu") return null;
  const values = fields.slice(1).map(Number);
  if (!values.length || values.some((value) => !Number.isFinite(value))) return null;
  return { total: values.reduce((sum, value) => sum + value, 0), idle: (values[3] || 0) + (values[4] || 0) };
}

function percent(value) {
  return Math.max(0, Math.min(100, Math.round(Number(value || 0) * 10) / 10));
}

function parseSnapshot(output, sampledAt) {
  const parsed = sections(output);
  const before = cpuCounters(parsed.get("CPU_A")?.[0]);
  const after = cpuCounters(parsed.get("CPU_B")?.[0]);
  const totalDelta = after && before ? after.total - before.total : 0;
  const idleDelta = after && before ? after.idle - before.idle : 0;
  const memory = Object.fromEntries((parsed.get("MEMORY") || []).map((line) => {
    const match = line.match(/^(MemTotal|MemAvailable):\s+(\d+)\s+kB$/);
    return match ? [match[1], Number(match[2]) * 1024] : null;
  }).filter(Boolean));
  const totalBytes = Number(memory.MemTotal || 0);
  const availableBytes = Number(memory.MemAvailable || 0);
  const usedBytes = Math.max(0, totalBytes - availableBytes);
  const gpus = (parsed.get("GPU") || []).filter(Boolean).map((line) => {
    const fields = line.split(",").map((value) => value.trim());
    return {
      index: Number(fields[0]),
      name: fields[1] || `GPU ${fields[0] || ""}`.trim(),
      utilizationPercent: percent(fields[2]),
      memoryUsedBytes: Math.max(0, Number(fields[3]) || 0) * 1024 * 1024,
      memoryTotalBytes: Math.max(0, Number(fields[4]) || 0) * 1024 * 1024,
    };
  }).filter((gpu) => Number.isInteger(gpu.index));
  const processes = (parsed.get("PROCESSES") || []).filter(Boolean).map((line) => {
    const match = line.match(/^\s*(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\S+)\s+(.+)$/);
    if (!match) return null;
    return { pid: Number(match[1]), user: match[2], cpuPercent: percent(match[3]), memoryPercent: percent(match[4]), state: match[5], command: match[6] };
  }).filter(Boolean);
  return {
    kind: "standard",
    cpu: { usagePercent: totalDelta > 0 ? percent((1 - idleDelta / totalDelta) * 100) : 0, cores: Math.max(0, Number(parsed.get("CORES")?.[0]) || 0) },
    memory: { usedBytes, availableBytes, totalBytes, usagePercent: totalBytes ? percent((usedBytes / totalBytes) * 100) : 0 },
    gpus,
    processes,
    sampledAt,
  };
}

export class SshSystemMonitor {
  constructor({ executor, clock = () => new Date() }) {
    invariant(typeof executor?.exec === "function", "SYSTEM_MONITOR_EXECUTOR_INVALID", "系统监控 executor 无效", { status: 500, expose: false });
    this.executor = executor;
    this.clock = clock;
    this.cache = null;
    this.pending = null;
  }

  async snapshot({ refresh = false } = {}) {
    if (!refresh && this.cache) return clone(this.cache);
    if (this.pending) return clone(await this.pending);
    this.pending = this.#read().then((snapshot) => {
      this.cache = snapshot;
      return snapshot;
    }).finally(() => { this.pending = null; });
    return clone(await this.pending);
  }

  async #read() {
    const result = await this.executor.exec(`bash -lc ${shellQuote(MONITOR_SCRIPT)}`, { maxOutputBytes: 512 * 1024 });
    invariant(result.code === 0, "SYSTEM_MONITOR_COMMAND_FAILED", "无法读取服务器资源使用情况", {
      status: 502,
      retryable: true,
      details: { exitCode: result.code, stderr: String(result.stderr || "").slice(0, 2_000) },
    });
    const clockValue = this.clock();
    const sampledAt = (clockValue instanceof Date ? clockValue : new Date(clockValue)).toISOString();
    return parseSnapshot(result.stdout, sampledAt);
  }
}

export const systemMonitorInternals = Object.freeze({ parseSnapshot });
