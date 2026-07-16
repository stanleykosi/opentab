import type { ArbitrumReadPort } from '@opentab/application';
import { describe, expect, it, vi } from 'vitest';
import {
  createProductionIndexerDependencies,
  type IndexerChainFactory,
} from '../src/composition.js';

const address = (digit: string) => `0x${digit.repeat(40)}`;

function environment(): Record<string, string> {
  return {
    APP_ENV: 'test',
    NEXT_PUBLIC_APP_ENV: 'test',
    NEXT_PUBLIC_APP_ORIGIN: 'http://localhost:3000',
    INDEXER_ENABLED: 'true',
    INDEXER_WRITES_ENABLED: 'true',
    DATABASE_URL_INDEXER: 'postgres://opentab_indexer@localhost:5432/opentab',
    REDIS_URL: 'redis://localhost:6379',
    ARBITRUM_RPC_URL: 'http://rpc-primary.test',
    ARBITRUM_FALLBACK_RPC_URL: 'http://rpc-fallback.test',
    NEXT_PUBLIC_CHECKOUT_ADDRESS: address('1'),
    NEXT_PUBLIC_PASS_ADDRESS: address('2'),
    NEXT_PUBLIC_SPLIT_ADDRESS: address('3'),
    PARTICLE_EIP7702_IMPLEMENTATION_ADDRESS: address('4'),
    PARTICLE_EIP7702_IMPLEMENTATION_CODE_HASH: `0x${'5'.repeat(64)}`,
    PARTICLE_LIVE_ENABLED: 'true',
    NEXT_PUBLIC_PARTICLE_PROJECT_ID: 'particle-project-indexer',
    NEXT_PUBLIC_PARTICLE_CLIENT_KEY: 'particle-client-indexer',
    NEXT_PUBLIC_PARTICLE_APP_UUID: 'particle-app-indexer',
    PARTICLE_ALLOWED_SOURCE_TOKENS: `8453:USDC:${address('6')}`,
    PARTICLE_SOURCE_CALL_PROFILES_JSON: JSON.stringify([
      {
        profileId: 'base-source-call-v1',
        chainId: '8453',
        asset: 'USDC',
        tokenAddress: address('6'),
        sourceAmount: '1',
        fixtureDigest: `0x${'a'.repeat(64)}`,
        calls: [
          {
            uaType: 'evm',
            to: address('6'),
            data: '0x1234',
            valueWei: '0',
          },
        ],
      },
    ]),
    PARTICLE_RESPONSE_PROFILE_PROVENANCE: 'recorded_live',
    PARTICLE_RESPONSE_PROFILE_ID: 'indexer-recorded-live-v1',
    PARTICLE_DEPLOYMENTS_FIXTURE_DIGEST: `0x${'6'.repeat(64)}`,
    PARTICLE_AUTH_FIXTURE_DIGEST: `0x${'7'.repeat(64)}`,
    PARTICLE_SUBMISSION_FIXTURE_DIGEST: `0x${'8'.repeat(64)}`,
    PARTICLE_STATUS_FIXTURE_DIGEST: `0x${'9'.repeat(64)}`,
    PARTICLE_MAGIC_AUTHORIZATION_NONCE_OFFSET: '0',
    PARTICLE_DELEGATION_PLAN_TTL_SECONDS: '300',
    INDEXER_DEPLOYMENT_BLOCK: '1234',
    INDEXER_MAX_BLOCK_RANGE: '250',
    INDEXER_RPC_TIMEOUT_MS: '9000',
  };
}

describe('production indexer composition', () => {
  it('creates independent preferred RPC legs from validated enabled configuration', () => {
    const chain = {} as ArbitrumReadPort;
    const factory = vi.fn((_: Parameters<IndexerChainFactory>[0]) => chain);
    const dependencies = createProductionIndexerDependencies(environment(), factory);

    expect(dependencies).toMatchObject({
      primaryChain: chain,
      fallbackChain: chain,
      reconciliation: { redisUrl: 'redis://localhost:6379' },
    });
    expect(factory).toHaveBeenCalledTimes(2);
    expect(factory.mock.calls[0]?.[0]).toMatchObject({
      primaryRpcUrl: 'http://rpc-primary.test',
      fallbackRpcUrl: 'http://rpc-fallback.test',
      deploymentBlock: 1234n,
      maxLogRange: 250n,
      requestTimeoutMs: 9000,
    });
    expect(factory.mock.calls[1]?.[0]).toMatchObject({
      primaryRpcUrl: 'http://rpc-fallback.test',
      fallbackRpcUrl: 'http://rpc-primary.test',
    });
  });

  it('fails closed when the enabled executable has no live RPC or database', () => {
    const env = environment();
    delete env['DATABASE_URL_INDEXER'];
    expect(() => createProductionIndexerDependencies(env, vi.fn())).toThrow(/PostgreSQL/);
  });

  it('accepts production without any web authentication or session secrets', () => {
    const env = {
      ...environment(),
      APP_ENV: 'production',
      DATABASE_URL_INDEXER:
        'postgresql://indexer:secret@db.example:5432/opentab?sslmode=verify-full',
      REDIS_URL: 'redis://default:test-password@redis.railway.internal:6379',
      ARBITRUM_RPC_URL: 'https://arb-primary.example/rpc',
      ARBITRUM_FALLBACK_RPC_URL: 'https://arb-fallback.example/rpc',
      INDEXER_DEPLOYMENT_BLOCK: '1234',
    };
    for (const webOnly of [
      'MAGIC_SECRET_KEY',
      'MAGIC_CLIENT_ID',
      'SESSION_HASH_PEPPER',
      'CSRF_SECRET',
      'CAPABILITY_TOKEN_PEPPER',
      'PRIVACY_SUBJECT_HASH_SECRET',
      'JUDGE_SHARE_TOKEN_SECRET',
    ]) {
      delete env[webOnly as keyof typeof env];
    }
    expect(() =>
      createProductionIndexerDependencies(
        env,
        vi.fn(() => ({}) as ArbitrumReadPort),
      ),
    ).not.toThrow();
  });
});
