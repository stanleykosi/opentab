#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

missing=0
for command_name in git codex node pnpm; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'MISSING REQUIRED COMMAND: %s\n' "$command_name" >&2
    missing=1
  else
    printf 'FOUND: %-10s %s\n' "$command_name" "$(command -v "$command_name")"
  fi
done

for optional_command in docker forge cast anvil python3; do
  if command -v "$optional_command" >/dev/null 2>&1; then
    printf 'FOUND OPTIONAL: %-8s %s\n' "$optional_command" "$(command -v "$optional_command")"
  else
    printf 'OPTIONAL TOOL NOT FOUND: %s (Codex must record a blocker only if its work truly requires it)\n' "$optional_command"
  fi
done

node_version="$(node --version 2>/dev/null || echo missing)"
pnpm_version="$(pnpm --version 2>/dev/null || echo missing)"
if [[ "$node_version" != "v25.0.0" ]]; then
  printf 'EXPECTED Node v25.0.0, found %s\n' "$node_version" >&2
  missing=1
fi
if [[ "$pnpm_version" != "9.15.1" ]]; then
  printf 'EXPECTED pnpm 9.15.1, found %s\n' "$pnpm_version" >&2
  missing=1
fi

if [[ "$missing" -ne 0 ]]; then
  exit 1
fi

if [[ ! -d .git ]]; then
  git init
  git branch -M main || true
  printf 'Initialized a Git repository. A baseline commit will be created by the owner or Codex when Git identity permits.\n'
fi

mkdir -p \
  artifacts/autonomous-build/agent-reports \
  artifacts/autonomous-build/test-results \
  artifacts/autonomous-build/logs \
  artifacts/autonomous-build/evidence

if ! git check-ignore .env.local >/dev/null 2>&1; then
  printf 'WARNING: .env.local is not currently ignored. The autonomous run must correct .gitignore before secrets are added.\n' >&2
fi

printf '\nCodex version:\n'
codex --version

printf '\nCodex authentication status:\n'
codex login status

printf '\nCodex diagnostic summary:\n'
codex doctor || true

printf '\nPreflight complete.\n'
