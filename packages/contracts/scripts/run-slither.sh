#!/usr/bin/env bash
set -euo pipefail

slither_bin="${SLITHER_BIN:-slither}"
original_home="${HOME:-}"
solc_version="$(forge config --json | jq -r '.solc')"
solc_bin="${SOLC_BIN:-}"

# An isolated /tmp uv tool cannot write solc-select state under the managed
# developer home. Keep that runtime state in /tmp while still pointing Foundry
# at its already-pinned compiler binary. Normal CI installs retain their HOME.
if [[ "$slither_bin" == /tmp/* ]]; then
  export HOME="${SLITHER_HOME:-/tmp/opentab-slither-home}"
  mkdir -p "$HOME"
  if [[ -z "$solc_bin" && -n "$original_home" ]]; then
    candidate="$original_home/.local/share/svm/$solc_version/solc-$solc_version"
    if [[ -x "$candidate" ]]; then solc_bin="$candidate"; fi
  fi
fi

args=(. --config-file slither.config.json)
if [[ -n "$solc_bin" ]]; then
  export FOUNDRY_SOLC="$solc_bin"
  args+=(--solc "$solc_bin")
fi

exec "$slither_bin" "${args[@]}"
