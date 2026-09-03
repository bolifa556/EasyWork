import assert from "node:assert/strict";
import test from "node:test";

import { SshSystemMonitor, systemMonitorInternals } from "../gateway/core/runtime/system-monitor.mjs";

const SNAPSHOT = [
  "__EW_CPU_A__",
  "cpu 100 0 100 800 0 0 0 0 0 0",
  "__EW_CPU_B__",
  "cpu 150 0 150 900 0 0 0 0 0 0",
  "__EW_CORES__",
  "16",
  "__EW_MEMORY__",
  "MemTotal:       16384000 kB",
  "MemAvailable:    6553600 kB",
  "__EW_GPU__",
  "0, NVIDIA RTX 5090, 72, 8192, 32768",
  "__EW_PROCESSES__",
  " 1234 alice 81.5 12.2 R python",
  "  987 root 2.0 0.4 S sshd",
].join("\n");

test("system monitor parses CPU, memory, GPU and top-like process data", () => {
  const snapshot = systemMonitorInternals.parseSnapshot(SNAPSHOT, "2026-08-26T08:00:00.000Z");
  assert.equal(snapshot.kind, "standard");
  assert.deepEqual(snapshot.cpu, { usagePercent: 50, cores: 16 });
  assert.deepEqual(snapshot.memory, {
    usedBytes: 10_066_329_600,
    availableBytes: 6_710_886_400,
    totalBytes: 16_777_216_000,
    usagePercent: 60,
  });
  assert.deepEqual(snapshot.gpus, [{
    index: 0,
    name: "NVIDIA RTX 5090",
    utilizationPercent: 72,
    memoryUsedBytes: 8_589_934_592,
    memoryTotalBytes: 34_359_738_368,
  }]);
  assert.deepEqual(snapshot.processes[0], {
    pid: 1234,
    user: "alice",
    cpuPercent: 81.5,
    memoryPercent: 12.2,
    state: "R",
    command: "python",
  });
});

test("system monitor reuses a server snapshot and coalesces concurrent refreshes", async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const monitor = new SshSystemMonitor({
    executor: {
      async exec(command) {
        calls += 1;
        assert.match(command, /^bash -lc /);
        await gate;
        return { code: 0, stdout: SNAPSHOT, stderr: "" };
      },
    },
    clock: () => new Date("2026-08-26T08:00:00.000Z"),
  });
  const first = monitor.snapshot({ refresh: true });
  const second = monitor.snapshot({ refresh: true });
  release();
  assert.deepEqual(await first, await second);
  assert.equal(calls, 1);
  await monitor.snapshot();
  assert.equal(calls, 1);
});
