import assert from "node:assert/strict";
import test from "node:test";

import {
  loadRemoteRuntimeBundle,
  parseRuntimeFields,
  remoteRuntimePaths,
  safeRemoteRunId,
} from "../gateway/remote-runtime.mjs";

test("remote runtime bundle is deterministic and keeps all state under .easywork", async () => {
  const first = await loadRemoteRuntimeBundle();
  const second = await loadRemoteRuntimeBundle();
  assert.equal(first.digest, second.digest);
  assert.match(first.releaseId, /^0\.3\.0-[a-f0-9]{12}$/);
  assert.ok(first.manifest.requiredCommands.includes("mkfifo"));
  assert.ok(first.manifest.requiredCommands.includes("grep"));
  assert.equal(first.manifest.protocolVersion, 1);
  assert.deepEqual(
    first.files.map((file) => file.relativePath),
    ["manifest.json", "bin/easywork-runner"],
  );

  const paths = remoteRuntimePaths("/home/example/", first.releaseId);
  assert.equal(paths.root, "/home/example/.easywork");
  assert.equal(paths.runsRoot, "/home/example/.easywork/runs");
  assert.equal(
    paths.entrypoint,
    "/home/example/.easywork/runtime/current/bin/easywork-runner",
  );
  assert.ok(paths.releaseRoot.startsWith(paths.releasesRoot));
});

test("remote runtime protocol accepts only safe run ids and parses status fields", () => {
  assert.equal(safeRemoteRunId("run-123_test.4"), "run-123_test.4");
  for (const invalid of ["", "../run", "run/name", "run name", "x".repeat(121)]) {
    assert.throws(() => safeRemoteRunId(invalid), /任务 ID 无效/);
  }
  assert.deepEqual(
    parseRuntimeFields("status=running\npid=42\ndetail=a=b\n"),
    { status: "running", pid: "42", detail: "a=b" },
  );
});
