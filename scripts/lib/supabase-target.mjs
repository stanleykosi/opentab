const SUPABASE_PROJECT_REF = /^[a-z0-9]{8,40}$/;
const DIRECT_HOST = /^db\.([a-z0-9]{8,40})\.supabase\.co$/;
const POOLER_HOST = /^[a-z0-9-]+\.pooler\.supabase\.com$/;
const ALLOWED_SSL_MODES = new Set(['require', 'verify-ca', 'verify-full']);

export class SupabaseTargetConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SupabaseTargetConfigurationError';
  }
}

function invalid(name, reason) {
  throw new SupabaseTargetConfigurationError(`${name} ${reason}`);
}

function parseUrl(name, raw) {
  if (typeof raw !== 'string' || raw.trim() === '') invalid(name, 'is required.');

  let url;
  try {
    url = new URL(raw);
  } catch {
    invalid(name, 'must be a valid PostgreSQL URL.');
  }

  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    invalid(name, 'must use the PostgreSQL protocol.');
  }
  if (!url.username || !url.password || !url.hostname || !url.port || url.hash) {
    invalid(name, 'must include authenticated host, explicit port, database, and no fragment.');
  }

  let database;
  try {
    database = decodeURIComponent(url.pathname.slice(1));
  } catch {
    invalid(name, 'contains an invalid encoded database name.');
  }
  if (database !== 'postgres') invalid(name, 'must target the dedicated project database postgres.');

  const parameters = new Set();
  for (const [parameter] of url.searchParams) {
    if (parameters.has(parameter)) invalid(name, `repeats connection parameter ${parameter}.`);
    parameters.add(parameter);
    if (parameter !== 'sslmode') invalid(name, `contains unsupported connection parameter ${parameter}.`);
  }
  const sslModes = url.searchParams.getAll('sslmode');
  if (sslModes.length !== 1 || !ALLOWED_SSL_MODES.has(sslModes[0])) {
    invalid(name, 'must set exactly one sslmode=require, verify-ca, or verify-full.');
  }

  return url;
}

function poolerIdentity(name, url) {
  if (!POOLER_HOST.test(url.hostname)) invalid(name, 'must use an official Supabase host.');
  const separator = url.username.lastIndexOf('.');
  if (separator <= 0 || separator === url.username.length - 1) {
    invalid(name, 'must use the Supavisor username format role.project_ref.');
  }
  const role = url.username.slice(0, separator);
  const projectRef = url.username.slice(separator + 1);
  if (!SUPABASE_PROJECT_REF.test(projectRef)) invalid(name, 'contains an invalid project reference.');
  return { role, projectRef };
}

function describe(name, raw, expectedRole, allowedModes) {
  const url = parseUrl(name, raw);
  const direct = DIRECT_HOST.exec(url.hostname);
  let mode;
  let role;
  let projectRef;

  if (direct !== null) {
    if (url.port !== '5432') invalid(name, 'direct connections must use port 5432.');
    mode = 'direct';
    role = url.username;
    projectRef = direct[1];
  } else {
    const identity = poolerIdentity(name, url);
    role = identity.role;
    projectRef = identity.projectRef;
    if (url.port === '6543') mode = 'transaction-pooler';
    else if (url.port === '5432') mode = 'session-pooler';
    else invalid(name, 'Supavisor connections must use port 6543 or 5432.');
  }

  if (!allowedModes.includes(mode)) {
    invalid(name, `must use ${allowedModes.join(' or ')} mode.`);
  }
  if (role !== expectedRole) invalid(name, `must authenticate as ${expectedRole}.`);

  return { name, mode, role, projectRef };
}

export function verifySupabaseTarget(environment) {
  const connections = [
    describe(
      'DATABASE_URL',
      environment.DATABASE_URL,
      'opentab_runtime',
      ['transaction-pooler'],
    ),
    describe(
      'DATABASE_URL_INDEXER',
      environment.DATABASE_URL_INDEXER,
      'opentab_indexer',
      ['direct', 'session-pooler'],
    ),
    describe(
      'DATABASE_URL_MIGRATIONS',
      environment.DATABASE_URL_MIGRATIONS,
      'postgres',
      ['direct', 'session-pooler'],
    ),
    describe(
      'DATABASE_URL_EVIDENCE_WRITER',
      environment.DATABASE_URL_EVIDENCE_WRITER,
      'opentab_evidence_writer',
      ['direct', 'session-pooler'],
    ),
  ];

  const projectRefs = new Set(connections.map((connection) => connection.projectRef));
  if (projectRefs.size !== 1) {
    throw new SupabaseTargetConfigurationError(
      'All OpenTab PostgreSQL credentials must target the same Supabase project.',
    );
  }
  const roles = new Set(connections.map((connection) => connection.role));
  if (roles.size !== connections.length) {
    throw new SupabaseTargetConfigurationError(
      'Web, indexer, migration, and evidence-writer credentials must use distinct roles.',
    );
  }

  return Object.freeze({
    projectRef: connections[0].projectRef,
    modes: Object.freeze(
      Object.fromEntries(connections.map((connection) => [connection.name, connection.mode])),
    ),
  });
}

export function supabaseTemplateEnvironment() {
  const ref = 'abcdefghijklmnopqrst';
  const pooler = 'aws-0-example-1.pooler.supabase.com';
  const password = 'template-only-password-not-a-secret';
  return {
    DATABASE_URL: `postgresql://opentab_runtime.${ref}:${password}@${pooler}:6543/postgres?sslmode=verify-full`,
    DATABASE_URL_INDEXER: `postgresql://opentab_indexer.${ref}:${password}@${pooler}:5432/postgres?sslmode=verify-full`,
    DATABASE_URL_MIGRATIONS: `postgresql://postgres.${ref}:${password}@${pooler}:5432/postgres?sslmode=verify-full`,
    DATABASE_URL_EVIDENCE_WRITER: `postgresql://opentab_evidence_writer.${ref}:${password}@${pooler}:5432/postgres?sslmode=verify-full`,
  };
}
