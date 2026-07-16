import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const usage = `Usage:
  node scripts/run-controlled-migrations.mjs --check
  MIGRATION_CONFIRMATION=APPLY_REVIEWED_MIGRATIONS \\
  MIGRATION_CHANGE_ID=<reviewed-change> \\
  MIGRATION_BACKUP_ID=<verified-backup> \\
  MIGRATION_EXPECTED_HOST=<database-host> \\
  MIGRATION_EXPECTED_DATABASE=<database-name> \\
  DATABASE_URL_MIGRATIONS=<secret-url> \\
  node scripts/run-controlled-migrations.mjs --apply
`;

if (process.argv.includes('--help')) {
  process.stdout.write(usage);
  process.exit(0);
}

const apply = process.argv.includes('--apply');
const check = process.argv.includes('--check');
if (apply === check) {
  process.stderr.write(usage);
  process.exit(2);
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

const environment = required('APP_ENV');
if (!['local', 'test', 'preview', 'staging', 'demo-mainnet', 'production'].includes(environment)) {
  throw new Error('APP_ENV is not an allowed deployment environment.');
}
const changeId = required('MIGRATION_CHANGE_ID');
const backupId = required('MIGRATION_BACKUP_ID');
for (const [name, value] of [
  ['MIGRATION_CHANGE_ID', changeId],
  ['MIGRATION_BACKUP_ID', backupId],
]) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,119}$/.test(value)) {
    throw new Error(`${name} must be a 3-120 character opaque operational reference.`);
  }
}
if (apply && required('MIGRATION_CONFIRMATION') !== 'APPLY_REVIEWED_MIGRATIONS') {
  throw new Error('MIGRATION_CONFIRMATION must equal APPLY_REVIEWED_MIGRATIONS for --apply.');
}

const rawUrl = required('DATABASE_URL_MIGRATIONS');
let target;
try {
  target = new URL(rawUrl);
} catch {
  throw new Error('DATABASE_URL_MIGRATIONS is not a valid URL.');
}
if (!['postgres:', 'postgresql:'].includes(target.protocol)) {
  throw new Error('DATABASE_URL_MIGRATIONS must use PostgreSQL.');
}
if (
  !target.username ||
  !target.password ||
  !target.hostname ||
  target.pathname.length < 2 ||
  target.hash
) {
  throw new Error('DATABASE_URL_MIGRATIONS must include user, password, host, and database.');
}
const parameterNames = new Set();
for (const [name] of target.searchParams) {
  if (parameterNames.has(name)) {
    throw new Error(`DATABASE_URL_MIGRATIONS repeats connection parameter ${name}.`);
  }
  parameterNames.add(name);
}
const expectedHost = required('MIGRATION_EXPECTED_HOST').toLowerCase();
const expectedDatabase = required('MIGRATION_EXPECTED_DATABASE');
const databaseName = decodeURIComponent(target.pathname.slice(1));
if (target.hostname.toLowerCase() !== expectedHost) {
  throw new Error('Migration host does not match MIGRATION_EXPECTED_HOST.');
}
if (databaseName !== expectedDatabase) {
  throw new Error('Migration database does not match MIGRATION_EXPECTED_DATABASE.');
}
if (environment !== 'local' && environment !== 'test') {
  const sslModes = target.searchParams.getAll('sslmode');
  const sslMode = sslModes[0];
  const privateRailway = target.hostname.endsWith('.railway.internal');
  if (
    !privateRailway &&
    (sslModes.length !== 1 || !['require', 'verify-ca', 'verify-full'].includes(sslMode ?? ''))
  ) {
    throw new Error('Remote migrations require sslmode=require, verify-ca, or verify-full.');
  }
}

const migrationsFolder = path.resolve(import.meta.dirname, '../packages/db/migrations');
const migrationFiles = fs
  .readdirSync(migrationsFolder)
  .filter((name) => /^[0-9]{4}_[A-Za-z0-9_-]+\.sql$/.test(name))
  .sort();
if (migrationFiles.length === 0) throw new Error('No reviewed SQL migrations were found.');

const requireFromDb = createRequire(
  pathToFileURL(path.resolve(import.meta.dirname, '../packages/db/package.json')),
);
const postgresModule = await import(pathToFileURL(requireFromDb.resolve('postgres')).href);
const drizzleModule = await import(
  pathToFileURL(requireFromDb.resolve('drizzle-orm/postgres-js')).href
);
const migratorModule = await import(
  pathToFileURL(requireFromDb.resolve('drizzle-orm/postgres-js/migrator')).href
);
const postgres = postgresModule.default;
const sql = postgres(rawUrl, {
  max: 1,
  connect_timeout: 15,
  idle_timeout: 10,
  max_lifetime: 60,
  onnotice: () => undefined,
});

const advisoryLockId = 7_932_057_182_460_011n;
let locked = false;
try {
  const rows = await sql`select pg_try_advisory_lock(${advisoryLockId}) as locked`;
  locked = rows[0]?.locked === true;
  if (!locked) throw new Error('Another OpenTab migration process holds the advisory lock.');

  const safeSummary = {
    status: apply ? 'applying' : 'checked',
    environment,
    targetHost: expectedHost,
    targetDatabase: expectedDatabase,
    changeId,
    backupId,
    migrationCount: migrationFiles.length,
    lastMigration: migrationFiles.at(-1),
  };
  process.stdout.write(`${JSON.stringify(safeSummary)}\n`);
  if (apply) {
    const db = drizzleModule.drizzle(sql);
    await migratorModule.migrate(db, { migrationsFolder });
    process.stdout.write(
      `${JSON.stringify({ status: 'applied', changeId, migrationCount: migrationFiles.length })}\n`,
    );
  }
} finally {
  if (locked) {
    await sql`select pg_advisory_unlock(${advisoryLockId})`;
  }
  await sql.end({ timeout: 5 });
}
