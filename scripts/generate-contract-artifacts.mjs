import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const contractsRoot = path.join(root, 'packages', 'contracts');
const generator = path.join(contractsRoot, 'scripts', 'generate-artifacts.sh');

if (!fs.existsSync(path.join(contractsRoot, 'out'))) {
  process.stderr.write('Foundry output is missing. Run pnpm contracts:build first.\n');
  process.exit(1);
}
if (!fs.existsSync(generator)) {
  process.stderr.write('The canonical contract artifact generator is missing.\n');
  process.exit(1);
}

const rebuild = spawnSync('forge', ['build', '--force'], {
  cwd: contractsRoot,
  encoding: 'utf8',
  env: process.env,
  stdio: ['ignore', 'pipe', 'pipe'],
});
if (rebuild.error !== undefined) {
  process.stderr.write(`Foundry rebuild could not start: ${rebuild.error.message}\n`);
  process.exit(1);
}
if (rebuild.stdout) process.stdout.write(rebuild.stdout);
if (rebuild.stderr) process.stderr.write(rebuild.stderr);
if (rebuild.status !== 0) process.exit(rebuild.status ?? 1);

const result = spawnSync('bash', [generator], {
  cwd: contractsRoot,
  encoding: 'utf8',
  env: process.env,
  stdio: ['ignore', 'pipe', 'pipe'],
});
if (result.error !== undefined) {
  process.stderr.write(`Contract artifact generation could not start: ${result.error.message}\n`);
  process.exit(1);
}
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.status !== 0) process.exit(result.status ?? 1);

for (const contractName of ['OpenTabCheckout', 'OpenTabPass1155', 'OpenTabSplitReimbursement']) {
  const abiPath = path.join(contractsRoot, 'abi', `${contractName}.json`);
  if (!fs.existsSync(abiPath)) {
    process.stderr.write(`Canonical ABI missing for ${contractName}.\n`);
    process.exit(1);
  }
  const abi = JSON.parse(fs.readFileSync(abiPath, 'utf8'));
  if (!Array.isArray(abi) || abi.length === 0) {
    process.stderr.write(`Canonical ABI for ${contractName} must be a nonempty JSON array.\n`);
    process.exit(1);
  }
}

for (const relativePath of [
  'artifacts/canonical-signatures.json',
  'artifacts/error-selectors.json',
  'artifacts/storage-layout/OpenTabCheckout.json',
  'artifacts/storage-layout/OpenTabPass1155.json',
  'artifacts/storage-layout/OpenTabSplitReimbursement.json',
]) {
  if (!fs.existsSync(path.join(contractsRoot, relativePath))) {
    process.stderr.write(`Canonical contract artifact missing: ${relativePath}.\n`);
    process.exit(1);
  }
}

process.stdout.write('Canonical checkout, pass, and split artifacts generated.\n');
