#!/usr/bin/env bash
# Read-only: is this checkout ready to drive? Exits non-zero on the first blocker.
#   .claude/skills/verify/scripts/doctor.sh [out-dir]   # with out-dir, also reports that run's process group
set -uo pipefail
root="$(cd "$(dirname "$0")/../../../.." && pwd)"
ok=1
say() { echo "$1 $2"; if [[ $1 == FAIL ]]; then ok=0; fi; }

major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[[ $major -ge 24 ]] && say OK "node $(node -v)" || say FAIL "node 24+ required (have $(node -v 2>/dev/null || echo none))"
[[ -d $root/e2e/node_modules/playwright-core ]] && say OK "e2e deps installed" || say FAIL "run: pnpm install"
if ls ~/.cache/ms-playwright/chromium-* >/dev/null 2>&1; then say OK "playwright chromium present"
else say FAIL "run: (cd e2e && npx playwright-core install chromium)"; fi

manifest="$root/apps/extension/.output/chrome-mv3/manifest.json"
if [[ ! -f $manifest ]]; then
  say FAIL "no extension build; run: pnpm --filter @browserlace/extension build"
else
  stale="$(find "$root/apps/extension/entrypoints" "$root/apps/extension/lib" "$root/apps/extension/components" \
    "$root/packages/core/src" "$root/apps/extension/wxt.config.ts" -newer "$manifest" -type f 2>/dev/null | head -3)"
  [[ -z $stale ]] && say OK "extension build is newer than its sources" \
    || say FAIL "extension build is stale (e.g. ${stale%%$'\n'*}); run: pnpm --filter @browserlace/extension build"
fi

if [[ -n ${1:-} && -f $1/pgid ]]; then
  pgid="$(cat "$1/pgid")"
  kill -0 -- "-$pgid" 2>/dev/null && say OK "run $1 is live (process group $pgid)" || echo "INFO run $1 has exited"
fi
[[ $ok == 1 ]] && echo "READY" || { echo "NOT READY"; exit 1; }
