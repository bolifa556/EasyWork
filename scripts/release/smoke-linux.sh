#!/bin/sh
set -eu
task_repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
task_target=${1:?Usage: smoke-linux.sh linux-x64|linux-centos7-x64}
case "$task_target" in linux-x64|linux-centos7-x64) ;; *) exit 2 ;; esac
task_package_dir=$(mktemp -d /tmp/easywork-release.XXXXXX)
tar -xzf "$task_repo_root/releases/easywork-0.1.0-$task_target.tar.gz" -C "$task_package_dir"
task_package_root="$task_package_dir/easywork-0.1.0-$task_target"
test -x "$task_package_root/start.sh"
printf '%s\n' "$task_package_root" > "$task_repo_root/.cache/release-checks/$task_target-package-path.txt"
"$task_package_root/runtime/bin/node" "$task_repo_root/scripts/smoke-release.mjs" "$task_package_root"
