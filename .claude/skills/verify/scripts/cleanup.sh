#!/usr/bin/env bash
# Kills what a verify.sh run started (its process group) and removes its scratch profiles
# and database. Keeps the evidence (run.log, screenshots, scenario copy).
#   .claude/skills/verify/scripts/cleanup.sh <out-dir>
set -uo pipefail
out="${1:?usage: cleanup.sh <out-dir>}"
if [[ -f "$out/pgid" ]]; then
  pgid="$(cat "$out/pgid")"
  if kill -0 -- "-$pgid" 2>/dev/null; then
    kill -TERM -- "-$pgid" 2>/dev/null; sleep 2; kill -KILL -- "-$pgid" 2>/dev/null
    echo "killed process group $pgid"
  else
    echo "process group $pgid already gone"
  fi
fi
rm -rf "$out/scratch"
echo "evidence kept in $out"
