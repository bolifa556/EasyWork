import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

const ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const SOURCE_ROOT = path.join(ROOT, "remote-runtime");

export function parseRuntimeFields(value) {
  return Object.fromEntries(
    String(value || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf("=");
        return separator < 0
          ? [line, ""]
          : [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

export function safeRemoteRunId(value) {
  const runId = String(value || "");
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(runId)) {
    throw new Error("远端任务 ID 无效");
  }
  return runId;
}

export async function loadRemoteRuntimeBundle() {
  const manifestBytes = await readFile(path.join(SOURCE_ROOT, "manifest.json"));
  const runnerBytes = await readFile(
    path.join(SOURCE_ROOT, "bin", "easywork-runner"),
  );
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const digest = crypto
    .createHash("sha256")
    .update(manifestBytes)
    .update(runnerBytes)
    .digest("hex");
  const releaseId = `${manifest.runtimeVersion}-${digest.slice(0, 12)}`;
  return {
    digest,
    releaseId,
    manifest: {
      ...manifest,
      digest,
      releaseId,
    },
    files: [
      {
        relativePath: "manifest.json",
        content: Buffer.from(
          `${JSON.stringify({ ...manifest, digest, releaseId }, null, 2)}\n`,
        ),
        mode: 0o600,
      },
      {
        relativePath: "bin/easywork-runner",
        content: runnerBytes,
        mode: 0o700,
      },
    ],
  };
}

export function remoteRuntimePaths(home, releaseId = "") {
  const root = `${String(home).replace(/\/$/, "")}/.easywork`;
  const runtimeRoot = `${root}/runtime`;
  const releaseRoot = releaseId
    ? `${runtimeRoot}/releases/${releaseId}`
    : "";
  return {
    root,
    runsRoot: `${root}/runs`,
    runtimeRoot,
    releasesRoot: `${runtimeRoot}/releases`,
    releaseRoot,
    current: `${runtimeRoot}/current`,
    entrypoint: `${runtimeRoot}/current/bin/easywork-runner`,
  };
}
