import fs from 'node:fs';
import path from 'node:path';

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 1) continue;
    out[line.slice(0, i).trim()] = line
      .slice(i + 1)
      .trim()
      .replace(/^['"]|['"]$/g, '');
  }
  return out;
}

const root = path.resolve(import.meta.dirname, '..');
const env = {
  ...loadEnvFile(path.join(root, '.env')),
  ...loadEnvFile(path.join(root, '.env.local')),
  ...process.env,
};
const errors = [];
const warnings = [];
const bool = (name) => String(env[name] ?? '').toLowerCase() === 'true';
const missing = (name) => !env[name] || /REPLACE_ME|REPLACE_WITH/.test(env[name]);
const bigint = (name) => {
  const value = String(env[name] ?? '0');
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    errors.push(`${name} must be an unsigned decimal integer.`);
    return 0n;
  }
  return BigInt(value);
};

if (
  (env.APP_ENV ?? 'local') === 'production' &&
  env.NEXT_PUBLIC_APP_ORIGIN?.startsWith('http://')
) {
  errors.push('Production APP origin must use HTTPS.');
}
if (
  (env.APP_ENV ?? 'local') === 'production' &&
  (env.PROVIDER_MODE ?? 'deterministic') !== 'live'
) {
  errors.push('Production PROVIDER_MODE must be live.');
}
if ((env.APP_ENV ?? 'local') === 'production' && bool('DETERMINISTIC_DEMO_ENABLED')) {
  errors.push('Production cannot enable deterministic demo mode.');
}
if (env.APP_ENV && env.NEXT_PUBLIC_APP_ENV && env.APP_ENV !== env.NEXT_PUBLIC_APP_ENV) {
  errors.push('APP_ENV and NEXT_PUBLIC_APP_ENV must match.');
}
if (env.NEXT_PUBLIC_ARBITRUM_CHAIN_ID && env.NEXT_PUBLIC_ARBITRUM_CHAIN_ID !== '42161') {
  warnings.push('Canonical live payment chain is Arbitrum One 42161.');
}
if (bool('PAYMENTS_ENABLED')) {
  for (const key of [
    'NEXT_PUBLIC_MAGIC_PUBLISHABLE_KEY',
    'MAGIC_SECRET_KEY',
    'MAGIC_CLIENT_ID',
    'NEXT_PUBLIC_PARTICLE_PROJECT_ID',
    'NEXT_PUBLIC_PARTICLE_CLIENT_KEY',
    'NEXT_PUBLIC_PARTICLE_APP_UUID',
    'ARBITRUM_RPC_URL',
    'ARBITRUM_FALLBACK_RPC_URL',
    'NEXT_PUBLIC_CHECKOUT_ADDRESS',
    'NEXT_PUBLIC_PASS_ADDRESS',
    'DATABASE_URL',
    'REDIS_URL',
    'SESSION_HASH_PEPPER',
    'CSRF_SECRET',
    'CAPABILITY_TOKEN_PEPPER',
    'ORDER_SIGNER_MODE',
    'ORDER_SIGNER_ADDRESS',
  ])
    if (missing(key)) errors.push(`PAYMENTS_ENABLED requires ${key}.`);
  if (!bool('PARTICLE_LIVE_ENABLED'))
    errors.push('PAYMENTS_ENABLED requires PARTICLE_LIVE_ENABLED=true.');
  if ((env.PROVIDER_MODE ?? 'deterministic') !== 'live')
    errors.push('PAYMENTS_ENABLED requires PROVIDER_MODE=live.');
  if ((env.NEXT_PUBLIC_ARBITRUM_CHAIN_ID ?? '42161') !== '42161')
    errors.push('PAYMENTS_ENABLED requires Arbitrum One chain ID 42161.');
  if (
    (env.NEXT_PUBLIC_USDC_ADDRESS ?? '').toLowerCase() !==
    '0xaf88d065e77c8cc2239327c5edb3a432268e5831'
  )
    errors.push('PAYMENTS_ENABLED requires native Arbitrum One USDC.');
  if (env.ARBITRUM_RPC_URL === env.ARBITRUM_FALLBACK_RPC_URL)
    errors.push('Primary and fallback Arbitrum RPC URLs must be independent.');
  if (env.ORDER_SIGNER_MODE === 'disabled')
    errors.push('PAYMENTS_ENABLED requires an enabled order signer.');
  if (
    env.ORDER_SIGNER_MODE === 'private-key' &&
    !/^0x[0-9a-fA-F]{64}$/.test(env.ORDER_SIGNER_PRIVATE_KEY ?? '')
  )
    errors.push(
      'Private-key order signer mode requires a valid protected ORDER_SIGNER_PRIVATE_KEY.',
    );
  if (env.ORDER_SIGNER_MODE === 'kms' && missing('ORDER_SIGNER_KMS_KEY_ID'))
    errors.push('KMS order signer mode requires ORDER_SIGNER_KMS_KEY_ID.');
  for (const key of ['NEXT_PUBLIC_CHECKOUT_ADDRESS', 'NEXT_PUBLIC_PASS_ADDRESS']) {
    if (/^0x0{40}$/.test(env[key] ?? ''))
      errors.push(`${key} cannot be the zero address when payments are enabled.`);
  }
}
if (bool('BOOTSTRAP_SPONSOR_ENABLED')) {
  for (const key of [
    'REDIS_URL',
    'SPONSOR_SIGNER_MODE',
    'SPONSOR_MIN_GRANT_WEI',
    'SPONSOR_TARGET_BALANCE_WEI',
    'SPONSOR_PER_GRANT_CAP_WEI',
    'SPONSOR_PER_ADDRESS_DAILY_CAP_WEI',
    'SPONSOR_PER_USER_DAILY_CAP_WEI',
    'SPONSOR_PER_IP_DAILY_CAP_WEI',
    'SPONSOR_PER_DEVICE_DAILY_CAP_WEI',
    'SPONSOR_GLOBAL_DAILY_CAP_WEI',
    'SPONSOR_LOW_BALANCE_ALERT_WEI',
  ]) {
    if (missing(key) || env[key] === '0')
      errors.push(`Bootstrap sponsor requires a non-placeholder ${key}.`);
  }
  if (env.SPONSOR_SIGNER_MODE === 'private-key' && missing('SPONSOR_PRIVATE_KEY'))
    errors.push('Private-key sponsor mode requires protected SPONSOR_PRIVATE_KEY.');
  if (env.SPONSOR_SIGNER_MODE === 'kms' && missing('SPONSOR_KMS_KEY_ID'))
    errors.push('KMS sponsor mode requires SPONSOR_KMS_KEY_ID.');
  const minimum = bigint('SPONSOR_MIN_GRANT_WEI');
  const target = bigint('SPONSOR_TARGET_BALANCE_WEI');
  const grant = bigint('SPONSOR_PER_GRANT_CAP_WEI');
  const addressDaily = bigint('SPONSOR_PER_ADDRESS_DAILY_CAP_WEI');
  const userDaily = bigint('SPONSOR_PER_USER_DAILY_CAP_WEI');
  const ipDaily = bigint('SPONSOR_PER_IP_DAILY_CAP_WEI');
  const deviceDaily = bigint('SPONSOR_PER_DEVICE_DAILY_CAP_WEI');
  const globalDaily = bigint('SPONSOR_GLOBAL_DAILY_CAP_WEI');
  const lowBalanceAlert = bigint('SPONSOR_LOW_BALANCE_ALERT_WEI');
  if (
    minimum > target ||
    target > grant ||
    grant > addressDaily ||
    grant > userDaily ||
    grant > ipDaily ||
    grant > deviceDaily ||
    grant > globalDaily ||
    grant > lowBalanceAlert
  )
    errors.push('Sponsor target and budget caps are internally inconsistent.');
  if (bool('BOOTSTRAP_SPONSOR_ALLOWLIST_ONLY')) {
    const addresses = String(env.SPONSOR_ALLOWED_ADDRESSES ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    if (!addresses.length || addresses.some((value) => !/^0x[0-9a-fA-F]{40}$/.test(value)))
      errors.push('Allowlist-only sponsor requires valid SPONSOR_ALLOWED_ADDRESSES.');
  }
}
if (
  bool('SPLITS_ENABLED') &&
  (/^0x0{40}$/.test(env.NEXT_PUBLIC_SPLIT_ADDRESS ?? '') || missing('NEXT_PUBLIC_SPLIT_ADDRESS'))
) {
  errors.push('SPLITS_ENABLED requires a nonzero NEXT_PUBLIC_SPLIT_ADDRESS.');
}
if (bool('SPLITS_ENABLED') && !bool('PAYMENTS_ENABLED'))
  errors.push('SPLITS_ENABLED requires PAYMENTS_ENABLED=true.');
if ((bool('REFUNDS_ENABLED') || bool('WITHDRAWALS_ENABLED')) && !bool('PAYMENTS_ENABLED'))
  errors.push('Refunds and withdrawals require PAYMENTS_ENABLED=true.');
if (bool('JUDGE_MODE_ENABLED') && missing('JUDGE_SHARE_TOKEN_SECRET'))
  errors.push('JUDGE_MODE_ENABLED requires JUDGE_SHARE_TOKEN_SECRET.');
if (
  bool('JUDGE_MODE_ENABLED') &&
  (env.PROVIDER_MODE ?? 'deterministic') === 'live' &&
  missing('LIVE_ACCEPTANCE_ATTESTATION_SECRET')
)
  errors.push('Live JUDGE_MODE_ENABLED requires LIVE_ACCEPTANCE_ATTESTATION_SECRET.');
for (const key of [
  'SESSION_HASH_PEPPER',
  'CSRF_SECRET',
  'CAPABILITY_TOKEN_PEPPER',
  'PRIVACY_SUBJECT_HASH_SECRET',
  'JUDGE_SHARE_TOKEN_SECRET',
  'LIVE_ACCEPTANCE_ATTESTATION_SECRET',
]) {
  if (!missing(key) && String(env[key]).length < 32)
    errors.push(`${key} must be at least 32 characters.`);
}
const configuredSecuritySecrets = [
  'SESSION_HASH_PEPPER',
  'CSRF_SECRET',
  'CAPABILITY_TOKEN_PEPPER',
  'PRIVACY_SUBJECT_HASH_SECRET',
  'JUDGE_SHARE_TOKEN_SECRET',
  'LIVE_ACCEPTANCE_ATTESTATION_SECRET',
]
  .map((key) => env[key])
  .filter((value) => value && !/REPLACE_ME|REPLACE_WITH/.test(value));
if (new Set(configuredSecuritySecrets).size !== configuredSecuritySecrets.length)
  errors.push('Security peppers and Judge/acceptance secrets must all be independent.');
if (
  (env.APP_ENV ?? 'local') === 'production' &&
  ['private-key'].includes(env.SPONSOR_SIGNER_MODE)
) {
  errors.push('Production cannot use private-key sponsor mode.');
}
if ((env.APP_ENV ?? 'local') === 'production' && ['private-key'].includes(env.ORDER_SIGNER_MODE)) {
  errors.push('Production cannot use private-key order signer mode.');
}
if ((env.APP_ENV ?? 'local') === 'production') {
  for (const key of [
    'NEXT_PUBLIC_MAGIC_PUBLISHABLE_KEY',
    'MAGIC_SECRET_KEY',
    'MAGIC_CLIENT_ID',
    'DATABASE_URL',
    'REDIS_URL',
    'SESSION_HASH_PEPPER',
    'CSRF_SECRET',
    'CAPABILITY_TOKEN_PEPPER',
    'PRIVACY_SUBJECT_HASH_SECRET',
  ]) {
    if (missing(key)) errors.push(`Production requires ${key}.`);
  }
  if (bool('INDEXER_ENABLED')) {
    for (const key of ['ARBITRUM_RPC_URL', 'ARBITRUM_FALLBACK_RPC_URL'])
      if (missing(key)) errors.push(`Production indexer requires ${key}.`);
    if ((env.INDEXER_DEPLOYMENT_BLOCK ?? '0') === '0')
      errors.push('Production indexer requires a nonzero INDEXER_DEPLOYMENT_BLOCK.');
  }
}
for (const [key, value] of Object.entries(env)) {
  if (/PRIVATE_KEY/.test(key) && value && !missing(key))
    warnings.push(`${key} is set; ensure it is only in a secret manager/local ignored file.`);
}

for (const warning of warnings) console.warn(`WARN ${warning}`);
if (errors.length) {
  for (const error of errors) console.error(`ERROR ${error}`);
  process.exit(1);
}
console.log('Environment checks passed for enabled features.');
