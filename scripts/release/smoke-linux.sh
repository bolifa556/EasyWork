#!/bin/sh
set -eu
task_repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
task_target=${1:?Usage: smoke-linux.sh linux-x64|linux-centos7-x64 [version]}
task_version=${2:-0.1.2}
case "$task_version" in *[!0-9A-Za-z.-]*|'') exit 2 ;; esac
case "$task_target" in linux-x64|linux-centos7-x64) ;; *) exit 2 ;; esac
task_package_dir=$(mktemp -d "${EASYWORK_RELEASE_TEST_TMPDIR:-/var/tmp}/easywork-release.XXXXXX")
printf 'Checking package in %s\n' "$task_package_dir"
tar -xzf "$task_repo_root/releases/easywork-$task_version-$task_target.tar.gz" -C "$task_package_dir"
task_package_root="$task_package_dir/easywork-$task_version-$task_target"
test -x "$task_package_root/start.sh"
test -x "$task_package_root/agent-app/update-agent-app.sh"
mkdir -p "$task_repo_root/.cache/release-checks"
printf '%s\n' "$task_package_root" > "$task_repo_root/.cache/release-checks/$task_target-package-path.txt"
"$task_package_root/runtime/bin/node" "$task_repo_root/scripts/smoke-release.mjs" "$task_package_root"
