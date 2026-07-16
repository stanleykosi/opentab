#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
contracts="$root/packages/contracts"

command -v forge >/dev/null || { echo "Foundry/forge is required." >&2; exit 1; }

cd "$contracts"

if [[ ! -d lib/forge-std ]]; then
  forge install --shallow --no-git \
    forge-std=foundry-rs/forge-std@rev=7117c90c8cf6c68e5acce4f09a6b24715cea4de6
fi
if [[ ! -d lib/openzeppelin-contracts ]]; then
  forge install --shallow --no-git \
    openzeppelin-contracts=OpenZeppelin/openzeppelin-contracts@rev=5fd1781b1454fd1ef8e722282f86f9293cacf256
fi

forge build --sizes
