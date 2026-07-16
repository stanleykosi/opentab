#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$ROOT/artifacts/autonomous-build"
RUN_LOG="$LOG_DIR/codex-resume-$(date +%Y%m%d-%H%M%S).log"
FINAL_MESSAGE="$LOG_DIR/final-codex-message.md"

cd "$ROOT"
bash scripts/preflight-autonomous.sh

read -r -d '' RESUME_PROMPT <<'PROMPT' || true
Continue the existing OpenTab autonomous build in this repository. This is a recovery continuation of the original single-run task, not a new planning task.

Read, in order: AGENTS.md, 01_AUTONOMOUS_SUPER_PROMPT.md, AUTONOMOUS_BUILD_STATE.md, BLOCKERS.md, FINAL_BUILD_REPORT.md, the current git diff/status, and the latest logs under artifacts/autonomous-build. Inspect any active or completed subagent reports. Resume from the first incomplete non-external gate. Do not repeat completed work unless validation shows it is broken. Continue spawning the configured bounded subagents where useful, implement all remaining code, fix failing tests, run release validation, and finish the required final files.

Do not stop at a summary. Finish with READY FOR DEPLOYMENT or BUILD COMPLETE WITH EXTERNAL BLOCKERS according to the prompt's exact criteria.
PROMPT

set +e
printf '%s\n' "$RESUME_PROMPT" | codex \
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
  resume --last \
  - 2>&1 | tee "$RUN_LOG"
status=${PIPESTATUS[1]}
set -e

printf '\nCodex resume exit code: %s\n' "$status"
exit "$status"
