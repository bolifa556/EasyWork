import { refractor } from "refractor/core";
import bash from "refractor/bash";
import css from "refractor/css";
import json from "refractor/json";
import jsx from "refractor/jsx";
import markup from "refractor/markup";
import powershell from "refractor/powershell";
import python from "refractor/python";
import sql from "refractor/sql";
import tsx from "refractor/tsx";
import yaml from "refractor/yaml";

for (const syntax of [bash, css, json, jsx, markup, powershell, python, sql, tsx, yaml]) refractor.register(syntax);
// Bash examples often use hyphenated flags, executable paths, and Slurm tools.
refractor.languages.insertBefore("bash", "parameter", {
  parameter: { pattern: /(^|\s)--?[A-Za-z_][\w.-]*(?=[=\s]|$)/, lookbehind: true, alias: "variable" },
});
refractor.languages.insertBefore("bash", "function", {
  "command-path": { pattern: /(^[ \t]*|[;&|][ \t]*)(?:\.{0,2}\/|~\/|[\w.-]+\/)[\w./-]+(?=[ \t]|$)/m, lookbehind: true, greedy: true, alias: "function" },
  "file-path": { pattern: /(^|[\s=])(?:\.{0,2}\/|~\/|[\w.-]+\/)[^\s"'\\;|&]+/, lookbehind: true, alias: "string" },
  "tool-command": { pattern: /\b(?:python(?:[23](?:\.\d+)?)?|pip[23]?|conda|mamba|uv|sbatch|srun|squeue|sacct|scancel|sinfo)(?=$|[\s;|&])/, alias: "function" },
});
refractor.alias({ bash: ["console", "terminal", "zsh"], powershell: ["pwsh", "ps1"] });

export function highlightCode(source: string, language: string) {
  // Large logs stay cheap to render, and an unknown fence stays plain text.
  if (!source || source.length > 64_000 || !refractor.registered(language.toLowerCase())) return null;
  try {
    return refractor.highlight(source, language.toLowerCase());
  } catch {
    return null;
  }
}
