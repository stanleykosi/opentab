import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = dirname(dirname(packageRoot));
const smokeRoot = join(repositoryRoot, '.deploy-smoke');
await mkdir(smokeRoot, { recursive: true, mode: 0o700 });
const temporaryRoot = await mkdtemp(join(smokeRoot, 'indexer-packaged-'));
const deploymentRoot = join(temporaryRoot, 'indexer');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    timeout: 120_000,
    ...options,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      [
        `Command failed (${result.status ?? 'signal'}): ${command} ${args.join(' ')}`,
        result.stdout,
        result.stderr,
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }
  return result;
}

try {
  if (process.versions.node.split('.')[0] !== '25') {
    throw new Error(`Packaged indexer verification requires Node 25; received ${process.version}`);
  }
  run(
    pnpm,
    [
      '--prefer-offline',
      '--package-import-method=hardlink',
      '--filter',
      '@opentab/indexer',
      'deploy',
      '--prod',
      deploymentRoot,
    ],
    {
      timeout: 120_000,
      env: {
        ...process.env,
        XDG_CACHE_HOME: join(temporaryRoot, 'empty-metadata-cache'),
      },
    },
  );
  const deployedPackage = JSON.parse(await readFile(join(deploymentRoot, 'package.json'), 'utf8'));
  if (deployedPackage.name !== '@opentab/indexer' || deployedPackage.type !== 'module') {
    throw new Error('The deployed indexer package metadata is invalid');
  }
  await Promise.all([
    readFile(join(deploymentRoot, 'dist', 'index.js')),
    readFile(join(deploymentRoot, 'dist', 'db-runtime.js')),
  ]);
  const runtime = run(process.execPath, [join(deploymentRoot, 'dist', 'index.js')], {
    env: {
      APP_ENV: 'production',
      INDEXER_ENABLED: 'false',
      INDEXER_RECONCILIATION_ENABLED: 'false',
      INDEXER_WRITES_ENABLED: 'false',
      LOG_LEVEL: 'info',
      NODE_ENV: 'production',
      NO_COLOR: '1',
      PATH: process.env.PATH ?? '',
    },
    timeout: 15_000,
  });
  const output = `${runtime.stdout}\n${runtime.stderr}`;
  if (!output.includes('OpenTab indexer is disabled') || !output.includes('"status":"disabled"')) {
    throw new Error(`Packaged indexer did not report its disabled state:\n${output}`);
  }
  if (/Dynamic require|startup-failed|ERR_REQUIRE_ESM/.test(output)) {
    throw new Error(`Packaged indexer emitted a module-loader failure:\n${output}`);
  }
  process.stdout.write(
    `${JSON.stringify({
      status: 'passed',
      node: process.version,
      package: deployedPackage.name,
      mode: 'production-disabled',
    })}\n`,
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
