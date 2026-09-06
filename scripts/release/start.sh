#!/bin/sh
set -eu
EASYWORK_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$EASYWORK_ROOT"
export NODE_ENV=production
if [ -f "$EASYWORK_ROOT/.env" ]; then
  exec "$EASYWORK_ROOT/runtime/bin/node" --env-file="$EASYWORK_ROOT/.env" "$EASYWORK_ROOT/scripts/serve-easywork.mjs"
fi
exec "$EASYWORK_ROOT/runtime/bin/node" "$EASYWORK_ROOT/scripts/serve-easywork.mjs"
