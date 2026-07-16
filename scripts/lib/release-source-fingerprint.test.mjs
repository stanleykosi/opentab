import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { computeReleaseSourceFingerprint } from './release-source-fingerprint.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opentab-release-fingerprint-'));
  for (const entry of [
    '.github',
    'apps',
    'openapi',
    'packages',
    'patches',
    'scripts',
    'spikes',
  ]) {
    fs.mkdirSync(path.join(root, entry), { recursive: true });
    fs.writeFileSync(path.join(root, entry, 'fixture.txt'), entry);
  }
  for (const entry of [
    '.node-version',
    '.nvmrc',
    'biome.json',
    'docker-compose.yml',
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'railway.indexer.json',
    'tsconfig.base.json',
    'turbo.json',
  ]) {
    fs.writeFileSync(path.join(root, entry), entry);
  }
  return root;
}

test('fingerprint is stable and changes when release source changes', () => {
  const root = fixture();
  try {
    const first = computeReleaseSourceFingerprint(root);
    assert.deepEqual(computeReleaseSourceFingerprint(root), first);
    fs.appendFileSync(path.join(root, 'apps', 'fixture.txt'), '-changed');
    assert.notEqual(computeReleaseSourceFingerprint(root).sha256, first.sha256);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fingerprint excludes generated output and private environment files', () => {
  const root = fixture();
  try {
    const first = computeReleaseSourceFingerprint(root);
    fs.mkdirSync(path.join(root, 'apps', 'dist'), { recursive: true });
    fs.writeFileSync(path.join(root, 'apps', 'dist', 'bundle.js'), 'generated');
    fs.writeFileSync(path.join(root, 'apps', '.env.production'), 'SECRET=value');
    assert.deepEqual(computeReleaseSourceFingerprint(root), first);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
