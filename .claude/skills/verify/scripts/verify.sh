#!/usr/bin/env bash
# Runs a verification scenario in its own process group and keeps the evidence.
#   .claude/skills/verify/scripts/verify.sh <scenario.ts> [out-dir]
# Evidence (run.log, screenshots, pgid) lands in out-dir, default /tmp/browserlace-verify/<timestamp>.
# Profiles and the database go in out-dir/scratch (via TMPDIR), which cleanup.sh removes.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
scenario="$(realpath "${1:?usage: verify.sh <scenario.ts> [out-dir]}")"
out="${2:-/tmp/browserlace-verify/$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$out/scratch"
cp "$scenario" "$out/scenario.ts.txt"
cd "$here/../../../.."
# setsid gives the run its own process group, recorded in pgid, so cleanup.sh can kill exactly it.
VERIFY_OUT="$out" TMPDIR="$out/scratch" setsid bash -c 'echo $$ > "$VERIFY_OUT/pgid"; exec node "$0" "$1"' "$here/drive.ts" "$scenario"
