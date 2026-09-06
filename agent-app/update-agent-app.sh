#!/bin/sh
set -eu
task_agent_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
task_node="$task_agent_dir/../runtime/bin/node"
if [ ! -x "$task_node" ]; then
  if ! command -v node >/dev/null 2>&1; then
    printf '%s\n' 'Node.js 22.13+ is required. Use an EasyWork release with its bundled runtime.' >&2
    exit 1
  fi
  task_node=node
fi
exec "$task_node" "$task_agent_dir/update-agent-app.mjs" "$@"
