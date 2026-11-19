#!/bin/sh
# Refresh src/engine from the Latch monorepo: sh scripts/sync-engine.sh /path/to/latch
set -eu
MONO="${1:?usage: sync-engine.sh <path to the Latch monorepo>}"
SRC="$MONO/packages/engine/src"
DEST="$(dirname "$0")/../src/engine"
[ -f "$SRC/index.ts" ] || { echo "no engine at $SRC" >&2; exit 1; }
find "$DEST" -maxdepth 1 -name '*.ts' -delete
find "$SRC" -maxdepth 1 -name '*.ts' -exec cp {} "$DEST/" \;
EDGE="$(dirname "$0")/../test/edge/signed-context.ts"
{ echo "// Copy of the Latch edge's verifier (apps/edge/src/signed-context.ts), refreshed by scripts/sync-engine.sh."; sed 's#from "@latch/engine"#from "../../src/engine/index.ts"#' "$MONO/apps/edge/src/signed-context.ts"; } > "$EDGE"
git -C "$MONO" rev-parse HEAD > "$DEST/SOURCE"
echo "engine synced from $(cat "$DEST/SOURCE")"
