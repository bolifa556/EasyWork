import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  VERSION_PRETOOL_LAUNCHER,
  VERSION_PRETOOL_PYTHON,
  versionHookCheckCommand,
  versionHookCommand,
  versionHookPaths,
} from "../gateway/core/agent-runtime/version-pretool.mjs";

test("version hook launcher selects a verified Python 3 runtime and both hook commands use it", () => {
  const paths = { runtimeState: "/work/home/alice/.easywork/runtime/agents/codex/state" };
  assert.deepEqual(versionHookPaths(paths), {
    root: "/work/home/alice/.easywork/runtime/agents/codex/state/version-hooks",
    launcher: "/work/home/alice/.easywork/runtime/agents/codex/state/easywork-version-pretool.sh",
    script: "/work/home/alice/.easywork/runtime/agents/codex/state/easywork-version-pretool.py",
    activeTask: "/work/home/alice/.easywork/runtime/agents/codex/state/version-hooks/active-task",
    sessionTasks: "/work/home/alice/.easywork/runtime/agents/codex/state/version-hooks/session-tasks",
  });
  assert.match(versionHookCommand(paths), /^EASYWORK_VERSION_HOOK_REVISION='2026-09-01\.2' sh '.+easywork-version-pretool\.sh' '.+easywork-version-pretool\.py' '.+version-hooks'$/);
  assert.match(versionHookCheckCommand(paths), /^sh '.+easywork-version-pretool\.sh' --check '.+easywork-version-pretool\.py' '.+version-hooks'$/);
  assert.match(VERSION_PRETOOL_LAUNCHER, /EASYWORK_PYTHON3/);
  assert.match(VERSION_PRETOOL_LAUNCHER, /\/public\/software\/apps\/anaconda3\/\*\/bin\/python3/);
  assert.match(VERSION_PRETOOL_LAUNCHER, /sys\.version_info\[0\] == 3/);
  assert.match(VERSION_PRETOOL_LAUNCHER, /exec "\$resolved" "\$script" "\$hook_root"/);
});

test("version pre-tool hook uses the Gateway-carried OpenCode task id without an active pointer", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "easywork-version-hook-explicit-task-"));
  try {
    const root = path.join(temporary, "hooks");
    const script = path.join(temporary, "hook.py");
    const workspace = path.join(temporary, "workspace");
    await fs.mkdir(root, { recursive: true });
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(script, VERSION_PRETOOL_PYTHON, "utf8");
    const result = await runHook(script, root, {
      hook_event_name: "PreToolUse",
      easywork_task_id: "task_opencode_current",
      cwd: workspace,
      tool_name: "edit",
      tool_input: { paths: ["tests/test_current.py"] },
      tool_use_id: "call_current_write",
    });
    assert.equal(result.code, 0, result.stderr);
    const operations = await fs.readdir(path.join(root, "task_opencode_current"));
    assert.equal(operations.length, 1);
    const manifest = JSON.parse(await fs.readFile(path.join(root, "task_opencode_current", operations[0], "manifest.json"), "utf8"));
    const expected = path.join(await fs.realpath(workspace), "tests", "test_current.py");
    assert.deepEqual(manifest.entries, [{ exists: false, path: expected, payload: null, type: null }]);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

function runHook(script, root, payload, options = {}) {
  return new Promise((resolve, reject) => {
    const python = process.platform === "win32" ? "python" : "python3";
    const child = spawn(python, [script, root], {
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (value) => { stdout += value; });
    child.stderr.on("data", (value) => { stderr += value; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
}

async function runReadOnlyCommand(command, toolUseId = "tool_read_only") {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "easywork-version-hook-"));
  try {
    const root = path.join(temporary, "hooks");
    const script = path.join(temporary, "hook.py");
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, "active-task"), "task_test", "utf8");
    await fs.writeFile(script, VERSION_PRETOOL_PYTHON, "utf8");
    const result = await runHook(script, root, {
      hook_event_name: "PreToolUse",
      cwd: temporary,
      tool_name: "bash",
      tool_input: { command },
      tool_use_id: toolUseId,
    });
    assert.equal(result.code, 0, result.stderr);
    const rootEntries = (await fs.readdir(root)).sort();
    let captured = [];
    if (rootEntries.includes("task_test")) {
      const operations = await fs.readdir(path.join(root, "task_test"));
      captured = await Promise.all(operations.map(async (operation) => JSON.parse(await fs.readFile(path.join(root, "task_test", operation, "manifest.json"), "utf8"))));
    }
    assert.deepEqual(rootEntries, ["active-task"], JSON.stringify(captured));
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

test("version pre-tool hook ignores standard output sinks in read-only shell commands", async () => {
  await runReadOnlyCommand("ls -la . 2>/dev/null | head -50");
});

test("version pre-tool hook routes a shared Codex native session to its logical Web branch", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "easywork-version-hook-native-branch-"));
  try {
    const codexAgentRoot = path.join(temporary, "runtime", "agents", "codex");
    const sharedRoot = path.join(codexAgentRoot, "source-binding", "state", "version-hooks");
    const branchRoot = path.join(codexAgentRoot, "branch-binding", "state", "version-hooks");
    const workspace = path.join(temporary, "workspace");
    const script = path.join(temporary, "hook.py");
    await fs.mkdir(path.join(sharedRoot, "session-tasks"), { recursive: true });
    await fs.mkdir(branchRoot, { recursive: true });
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(path.join(sharedRoot, "active-task"), "task_source", "utf8");
    await fs.writeFile(path.join(sharedRoot, "session-tasks", "thread-native-fork.json"), JSON.stringify({
      schemaVersion: 1,
      taskId: "task_branch",
      hookRoot: branchRoot,
    }), "utf8");
    await fs.writeFile(script, VERSION_PRETOOL_PYTHON, "utf8");
    const result = await runHook(script, sharedRoot, {
      hook_event_name: "PreToolUse",
      session_id: "thread-native-fork",
      cwd: workspace,
      tool_name: "bash",
      tool_input: { command: "printf branch > branch.txt" },
      tool_use_id: "tool_branch_write",
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(await fs.stat(path.join(branchRoot, "task_branch")).then(() => true, () => false), true);
    assert.equal(await fs.stat(path.join(sharedRoot, "task_source")).then(() => true, () => false), false);
    const operations = await fs.readdir(path.join(branchRoot, "task_branch"));
    const manifest = JSON.parse(await fs.readFile(path.join(branchRoot, "task_branch", operations[0], "manifest.json"), "utf8"));
    const canonicalTarget = await fs.realpath(workspace).then((directory) => path.join(directory, "branch.txt"));
    assert.deepEqual(manifest.entries, [{ exists: false, path: canonicalTarget, payload: null, type: null }]);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("version pre-tool hook ignores compound read-only diagnostics from OpenCode", async () => {
  await runReadOnlyCommand(
    'GD=/home/smr/.easywork/versioning/user/server/domain/repository.git; timeout 60 git --git-dir=$GD show HEAD:acceptance.txt 2>&1 | head -30; echo "=== all objects grep ==="; for o in $(timeout 60 git --git-dir=$GD rev-list --objects --all 2>/dev/null | awk \'{print $1}\'); do c=$(timeout 10 git --git-dir=$GD cat-file -p $o 2>/dev/null); echo "$c" | grep -q -e "CYPRESS" -e "MiB" && echo "--- $o ---" && echo "$c" | head -20; done 2>/dev/null | head -60',
    "tool_compound_read_only",
  );
});

test("version pre-tool hook keeps newline-delimited commands separate from a preceding rm", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "easywork-version-hook-newline-"));
  try {
    const root = path.join(temporary, "hooks");
    const script = path.join(temporary, "hook.py");
    const workspace = path.join(temporary, "workspace");
    const evidence = path.join(temporary, "xinter-evidence.sample");
    const firstHash = path.join(temporary, "readme_hashes.txt");
    const secondHash = path.join(temporary, "actual_hashes.txt");
    await fs.mkdir(root, { recursive: true });
    await fs.mkdir(path.join(workspace, ".git"), { recursive: true });
    await fs.mkdir(path.join(workspace, "tests", "__pycache__"), { recursive: true });
    await fs.mkdir(evidence, { recursive: true });
    await fs.writeFile(path.join(evidence, "stdout.json"), "{}\n", "utf8");
    await fs.writeFile(path.join(root, "active-task"), "task_test", "utf8");
    await fs.writeFile(script, VERSION_PRETOOL_PYTHON, "utf8");
    const command = `echo ---DELETE---; rm -rf ${JSON.stringify(evidence)}
cd ${JSON.stringify(workspace)}
find . -path ./.git -prune -o \\( -name '__pycache__' -o -name '*.pyc' \\) -print -exec rm -rf {} + 2>/dev/null
grep -o hash README.md | sort > ${JSON.stringify(firstHash)}; sha256sum fixtures/*.json | sort > ${JSON.stringify(secondHash)}
git status --short; git log --oneline`;
    const result = await runHook(script, root, {
      hook_event_name: "PreToolUse",
      cwd: workspace,
      tool_name: "bash",
      tool_input: { command },
      tool_use_id: "tool_newline_cleanup",
    });
    assert.equal(result.code, 0, result.stderr);
    const operations = await fs.readdir(path.join(root, "task_test"));
    assert.equal(operations.length, 1);
    const manifest = JSON.parse(await fs.readFile(path.join(root, "task_test", operations[0], "manifest.json"), "utf8"));
    const canonicalFirstHash = await fs.realpath(path.dirname(firstHash))
      .then((directory) => path.join(directory, path.basename(firstHash)));
    const canonicalSecondHash = await fs.realpath(path.dirname(secondHash))
      .then((directory) => path.join(directory, path.basename(secondHash)));
    assert.deepEqual(manifest.entries.map((entry) => entry.path).sort(), [
      await fs.realpath(evidence),
      canonicalFirstHash,
      canonicalSecondHash,
    ].sort());
    assert.equal(manifest.entries.some((entry) => entry.path.includes(`${path.sep}.git`)), false);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("version pre-tool hook treats heredoc bodies as data while capturing apply_patch and redirect targets", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "easywork-version-hook-heredoc-"));
  try {
    const root = path.join(temporary, "hooks");
    const script = path.join(temporary, "hook.py");
    const readme = path.join(temporary, "README.md");
    const generated = path.join(temporary, "generated.sh");
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, "active-task"), "task_test", "utf8");
    await fs.writeFile(script, VERSION_PRETOOL_PYTHON, "utf8");
    await fs.writeFile(readme, "old\n", "utf8");
    const command = `apply_patch <<'PATCH'
*** Begin Patch
*** Update File: README.md
@@
-old
+setuptools>=61 and this example writes 2> out.log
*** End Patch
PATCH
cat > generated.sh <<'SCRIPT'
#!/bin/sh
echo "comparison >= 61" 2> out.log
SCRIPT`;
    const result = await runHook(script, root, {
      hook_event_name: "PreToolUse",
      cwd: temporary,
      tool_name: "bash",
      tool_input: { command },
      tool_use_id: "tool_heredoc",
    });
    assert.equal(result.code, 0, result.stderr);
    const canonicalReadme = await fs.realpath(readme);
    const canonicalGenerated = await fs.realpath(path.dirname(generated)).then((directory) => path.join(directory, path.basename(generated)));
    const operations = await fs.readdir(path.join(root, "task_test"));
    assert.equal(operations.length, 1);
    const manifest = JSON.parse(await fs.readFile(path.join(root, "task_test", operations[0], "manifest.json"), "utf8"));
    assert.deepEqual(manifest.entries.map((entry) => entry.path).sort(), [canonicalGenerated, canonicalReadme].sort());
    assert.equal(manifest.entries.find((entry) => entry.path === canonicalReadme).exists, true);
    assert.equal(manifest.entries.find((entry) => entry.path === canonicalGenerated).exists, false);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("version pre-tool hook captures pathlib writes inside a Python heredoc", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "easywork-version-hook-python-heredoc-"));
  try {
    const root = path.join(temporary, "hooks");
    const script = path.join(temporary, "hook.py");
    const report = path.join(temporary, "sacct_report", "report.py");
    const testsFile = path.join(temporary, "tests", "test_duration_formats.py");
    const generated = path.join(temporary, "generated.txt");
    await fs.mkdir(root, { recursive: true });
    await fs.mkdir(path.dirname(report), { recursive: true });
    await fs.mkdir(path.dirname(testsFile), { recursive: true });
    await fs.writeFile(path.join(root, "active-task"), "task_test", "utf8");
    await fs.writeFile(script, VERSION_PRETOOL_PYTHON, "utf8");
    await fs.writeFile(report, "old report\n", "utf8");
    await fs.writeFile(testsFile, "old test\n", "utf8");
    const command = `/bin/bash -lc "cd ${temporary} && /usr/local/python3.12/bin/python3 - <<'PY'
import pathlib
r = pathlib.Path(\"sacct_report/report.py\")
t = pathlib.Path(\"tests/test_duration_formats.py\")
g = pathlib.Path(\"generated.txt\")
def replay(target, suffix):
    previous = target.read_text() if target.exists() else \"\"
    target.write_text(previous + suffix)
replay(r, \"changed\\n\")
replay(t, \"changed\\n\")
replay(g, \"new\\n\")
PY"`;
    const result = await runHook(script, root, {
      hook_event_name: "PreToolUse",
      cwd: temporary,
      tool_name: "Bash",
      tool_input: { command },
      tool_use_id: "call_python_heredoc_write",
    });
    assert.equal(result.code, 0, result.stderr);
    const operations = await fs.readdir(path.join(root, "task_test"));
    assert.equal(operations.length, 1);
    const manifest = JSON.parse(await fs.readFile(path.join(root, "task_test", operations[0], "manifest.json"), "utf8"));
    const canonicalGenerated = await fs.realpath(path.dirname(generated))
      .then((directory) => path.join(directory, path.basename(generated)));
    assert.deepEqual(manifest.entries.map((entry) => entry.path).sort(), [
      await fs.realpath(report),
      await fs.realpath(testsFile),
      canonicalGenerated,
    ].sort());
    assert.equal(manifest.entries.find((entry) => entry.path === canonicalGenerated).exists, false);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("version pre-tool hook ignores a read-only Python heredoc", async () => {
  await runReadOnlyCommand("python3 - <<'PY'\nfrom pathlib import Path\np = Path('report.json')\nprint(p.read_text())\nPY", "tool_python_heredoc_read");
});

test("version pre-tool hook captures a Codex Bash apply_patch command after an explicit cd", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "easywork-version-hook-codex-bash-"));
  try {
    const root = path.join(temporary, "hooks");
    const script = path.join(temporary, "hook.py");
    const target = path.join(temporary, "docs", "handoff-note.md");
    await fs.mkdir(root, { recursive: true });
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(path.join(root, "active-task"), "task_test", "utf8");
    await fs.writeFile(script, VERSION_PRETOOL_PYTHON, "utf8");
    await fs.writeFile(target, "scnet CPU 基线交接\n已验证作业号：5331769\nCPU-only，无 GPU\n", "utf8");
    const command = `cd ${temporary} && apply_patch <<'EOF'
*** Begin Patch
*** Update File: docs/handoff-note.md
@@
-已验证作业号：5331769
+已验证 Slurm 作业：5331769
*** End Patch
EOF
git status --short --branch`;
    const result = await runHook(script, root, {
      hook_event_name: "PreToolUse",
      cwd: temporary,
      tool_name: "Bash",
      tool_input: { command },
      tool_use_id: "call_codex_bash_patch",
    });
    assert.equal(result.code, 0, result.stderr);
    const operations = await fs.readdir(path.join(root, "task_test"));
    assert.equal(operations.length, 1);
    const manifest = JSON.parse(await fs.readFile(path.join(root, "task_test", operations[0], "manifest.json"), "utf8"));
    assert.deepEqual(manifest.entries.map((entry) => entry.path), [await fs.realpath(target)]);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("version pre-tool hook keeps stderr sinks out of cp operands", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "easywork-version-hook-cp-redirect-"));
  try {
    const root = path.join(temporary, "hooks");
    const script = path.join(temporary, "hook.py");
    const source = path.join(temporary, "source.md");
    const destination = path.join(temporary, "destination.md");
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, "active-task"), "task_test", "utf8");
    await fs.writeFile(script, VERSION_PRETOOL_PYTHON, "utf8");
    await fs.writeFile(source, "source\n", "utf8");
    const result = await runHook(script, root, {
      hook_event_name: "PreToolUse",
      cwd: temporary,
      tool_name: "bash",
      tool_input: {
        command: "cp -p source.md destination.md 2>/dev/null && echo copied; python3 - <<'EOF'\nprint(open('source.md').read())\nEOF",
      },
      tool_use_id: "tool_cp_redirect",
    });
    assert.equal(result.code, 0, result.stderr);
    const operations = await fs.readdir(path.join(root, "task_test"));
    assert.equal(operations.length, 1);
    const manifest = JSON.parse(await fs.readFile(path.join(root, "task_test", operations[0], "manifest.json"), "utf8"));
    const canonicalDestination = await fs.realpath(path.dirname(destination)).then((directory) => path.join(directory, path.basename(destination)));
    assert.deepEqual(manifest.entries, [{ exists: false, path: canonicalDestination, payload: null, type: null }]);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("version pre-tool hook treats Perl programs as syntax and captures only in-place targets", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "easywork-version-hook-perl-in-place-"));
  try {
    const root = path.join(temporary, "hooks");
    const script = path.join(temporary, "hook.py");
    const target = path.join(temporary, "app.js");
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, "active-task"), "task_test", "utf8");
    await fs.writeFile(script, VERSION_PRETOOL_PYTHON, "utf8");
    await fs.writeFile(target, "const enabled = true;\n", "utf8");
    const longProgram = `s/${"very-long-pattern/".repeat(40)}/replacement/`;
    const result = await runHook(script, root, {
      hook_event_name: "PreToolUse",
      cwd: temporary,
      tool_name: "bash",
      tool_input: { command: `perl -0pi -e ${JSON.stringify(longProgram)} app.js` },
      tool_use_id: "tool_perl_in_place",
    });
    assert.equal(result.code, 0, result.stderr);
    const operations = await fs.readdir(path.join(root, "task_test"));
    assert.equal(operations.length, 1);
    const manifest = JSON.parse(await fs.readFile(path.join(root, "task_test", operations[0], "manifest.json"), "utf8"));
    assert.deepEqual(manifest.entries.map((entry) => entry.path), [await fs.realpath(target)]);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("version pre-tool hook captures numeric chmod modes and shell-glob targets", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "easywork-version-hook-chmod-"));
  try {
    const root = path.join(temporary, "hooks");
    const script = path.join(temporary, "hook.py");
    const scripts = path.join(temporary, "scripts");
    const first = path.join(scripts, "first.sh");
    const second = path.join(scripts, "second.sh");
    await fs.mkdir(root, { recursive: true });
    await fs.mkdir(scripts, { recursive: true });
    await fs.writeFile(path.join(root, "active-task"), "task_test", "utf8");
    await fs.writeFile(script, VERSION_PRETOOL_PYTHON, "utf8");
    await fs.writeFile(first, "#!/bin/sh\n", { mode: 0o644 });
    await fs.writeFile(second, "#!/bin/sh\n", { mode: 0o644 });
    const result = await runHook(script, root, {
      hook_event_name: "PreToolUse",
      cwd: temporary,
      tool_name: "bash",
      tool_input: { command: "chmod 0755 -- scripts/first.sh && chmod +x scripts/*.sh" },
      tool_use_id: "tool_chmod_glob",
    });
    assert.equal(result.code, 0, result.stderr);
    const operations = await fs.readdir(path.join(root, "task_test"));
    assert.equal(operations.length, 1);
    const manifest = JSON.parse(await fs.readFile(path.join(root, "task_test", operations[0], "manifest.json"), "utf8"));
    assert.deepEqual(manifest.entries.map((entry) => entry.path).sort(), [await fs.realpath(first), await fs.realpath(second)].sort());
    assert.deepEqual(manifest.entries.map((entry) => entry.type), ["file", "file"]);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("version pre-tool hook does not snapshot Python read-only open calls", async () => {
  await runReadOnlyCommand("python3 -c \"import json; print(json.load(open('report.json')))\"", "tool_python_read");
});

test("version pre-tool hook recognizes the real workspace when the Agent HOME is isolated", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "easywork-version-hook-home-"));
  try {
    const sshHome = path.join(temporary, "ssh-home");
    const isolatedHome = path.join(sshHome, ".easywork", "runtime", "bindings", "binding", "home");
    const workspace = path.join(sshHome, ".easywork", "workspaces", "user", "conversation", "workspace");
    const target = path.join(workspace, "scripts", "verify_install.sh");
    const root = path.join(sshHome, ".easywork", "runtime", "version-hooks");
    const script = path.join(temporary, "hook.py");
    await fs.mkdir(isolatedHome, { recursive: true });
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, "active-task"), "task_test", "utf8");
    await fs.writeFile(script, VERSION_PRETOOL_PYTHON, "utf8");
    const result = await runHook(script, root, {
      hook_event_name: "PreToolUse",
      cwd: workspace,
      tool_name: "bash",
      tool_input: { command: "printf '%s\\n' ready > scripts/verify_install.sh" },
      tool_use_id: "tool_isolated_home",
    }, {
      env: { ...process.env, HOME: isolatedHome, USERPROFILE: isolatedHome },
    });
    assert.equal(result.code, 0, result.stderr);
    const operations = await fs.readdir(path.join(root, "task_test"));
    assert.equal(operations.length, 1);
    const manifest = JSON.parse(await fs.readFile(path.join(root, "task_test", operations[0], "manifest.json"), "utf8"));
    const canonicalTarget = await fs.realpath(path.dirname(target)).then((directory) => path.join(directory, path.basename(target)));
    assert.deepEqual(manifest.entries, [{ exists: false, path: canonicalTarget, payload: null, type: null }]);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("version pre-tool hook still rejects EasyWork control state outside the workspace root", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "easywork-version-hook-control-"));
  try {
    const sshHome = path.join(temporary, "ssh-home");
    const workspace = path.join(sshHome, ".easywork", "workspaces", "user", "conversation", "workspace");
    const controlTarget = path.join(sshHome, ".easywork", "runtime", "state.json");
    const root = path.join(sshHome, ".easywork", "runtime", "version-hooks");
    const script = path.join(temporary, "hook.py");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, "active-task"), "task_test", "utf8");
    await fs.writeFile(script, VERSION_PRETOOL_PYTHON, "utf8");
    const result = await runHook(script, root, {
      hook_event_name: "PreToolUse",
      cwd: workspace,
      tool_name: "bash",
      tool_input: { command: `printf blocked > ${JSON.stringify(controlTarget)}` },
      tool_use_id: "tool_control_state",
    });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /EasyWork control files are not versioned/);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
