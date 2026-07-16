import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'opentab-ops-check-'));
const serviceFile = path.join(temporaryDirectory, 'pg_service.conf');
const passwordFile = path.join(temporaryDirectory, 'pgpass');
const fakePassword = 'not-a-real:password\\value';

try {
  const helper = spawnSync(process.execPath, ['scripts/write-libpq-service.mjs'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      DATABASE_SERVICE_URL: `postgresql://opentab:${encodeURIComponent(fakePassword)}@[::1]:5433/opentab?sslmode=verify-full`,
      DATABASE_SERVICE_OUTPUT: serviceFile,
      DATABASE_SERVICE_PASSWORD_OUTPUT: passwordFile,
      DATABASE_SERVICE_NAME: 'opentab_test',
    },
  });
  if (helper.status !== 0) throw new Error('The libpq service helper failed its self-test.');
  const service = fs.readFileSync(serviceFile, 'utf8');
  const password = fs.readFileSync(passwordFile, 'utf8');
  if (service.includes(fakePassword) || !service.includes(`passfile=${passwordFile}`)) {
    throw new Error('The libpq service file exposed a password or omitted its passfile.');
  }
  if (!service.includes('host=::1') || !password.startsWith('\\:\\:1:5433:')) {
    throw new Error('The libpq credential files did not normalize and escape an IPv6 host.');
  }
  if (!password.endsWith(':not-a-real\\:password\\\\value\n')) {
    throw new Error('The libpq password file did not escape delimiters correctly.');
  }
  for (const file of [serviceFile, passwordFile]) {
    if ((fs.statSync(file).mode & 0o777) !== 0o600) {
      throw new Error('A libpq credential file is not mode 0600.');
    }
  }

  const duplicateParameterServiceFile = path.join(temporaryDirectory, 'duplicate.conf');
  const duplicateParameterPasswordFile = path.join(temporaryDirectory, 'duplicate.pgpass');
  const ambiguousConnection = spawnSync(process.execPath, ['scripts/write-libpq-service.mjs'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      DATABASE_SERVICE_URL:
        'postgresql://opentab:example@db.example.test:5432/opentab?sslmode=require&sslmode=disable',
      DATABASE_SERVICE_OUTPUT: duplicateParameterServiceFile,
      DATABASE_SERVICE_PASSWORD_OUTPUT: duplicateParameterPasswordFile,
      DATABASE_SERVICE_NAME: 'opentab_ambiguous',
    },
  });
  if (
    ambiguousConnection.status === 0 ||
    !ambiguousConnection.stderr.includes('repeats connection parameter sslmode')
  ) {
    throw new Error('The libpq helper did not reject an ambiguous duplicate TLS parameter.');
  }

  const shellSyntax = spawnSync(
    'bash',
    ['-n', 'scripts/backup-postgres.sh', 'scripts/restore-postgres.sh', 'scripts/smoke-demo.sh'],
    { cwd: root, encoding: 'utf8' },
  );
  if (shellSyntax.status !== 0) throw new Error('An operational shell script has invalid syntax.');
  const backupSource = fs.readFileSync(path.join(root, 'scripts/backup-postgres.sh'), 'utf8');
  const restoreSource = fs.readFileSync(path.join(root, 'scripts/restore-postgres.sh'), 'utf8');
  if (
    !backupSource.includes('sha256sum -- "$archive_name"') ||
    backupSource.includes('sha256sum -- "$archive"') ||
    !restoreSource.includes('cd "$archive_directory"')
  ) {
    throw new Error('Backup checksums are not portable with an archive/sidecar move.');
  }

  const unsafeSmokeTarget = spawnSync(
    'bash',
    ['scripts/smoke-demo.sh', 'http://localhost:3000@external.example'],
    { cwd: root, encoding: 'utf8' },
  );
  if (unsafeSmokeTarget.status !== 2 || !unsafeSmokeTarget.stderr.includes('exact loopback host')) {
    throw new Error('The demo smoke script did not reject a credential-confused plaintext URL.');
  }

  const unsafeDeploymentTarget = spawnSync(
    process.execPath,
    ['scripts/verify-deployment.mjs', '--web'],
    {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, OPENTAB_BASE_URL: 'https://external.example/unexpected-path' },
    },
  );
  if (
    unsafeDeploymentTarget.status === 0 ||
    !unsafeDeploymentTarget.stderr.includes('credential-free origin')
  ) {
    throw new Error('Deployment verification did not reject a non-origin target URL.');
  }

  const deploymentVerifier = fs.readFileSync(
    path.join(root, 'scripts/verify-deployment.mjs'),
    'utf8',
  );
  for (const requiredReadiness of [
    "ready.body?.status !== 'ready'",
    "ready.body?.dependencies?.database !== 'ready'",
    "ready.body?.dependencies?.redis !== 'ready'",
  ]) {
    if (!deploymentVerifier.includes(requiredReadiness)) {
      throw new Error('Deployment verification does not enforce dependency readiness.');
    }
  }
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}

process.stdout.write('Operational backup/restore safeguards passed.\n');
