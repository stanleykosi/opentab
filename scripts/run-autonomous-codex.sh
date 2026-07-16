#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROMPT="$ROOT/01_AUTONOMOUS_SUPER_PROMPT.md"
LOG_DIR="$ROOT/artifacts/autonomous-build"
RUN_LOG="$LOG_DIR/codex-run.log"
FINAL_MESSAGE="$LOG_DIR/final-codex-message.md"
EXIT_FILE="$LOG_DIR/codex-exit-code.txt"

cd "$ROOT"

bash scripts/preflight-autonomous.sh

if [[ ! -f "$PROMPT" ]]; then
  printf 'Prompt not found: %s\n' "$PROMPT" >&2
  exit 1
fi

mkdir -p "$LOG_DIR"
printf 'Starting the OpenTab autonomous Codex build from %s\n' "$ROOT"
printf 'Progress log: %s\n' "$RUN_LOG"
printf 'Final Codex message: %s\n\n' "$FINAL_MESSAGE"

set +e
cat "$PROMPT" | codex \
  --cd "$ROOT" \
  --sandbox workspace-write \
  --ask-for-approval never \
  --search \
  -c 'sandbox_workspace_write.network_access=true' \
  -c 'agents.max_threads=8' \
  -c 'agents.max_depth=1' \
  -c 'agents.job_max_runtime_seconds=7200' \
  exec \
  --output-last-message "$FINAL_MESSAGE" \
  - 2>&1 | tee "$RUN_LOG"
status=${PIPESTATUS[1]}
set -e

printf '%s\n' "$status" > "$EXIT_FILE"

printf '\nCodex process exit code: %s\n' "$status"
printf 'Review FINAL_BUILD_REPORT.md, BLOCKERS.md, AUTONOMOUS_BUILD_STATE.md, and 03_DEPLOYMENT_AFTER_BUILD.md.\n'

exit "$status"
