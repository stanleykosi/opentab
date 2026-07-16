import type { Eip7702AuthorizationEvidence } from '@opentab/application';
import {
  AppError,
  ARBITRUM_ONE_CHAIN_ID,
  CurrentUserSchema,
  EvidenceDigestSchema,
  EvmAddressSchema,
  TransactionHashSchema,
} from '@opentab/shared';
import { describe, expect, it, vi } from 'vitest';
import { LiveBackendApiCommands } from '../app/api/_lib/live-commands.js';

const ULID = '01J00000000000000000000000';
const OWNER = EvmAddressSchema.parse('0x1111111111111111111111111111111111111111');
const OTHER = EvmAddressSchema.parse('0x9999999999999999999999999999999999999999');
const IMPLEMENTATION = EvmAddressSchema.parse('0x2222222222222222222222222222222222222222');
const TRANSACTION_HASH = TransactionHashSchema.parse(`0x${'ab'.repeat(32)}`);
const OTHER_TRANSACTION_HASH = TransactionHashSchema.parse(`0x${'bc'.repeat(32)}`);
const BLOCK_HASH = `0x${'cd'.repeat(32)}` as `0x${string}`;
const PARENT_HASH = `0x${'de'.repeat(32)}` as `0x${string}`;
const CODE_HASH = `0x${'ef'.repeat(32)}` as `0x${string}`;
const CLIENT_DIGEST_A = EvidenceDigestSchema.parse(`0x${'12'.repeat(32)}`);
const CLIENT_DIGEST_B = EvidenceDigestSchema.parse(`0x${'34'.repeat(32)}`);
const BLOCK_NUMBER = '31415926';

const actor = CurrentUserSchema.parse({
  id: `usr_${ULID}`,
  walletAddress: OWNER,
  authMethod: 'email_otp',
  status: 'active',
  merchantMemberships: [],
});

function validEvidence(): Eip7702AuthorizationEvidence {
  return {
    transactionHash: TRANSACTION_HASH,
    transactionFrom: OWNER,
    transactionType: 'eip7702',
    blockNumber: BLOCK_NUMBER,
    blockHash: BLOCK_HASH,
    authority: OWNER,
    delegate: IMPLEMENTATION,
    chainId: ARBITRUM_ONE_CHAIN_ID,
    authorizationIndex: 0,
    authorizationNonce: '7',
    canonical: true,
  };
}

function context(evidenceDigest: typeof CLIENT_DIGEST_A, suffix: string) {
  return {
    actor,
    body: { transactionHash: TRANSACTION_HASH, evidenceDigest },
    idempotencyKeyHash: `delegation-key-${suffix}`.padEnd(64, 'k'),
    requestHash: `delegation-request-${suffix}`.padEnd(64, 'r'),
    requestId: `delegation-request-id-${suffix}`,
  };
}

function commands(input: {
  readonly capability?: boolean;
  readonly evidence?: Eip7702AuthorizationEvidence;
}) {
  const evidence = input.evidence ?? validEvidence();
  const readEvidence = vi.fn(async () => evidence);
  const getTransactionReceipt = vi.fn(async () => ({
    success: true,
    blockNumber: BLOCK_NUMBER,
    blockHash: BLOCK_HASH,
  }));
  const recordDelegationEvidence = vi.fn(
    async (_input: { readonly evidenceDigest: string }) => undefined,
  );
  const cache = new Map<string, { requestHash: string; value: unknown }>();
  const chain = {
    getTransactionReceipt,
    getBlock: async () => ({
      number: BLOCK_NUMBER,
      hash: BLOCK_HASH,
      parentHash: PARENT_HASH,
      timestamp: '2026-07-14T20:00:00.000Z',
    }),
    getDelegationCode: async () => ({
      accountType: 'delegated_eoa' as const,
      implementation: IMPLEMENTATION,
      codeHash: CODE_HASH,
    }),
    getCodeHash: async () => CODE_HASH,
    ...(input.capability === false ? {} : { getEip7702AuthorizationEvidence: readEvidence }),
  };
  const instance = new LiveBackendApiCommands({
    chain,
    backend: { recordDelegationEvidence },
    idempotency: {
      execute: async (request: {
        scope: string;
        keyHash: string;
        requestHash: string;
        operation: () => Promise<unknown>;
      }) => {
        const key = `${request.scope}:${request.keyHash}`;
        const existing = cache.get(key);
        if (existing !== undefined) {
          if (existing.requestHash !== request.requestHash) {
            throw new AppError('IDEMPOTENCY_CONFLICT', 'The request binding changed.');
          }
          return { value: existing.value, replayed: true };
        }
        const value = await request.operation();
        cache.set(key, { requestHash: request.requestHash, value });
        return { value, replayed: false };
      },
    },
    expectedDelegationImplementation: IMPLEMENTATION,
    expectedDelegationCodeHash: CODE_HASH,
    environment: 'staging',
    evidenceProvenance: 'staging',
    now: () => new Date('2026-07-14T20:00:00.000Z'),
  } as never);
  return {
    instance,
    spies: { readEvidence, getTransactionReceipt, recordDelegationEvidence },
  };
}

describe('canonical EIP-7702 delegation evidence', () => {
  it('fails closed when the chain adapter lacks canonical authorization evidence', async () => {
    const { instance, spies } = commands({ capability: false });
    await expect(
      instance.recordDelegationEvidence(context(CLIENT_DIGEST_A, 'absent')),
    ).rejects.toMatchObject({
      code: 'CONFIGURATION_INVALID',
    });
    expect(spies.getTransactionReceipt).not.toHaveBeenCalled();
    expect(spies.recordDelegationEvidence).not.toHaveBeenCalled();
  });

  it.each([
    ['unrelated transaction', { transactionHash: OTHER_TRANSACTION_HASH }],
    ['non-Type-4 transaction', { transactionType: 'legacy' }],
    ['wrong transaction sender', { transactionFrom: OTHER }],
    ['wrong recovered authority', { authority: OTHER }],
    ['wrong chain', { chainId: '1' }],
    ['wrong delegate', { delegate: OTHER }],
    ['wrong authorization index', { authorizationIndex: 1 }],
    ['non-canonical evidence', { canonical: false }],
    ['negative authorization nonce', { authorizationNonce: '-1' }],
  ] as const)('rejects %s independently', async (_label, patch) => {
    const evidence = { ...validEvidence(), ...patch } as Eip7702AuthorizationEvidence;
    const { instance, spies } = commands({ evidence });
    await expect(
      instance.recordDelegationEvidence(context(CLIENT_DIGEST_A, `invalid-${_label}`)),
    ).rejects.toMatchObject({ code: 'UA_CONFIGURATION_INVALID' });
    expect(spies.recordDelegationEvidence).not.toHaveBeenCalled();
  });

  it('passes the authenticated owner and trusted delegate to the evidence adapter', async () => {
    const { instance, spies } = commands({});
    const result = await instance.recordDelegationEvidence(context(CLIENT_DIGEST_A, 'valid'));
    expect(spies.readEvidence).toHaveBeenCalledWith({
      transactionHash: TRANSACTION_HASH,
      expectedAuthority: OWNER,
      expectedDelegate: IMPLEMENTATION,
    });
    expect(result.delegation.evidence).toMatchObject({
      adapter: 'viem-arbitrum-eip7702-authorization',
      packageVersion: '2.55.0',
      schemaVersion: 2,
    });
  });

  it('persists only deterministic server digests bound to the client plan and replays exactly', async () => {
    const { instance, spies } = commands({});
    const firstContext = context(CLIENT_DIGEST_A, 'digest-a');
    const first = await instance.recordDelegationEvidence(firstContext);
    const replay = await instance.recordDelegationEvidence(firstContext);
    const second = await instance.recordDelegationEvidence(
      context(CLIENT_DIGEST_B as typeof CLIENT_DIGEST_A, 'digest-b'),
    );

    expect(replay).toEqual(first);
    expect(spies.readEvidence).toHaveBeenCalledTimes(2);
    expect(spies.recordDelegationEvidence).toHaveBeenCalledTimes(2);
    const persisted = spies.recordDelegationEvidence.mock.calls.map(([value]) => value);
    const persistedDigests = persisted.map(({ evidenceDigest }) => evidenceDigest);
    expect(persistedDigests[0]).toBe(first.delegation.evidence.evidenceDigest);
    expect(persistedDigests[1]).toBe(second.delegation.evidence.evidenceDigest);
    expect(persistedDigests[0]).not.toBe(persistedDigests[1]);
    expect(persistedDigests).not.toContain(CLIENT_DIGEST_A);
    expect(persistedDigests).not.toContain(CLIENT_DIGEST_B);
    const serializedProofs = JSON.stringify({ persisted, first, replay, second });
    expect(serializedProofs).not.toContain(CLIENT_DIGEST_A);
    expect(serializedProofs).not.toContain(CLIENT_DIGEST_B);
  });
});
