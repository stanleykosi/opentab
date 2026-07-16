#!/usr/bin/env bash
set -euo pipefail

fail=0
check() {
  local command="$1"
  if command -v "$command" >/dev/null 2>&1; then
    printf 'OK   %-12s %s\n' "$command" "$("$command" --version 2>/dev/null | head -n 1 || true)"
  else
    printf 'MISS %-12s required\n' "$command" >&2
    fail=1
  fi
}

check_optional() {
  local command="$1"
  local purpose="$2"
  if command -v "$command" >/dev/null 2>&1; then
    printf 'OK   %-12s %s\n' "$command" "$("$command" --version 2>/dev/null | head -n 1 || true)"
  else
    printf 'INFO %-12s optional (%s)\n' "$command" "$purpose"
  fi
}

check git
check node
check pnpm
check forge
check cast
check_optional docker 'use native PostgreSQL and Redis when unavailable'

node_version="$(node --version 2>/dev/null || echo missing)"
pnpm_version="$(pnpm --version 2>/dev/null || echo missing)"
if [[ "$node_version" != "v25.0.0" ]]; then
  echo "FAIL Expected Node v25.0.0; found $node_version." >&2
  fail=1
fi
if [[ "$pnpm_version" != "9.15.1" ]]; then
  echo "FAIL Expected pnpm 9.15.1; found $pnpm_version." >&2
  fail=1
fi

if [[ "$fail" -ne 0 ]]; then
  echo "Install missing prerequisites before running the complete repository gates." >&2
  exit 1
fi
