import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const action = process.argv[2] ?? "dev";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const executable = process.execPath;
const cli = path.join(root, "node_modules", "vinext", "dist", "cli.js");

const child = spawn(executable, [cli, action, ...process.argv.slice(3)], {
  cwd: root,
  env: {
    ...process.env,
    WRANGLER_LOG_PATH:
      process.env.WRANGLER_LOG_PATH ?? path.join(".wrangler", "wrangler.log"),
  },
  stdio: "inherit",
  shell: false,
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
