import fs from 'node:fs';

// biome-ignore lint/suspicious/noUndeclaredEnvVars: standalone operational tool, never a cached Turbo task
const connectionUrl = process.env.DATABASE_SERVICE_URL;
// biome-ignore lint/suspicious/noUndeclaredEnvVars: standalone operational tool, never a cached Turbo task
const outputPath = process.env.DATABASE_SERVICE_OUTPUT;
// biome-ignore lint/suspicious/noUndeclaredEnvVars: standalone operational tool, never a cached Turbo task
const serviceName = process.env.DATABASE_SERVICE_NAME;
// biome-ignore lint/suspicious/noUndeclaredEnvVars: standalone operational tool, never a cached Turbo task
const passwordOutputPath = process.env.DATABASE_SERVICE_PASSWORD_OUTPUT;

if (!connectionUrl || !outputPath || !serviceName || !passwordOutputPath) {
  throw new Error(
    'DATABASE_SERVICE_URL, DATABASE_SERVICE_OUTPUT, DATABASE_SERVICE_PASSWORD_OUTPUT, and DATABASE_SERVICE_NAME are required.',
  );
}
if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(serviceName)) {
  throw new Error('DATABASE_SERVICE_NAME is invalid.');
}

let url;
try {
  url = new URL(connectionUrl);
} catch {
  throw new Error('DATABASE_SERVICE_URL is not a valid URL.');
}
if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
  throw new Error('DATABASE_SERVICE_URL must use PostgreSQL.');
}
if (!url.username || !url.hostname || url.pathname.length < 2 || url.hash) {
  throw new Error('DATABASE_SERVICE_URL must include user, host, and database without a fragment.');
}

const allowedParameters = new Set([
  'application_name',
  'channel_binding',
  'connect_timeout',
  'sslmode',
  'target_session_attrs',
]);
const parameterNames = new Set();
for (const [key] of url.searchParams) {
  if (parameterNames.has(key)) {
    throw new Error(`DATABASE_SERVICE_URL repeats connection parameter ${key}.`);
  }
  parameterNames.add(key);
}
const database = decodeURIComponent(url.pathname.slice(1));
const user = decodeURIComponent(url.username);
const hostname = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
if (!/^[A-Za-z0-9_.-]{1,128}$/.test(database) || !/^[A-Za-z0-9_.-]{1,128}$/.test(user)) {
  throw new Error('Database and user names must use safe libpq service characters.');
}
const entries = [
  ['host', hostname],
  ['port', url.port || '5432'],
  ['dbname', database],
  ['user', user],
  ['passfile', passwordOutputPath],
];
for (const [key, value] of url.searchParams) {
  if (!allowedParameters.has(key)) {
    throw new Error(`DATABASE_SERVICE_URL uses unsupported connection parameter ${key}.`);
  }
  entries.push([key, value]);
}

function serviceValue(value) {
  if (!/^[A-Za-z0-9_./:[\]-]+$/.test(value)) {
    throw new Error('Database connection fields contain unsupported service-file characters.');
  }
  return value;
}

const content = [
  `[${serviceName}]`,
  ...entries.map(([key, value]) => `${key}=${serviceValue(value)}`),
  '',
].join('\n');
fs.writeFileSync(outputPath, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
const pgpassValue = (value) => value.replaceAll('\\', '\\\\').replaceAll(':', '\\:');
const passwordLine = [
  hostname,
  url.port || '5432',
  database,
  user,
  decodeURIComponent(url.password),
]
  .map(pgpassValue)
  .join(':');
fs.writeFileSync(passwordOutputPath, `${passwordLine}\n`, {
  encoding: 'utf8',
  mode: 0o600,
  flag: 'wx',
});
