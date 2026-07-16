import type {
  ArbitrumReadPort,
  BackendApiQueryPort,
  PublicBrowserConfig,
  UniversalOperationPort,
} from '@opentab/application';
import type { PostgresBackendApiStore } from '@opentab/db';
import { CurrentUserSchema, EvmAddressSchema, UserIdSchema } from '@opentab/shared';
import { describe, expect, it } from 'vitest';
import { LiveBackendApiResourceQueries } from '../app/api/_lib/live-resource-queries.js';

const owner = EvmAddressSchema.parse(`0x${'1'.repeat(40)}`);
const implementation = EvmAddressSchema.parse(`0x${'2'.repeat(40)}`);
const implementationHash = `0x${'3'.repeat(64)}` as const;
const evidenceDigest = `0x${'4'.repeat(64)}` as const;
const actor = CurrentUserSchema.parse({
  id: UserIdSchema.parse('usr_01J00000000000000000000000'),
  walletAddress: owner,
  authMethod: 'email_otp',
  status: 'active',
  merchantMemberships: [],
});

const config = {
  particle: {
    expectedImplementationAddress: implementation,
    expectedImplementationCodeHash: implementationHash,
  },
} as unknown as PublicBrowserConfig;

function operations(delegated: boolean): UniversalOperationPort {
  return {
    getAccount: async () => ({
      ownerAddress: owner,
      evmAddress: owner,
      protocolVersion: '2.0.1',
      eip7702: true,
    }),
    getDelegation: async () => ({
      ownerAddress: owner,
      chainId: '42161',
      delegated,
      ...(delegated
        ? {
            implementationAddress: implementation,
            implementationCodeHash: implementationHash,
          }
        : {}),
      evidence: {
        adapter: 'readiness-test',
        packageVersion: 'test',
        schemaVersion: 1,
        environment: 'test',
        observedAt: '2026-07-14T00:00:00.000Z',
        provenance: 'deterministic',
        payloadDigest: evidenceDigest,
        evidenceDigest,
      },
    }),
  } as unknown as UniversalOperationPort;
}

function chain(
  delegation:
    | { accountType: 'eoa'; codeHash: `0x${string}` }
    | {
        accountType: 'delegated_eoa';
        implementation: typeof implementation;
        codeHash: `0x${string}`;
      },
  codeHash = implementationHash,
): ArbitrumReadPort {
  return {
    getDelegationCode: async () => delegation,
    getCodeHash: async () => codeHash,
  } as unknown as ArbitrumReadPort;
}

function queries(input: { operations: UniversalOperationPort; chain: ArbitrumReadPort }) {
  return new LiveBackendApiResourceQueries({
    config,
    queries: {} as BackendApiQueryPort,
    backend: {} as PostgresBackendApiStore,
    operationsForActor: () => input.operations,
    chain: input.chain,
    checks: { database: async () => undefined, redis: async () => undefined },
  });
}

describe('wallet readiness independent EIP-7702 verification', () => {
  it('fails closed when Particle says delegated but Arbitrum still reports an EOA', async () => {
    const result = await queries({
      operations: operations(true),
      chain: chain({ accountType: 'eoa', codeHash: evidenceDigest }),
    }).getWalletReadiness(actor);

    expect(result.ready).toBe(false);
    expect(result.blockers).toContain('delegation_required');
  });

  it('fails closed when the implementation bytecode hash differs from trusted config', async () => {
    const result = await queries({
      operations: operations(true),
      chain: chain(
        { accountType: 'delegated_eoa', implementation, codeHash: evidenceDigest },
        evidenceDigest,
      ),
    }).getWalletReadiness(actor);

    expect(result.ready).toBe(false);
    expect(result.blockers).toContain('delegation_target_mismatch');
  });

  it('is ready only when Particle and independent Arbitrum evidence agree', async () => {
    const result = await queries({
      operations: operations(true),
      chain: chain({ accountType: 'delegated_eoa', implementation, codeHash: evidenceDigest }),
    }).getWalletReadiness(actor);

    expect(result).toMatchObject({ ready: true, blockers: [], ownerMatches: true });
  });
});
