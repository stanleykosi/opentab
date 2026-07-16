import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import {
  allowedDependencyAdvisory,
  collectProductionPackageVersions,
  verifyBulkAdvisoryReport,
} from './lib/dependency-audit.mjs';
import { MAX_AUDIT_RESPONSE_BYTES, requestNpmBulkAdvisories } from './lib/npm-audit-transport.mjs';

const root = path.resolve(import.meta.dirname, '..');
const allowedAdvisory = Object.freeze({
  ...allowedDependencyAdvisory,
  cve: 'CVE-2025-3194',
  waiver: 'QW-002',
  expiresAt: '2026-08-13',
});

function fail(message) {
  process.stderr.write(`Dependency audit gate failed: ${message}\n`);
  process.exit(1);
}

function parseArguments(argv) {
  let output = path.join(
    root,
    'artifacts',
    'autonomous-build',
    'test-results',
    'dependency-audit.json',
  );
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') {
      process.stdout.write(
        'Usage: node scripts/verify-dependency-audit.mjs [--output <audit-json-path>]\n',
      );
      process.exit(0);
    }
    if (argument !== '--output') fail(`unknown argument ${argument ?? '<missing>'}.`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) fail('--output requires a path.');
    output = path.resolve(root, value);
    index += 1;
  }
  return { output };
}

function readProductionInventory() {
  const result = spawnSync(
    'pnpm',
    ['list', '--recursive', '--prod', '--depth', 'Infinity', '--json'],
    {
      cwd: root,
      encoding: 'utf8',
      env: process.env,
      maxBuffer: 128 * 1024 * 1024,
      shell: false,
    },
  );
  if (result.error !== undefined) fail(`pnpm list could not start: ${result.error.message}`);
  if (result.signal !== null) fail(`pnpm list was terminated by ${result.signal}.`);
  if (result.status !== 0) fail(`pnpm list exited ${String(result.status)}.`);
  if (result.stdout.trim().length === 0) fail('pnpm list returned an empty inventory.');
  try {
    const inventory = collectProductionPackageVersions(JSON.parse(result.stdout));
    const packageVersionCount = Object.values(inventory).reduce(
      (total, versions) => total + versions.length,
      0,
    );
    if (packageVersionCount < 100) fail('production dependency inventory is unexpectedly small.');
    return { inventory, packageVersionCount };
  } catch {
    fail('pnpm list returned malformed or unsupported dependency JSON.');
  }
}

async function runAudit(inventory) {
  const endpoint = 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk';
  let response;
  try {
    response = await requestNpmBulkAdvisories({ endpoint, body: JSON.stringify(inventory) });
  } catch (error) {
    fail(error instanceof Error ? error.message : 'npm bulk advisory request failed.');
  }
  const { raw } = response;
  if (!response.ok) fail(`npm bulk advisory endpoint returned HTTP ${response.status}.`);
  if (raw.length === 0) fail('npm bulk advisory endpoint returned an empty report.');
  if (Buffer.byteLength(raw, 'utf8') > MAX_AUDIT_RESPONSE_BYTES) {
    fail('npm bulk advisory report exceeded 16 MiB.');
  }
  try {
    return { endpoint, raw, report: JSON.parse(raw) };
  } catch {
    fail('npm bulk advisory endpoint returned malformed JSON.');
  }
}

function verifyWaiver() {
  const waiver = fs.readFileSync(
    path.join(root, 'docs', '06-quality', 'QUALITY_WAIVERS.md'),
    'utf8',
  );
  if (!waiver.includes(`## ${allowedAdvisory.waiver} —`)) {
    fail(`${allowedAdvisory.waiver} is not documented.`);
  }
  for (const identifier of [allowedAdvisory.ghsa, allowedAdvisory.cve]) {
    if (!waiver.includes(identifier))
      fail(`${allowedAdvisory.waiver} does not bind ${identifier}.`);
  }
  const expiry = waiver.match(
    new RegExp(`## ${allowedAdvisory.waiver}[^]*?- Expiry: (\\d{4}-\\d{2}-\\d{2})(?:\\s|$)`),
  )?.[1];
  if (expiry !== allowedAdvisory.expiresAt) {
    fail(`${allowedAdvisory.waiver} expiry drifted from ${allowedAdvisory.expiresAt}.`);
  }
  const expiryInstant = Date.parse(`${expiry}T23:59:59.999Z`);
  if (!Number.isFinite(expiryInstant) || Date.now() > expiryInstant) {
    fail(`${allowedAdvisory.waiver} expired on ${String(expiry)}.`);
  }
}

function verifyPatchedDependency() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (
    packageJson.pnpm?.patchedDependencies?.['bigint-buffer@1.1.5'] !==
    'patches/bigint-buffer@1.1.5.patch'
  ) {
    fail('package.json does not pin the reviewed bigint-buffer patch.');
  }
  const patch = fs.readFileSync(path.join(root, 'patches', 'bigint-buffer@1.1.5.patch'), 'utf8');
  if (!patch.includes("-    converter = require('bindings')('bigint_buffer');")) {
    fail('the reviewed patch no longer removes native binding loading.');
  }

  let dependencyRequire = createRequire(
    path.join(root, 'packages', 'integrations', 'package.json'),
  );
  for (const dependency of [
    '@particle-network/universal-account-sdk',
    '@solana/spl-token',
    '@solana/buffer-layout-utils',
  ]) {
    let resolved;
    try {
      resolved = dependencyRequire.resolve(dependency);
    } catch {
      fail(`the locked Particle dependency path no longer resolves ${dependency}.`);
    }
    dependencyRequire = createRequire(resolved);
  }

  let entry;
  try {
    entry = dependencyRequire.resolve('bigint-buffer');
  } catch {
    fail('the locked Particle dependency path no longer resolves bigint-buffer.');
  }
  const normalizedEntry = entry.split(path.sep).join('/');
  if (!normalizedEntry.includes('bigint-buffer@1.1.5_patch_hash=')) {
    fail('the active bigint-buffer resolution is not the pinned patched package.');
  }
  const entrySource = fs.readFileSync(entry, 'utf8');
  if (entrySource.includes("require('bindings')('bigint_buffer')")) {
    fail('the active bigint-buffer entry still loads the vulnerable native binding.');
  }
  const packageDirectory = path.resolve(path.dirname(entry), '..');
  const packageManifest = JSON.parse(
    fs.readFileSync(path.join(packageDirectory, 'package.json'), 'utf8'),
  );
  if (packageManifest.version !== allowedAdvisory.version) {
    fail(`the active bigint-buffer version is ${String(packageManifest.version)}.`);
  }
  if (String(packageManifest.scripts?.install ?? '').includes('rebuild')) {
    fail('the active bigint-buffer install script can still build the native addon.');
  }
  const nativeArtifacts = [];
  const visit = (directory) => {
    if (!fs.existsSync(directory)) return;
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const itemPath = path.join(directory, item.name);
      if (item.isDirectory()) visit(itemPath);
      else if (item.isFile() && item.name.endsWith('.node')) nativeArtifacts.push(itemPath);
    }
  };
  visit(packageDirectory);
  if (nativeArtifacts.length > 0) fail('the active bigint-buffer package contains a native addon.');

  const conversion = dependencyRequire('bigint-buffer');
  const sample = 0x0102030405060708090a0b0c0d0e0fn;
  const width = 16;
  if (conversion.toBigIntBE(conversion.toBufferBE(sample, width)) !== sample) {
    fail('big-endian bigint-buffer JavaScript roundtrip failed.');
  }
  if (conversion.toBigIntLE(conversion.toBufferLE(sample, width)) !== sample) {
    fail('little-endian bigint-buffer JavaScript roundtrip failed.');
  }
}

const { output } = parseArguments(process.argv.slice(2));
verifyWaiver();
verifyPatchedDependency();
const { inventory, packageVersionCount } = readProductionInventory();
const { endpoint, report } = await runAudit(inventory);
let allowedCount;
try {
  ({ allowedCount } = verifyBulkAdvisoryReport(report));
} catch (error) {
  fail(error instanceof Error ? error.message : 'bulk advisory report validation failed.');
}
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(
  output,
  `${JSON.stringify({ endpoint, packageVersionCount, advisories: report }, null, 2)}\n`,
  { encoding: 'utf8', mode: 0o600 },
);
process.stdout.write(
  `Dependency audit gate passed for ${packageVersionCount} production package versions; ${allowedCount} exact unexpired patched waiver applied.\n`,
);
