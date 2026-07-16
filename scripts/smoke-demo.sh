#!/usr/bin/env bash
set -euo pipefail

raw_base_url="${1:-${OPENTAB_BASE_URL:-http://localhost:3000}}"
base_url="$(node - "$raw_base_url" <<'NODE'
const raw = process.argv[2];
let url;
try {
  url = new URL(raw);
} catch {
  process.stderr.write('Smoke target is not a valid absolute URL.\n');
  process.exit(2);
}
const loopback = new Set(['localhost', '127.0.0.1', '[::1]']).has(url.hostname);
if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
  process.stderr.write('Smoke target must use HTTPS unless it is an exact loopback host.\n');
  process.exit(2);
}
if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
  process.stderr.write('Smoke target must be a credential-free origin with no path, query, or fragment.\n');
  process.exit(2);
}
process.stdout.write(url.origin);
NODE
)"

curl_flags=(--fail --silent --show-error --max-time 15 --retry 2 --retry-all-errors)

echo "Checking health..."
health="$(curl "${curl_flags[@]}" "$base_url/api/health")"
printf '%s\n' "$health" | node -e '
let body=""; process.stdin.on("data",c=>body+=c); process.stdin.on("end",()=>{
  const value=JSON.parse(body);
  if(value.status!=="live") throw new Error(`health status was ${value.status}`);
  console.log(`liveness confirmed (${value.service ?? "opentab"})`);
});'

echo "Checking public document..."
html="$(curl "${curl_flags[@]}" "$base_url/")"
grep -qi 'OpenTab' <<<"$html" || { echo "OpenTab marker missing from root page" >&2; exit 1; }

echo "Safe smoke checks passed for $base_url"

echo "No payment, sponsor grant, mutation, or wallet action was executed by this script."
