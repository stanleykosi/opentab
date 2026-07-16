import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SupabaseTargetConfigurationError,
  supabaseTemplateEnvironment,
  verifySupabaseTarget,
} from './supabase-target.mjs';

test('accepts the serverless transaction and durable session pooler topology', () => {
  const result = verifySupabaseTarget(supabaseTemplateEnvironment());
  assert.deepEqual(result.modes, {
    DATABASE_URL: 'transaction-pooler',
    DATABASE_URL_INDEXER: 'session-pooler',
    DATABASE_URL_MIGRATIONS: 'session-pooler',
    DATABASE_URL_EVIDENCE_WRITER: 'session-pooler',
  });
});

test('accepts direct IPv6-capable durable and administrative connections', () => {
  const environment = supabaseTemplateEnvironment();
  const directHost = 'db.abcdefghijklmnopqrst.supabase.co';
  environment.DATABASE_URL_INDEXER = `postgresql://opentab_indexer:encoded-password@${directHost}:5432/postgres?sslmode=verify-full`;
  environment.DATABASE_URL_MIGRATIONS = `postgresql://postgres:encoded-password@${directHost}:5432/postgres?sslmode=verify-full`;
  environment.DATABASE_URL_EVIDENCE_WRITER = `postgresql://opentab_evidence_writer:encoded-password@${directHost}:5432/postgres?sslmode=verify-full`;

  assert.equal(verifySupabaseTarget(environment).modes.DATABASE_URL_INDEXER, 'direct');
});

test('requires the web runtime to use the transaction pooler', () => {
  const environment = supabaseTemplateEnvironment();
  environment.DATABASE_URL = environment.DATABASE_URL.replace(':6543/', ':5432/');
  assert.throws(
    () => verifySupabaseTarget(environment),
    /DATABASE_URL must use transaction-pooler mode/,
  );
});

test('rejects plaintext, missing, duplicated, and unsupported TLS parameters', () => {
  for (const suffix of [
    '',
    '?sslmode=disable',
    '?sslmode=require&sslmode=verify-full',
    '?sslmode=require&options=-csearch_path%3Dpg_catalog',
  ]) {
    const environment = supabaseTemplateEnvironment();
    environment.DATABASE_URL = environment.DATABASE_URL.replace('?sslmode=verify-full', suffix);
    assert.throws(() => verifySupabaseTarget(environment), SupabaseTargetConfigurationError);
  }
});

test('rejects cross-project credentials and incorrect least-privilege roles', () => {
  const crossProject = supabaseTemplateEnvironment();
  crossProject.DATABASE_URL_INDEXER = crossProject.DATABASE_URL_INDEXER.replace(
    'abcdefghijklmnopqrst',
    'differentprojectref12',
  );
  assert.throws(() => verifySupabaseTarget(crossProject), /same Supabase project/);

  const reusedRole = supabaseTemplateEnvironment();
  reusedRole.DATABASE_URL_INDEXER = reusedRole.DATABASE_URL_INDEXER.replace(
    'opentab_indexer',
    'opentab_runtime',
  );
  assert.throws(() => verifySupabaseTarget(reusedRole), /authenticate as opentab_indexer/);
});

test('never includes a connection secret in a validation error', () => {
  const environment = supabaseTemplateEnvironment();
  const secret = 'sensitive-password-marker';
  environment.DATABASE_URL = `postgresql://opentab_runtime.abcdefghijklmnopqrst:${secret}@attacker.example:6543/postgres?sslmode=require`;
  let message = '';
  try {
    verifySupabaseTarget(environment);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert.ok(message.length > 0);
  assert.equal(message.includes(secret), false);
  assert.equal(message.includes('attacker.example'), false);
});
