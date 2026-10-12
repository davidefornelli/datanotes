#!/usr/bin/env bash
# SessionStart hook (.claude/settings.json): prepares a Claude Code cloud session (claude.ai/code).
# Does nothing outside the cloud (CLAUDE_CODE_REMOTE != "true"). Idempotent and quick on resume:
#   - npm ci, only when node_modules is missing or package-lock.json changed since the last install;
#   - npm run build:service (dist/datanotes.cjs, the CLI that `npm run dev` runs), only when dist
#     is missing or older than src/;
#   - the docs site's dependencies only with DATANOTES_SETUP_DOCS=1 (slow).
# Its output goes into the session's context, so it prints a short summary; logs go to
# $TMPDIR/datanotes-cloud-setup.log. It always exits 0: a failed step is reported, not fatal.

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/..}" || exit 0
log="${TMPDIR:-/tmp}/datanotes-cloud-setup.log"
: > "$log"
problems=""

run() { # run <label> <command...>: output to the log, a line in the summary on failure
  local label="$1"; shift
  if ! "$@" >> "$log" 2>&1; then
    problems="${problems}  - ${label} failed (see ${log})"$'\n'
    return 1
  fi
}

if [ ! -d node_modules ] || [ ! -f node_modules/.package-lock.json ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  echo "datanotes: installing dependencies (npm ci)..."
  run "npm ci" npm ci --no-audit --no-fund
fi

if [ -d node_modules ]; then
  if [ ! -f dist/datanotes.cjs ] || [ -n "$(find src package.json -newer dist/datanotes.cjs -print -quit 2>/dev/null)" ]; then
    echo "datanotes: building dist (npm run build:service)..."
    run "npm run build:service" npm run build:service
  fi
fi

if [ "${DATANOTES_SETUP_DOCS:-}" = "1" ] && [ -f docs/package-lock.json ]; then
  if [ ! -d docs/node_modules ] || [ docs/package-lock.json -nt docs/node_modules/.package-lock.json ]; then
    echo "datanotes: installing the docs site's dependencies..."
    run "docs npm ci" npm ci --no-audit --no-fund --prefix docs
  fi
fi

echo "datanotes cloud session ready: node $(node --version 2>/dev/null), npm $(npm --version 2>/dev/null)"
if [ -n "$problems" ]; then
  printf 'Setup problems:\n%s' "$problems"
fi
echo "Read CLAUDE.md. Tests: npm test (long: run in the background); one file: npx vitest run tests/<name>.test.ts."
echo "Engine on a copy of test-vault/: npm run dev (background it; it prints the URL and token)."
exit 0
