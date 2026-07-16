import {
  ARBITRUM_ONE_CHAIN_ID,
  EvidenceDigestSchema,
  EvmAddressSchema,
  TransactionHashSchema,
  VerifiedMagicIdentitySchema,
} from '@opentab/shared';
import { describe, expect, it } from 'vitest';
import {
  assertProviderMode,
  DeterministicEip7702AuthorizationEvidenceAdapter,
  DeterministicMagicIdentityVerifier,
  DeterministicMagicWallet,
  DeterministicUniversalOperationAdapter,
} from '../src/deterministic.js';

const owner = EvmAddressSchema.parse(`0x${'1'.repeat(40)}`);
const implementation = EvmAddressSchema.parse(`0x${'2'.repeat(40)}`);
const digestHex = `0x${'3'.repeat(64)}` as const;
const digest = EvidenceDigestSchema.parse(digestHex);
const transactionHash = TransactionHashSchema.parse(`0x${'4'.repeat(64)}`);
const blockHash = `0x${'5'.repeat(64)}` as const;

describe('deterministic provider isolation', () => {
  it('cannot be constructed in production-like environments', () => {
    const identity = VerifiedMagicIdentitySchema.parse({
      issuerHash: 'deterministic-issuer-hash-0000000000000000',
      walletAddress: owner,
      issuedAt: '2026-07-14T12:00:00.000Z',
      expiresAt: '2026-07-14T13:00:00.000Z',
      audience: 'deterministic-audience',
      applicationId: 'deterministic-audience',
      authMethod: 'email_otp',
      evidenceDigest: digest,
    });
    expect(
      () => new DeterministicMagicIdentityVerifier('production', 'test-token', identity),
    ).toThrow(expect.objectContaining({ code: 'CONFIGURATION_INVALID' }));
    expect(
      () =>
        new DeterministicMagicWallet('demo-mainnet', 'test-token', owner, `0x${'11'.repeat(32)}`),
    ).toThrow(expect.objectContaining({ code: 'CONFIGURATION_INVALID' }));
    expect(
      () =>
        new DeterministicUniversalOperationAdapter({
          environment: 'production',
          ownerAddress: owner,
          implementationAddress: implementation,
          implementationCodeHash: digestHex,
          delegated: false,
          unifiedBalance: {
            totalUsd: '0',
            assets: [],
            fetchedAt: '2026-07-14T12:00:00.000Z',
            evidence: {
              adapter: 'deterministic',
              packageVersion: '1',
              schemaVersion: 1,
              environment: 'test',
              observedAt: '2026-07-14T12:00:00.000Z',
              evidenceDigest: digest,
              provenance: 'deterministic',
            },
          },
        }),
    ).toThrow(expect.objectContaining({ code: 'CONFIGURATION_INVALID' }));
    expect(() => new DeterministicEip7702AuthorizationEvidenceAdapter('production', [])).toThrow(
      expect.objectContaining({ code: 'CONFIGURATION_INVALID' }),
    );
  });

  it('returns only an exact pre-registered deterministic Type-4 authorization proof', async () => {
    const adapter = new DeterministicEip7702AuthorizationEvidenceAdapter('test', [
      {
        transactionHash,
        transactionFrom: owner,
        transactionType: 'eip7702',
        blockNumber: '12',
        blockHash,
        authority: owner,
        delegate: implementation,
        chainId: ARBITRUM_ONE_CHAIN_ID,
        authorizationIndex: 0,
        authorizationNonce: '3',
        canonical: true,
      },
    ]);
    await expect(
      adapter.getEip7702AuthorizationEvidence({
        transactionHash,
        expectedAuthority: owner,
        expectedDelegate: implementation,
      }),
    ).resolves.toMatchObject({
      authority: owner,
      delegate: implementation,
      authorizationNonce: '3',
      authorizationIndex: 0,
      canonical: true,
    });
    await expect(
      adapter.getEip7702AuthorizationEvidence({
        transactionHash: TransactionHashSchema.parse(`0x${'6'.repeat(64)}`),
        expectedAuthority: owner,
        expectedDelegate: implementation,
      }),
    ).rejects.toMatchObject({ code: 'UA_DELEGATION_REQUIRED' });
  });

  it('requires an explicit demo flag and rejects it in production', () => {
    expect(() =>
      assertProviderMode({
        providerMode: 'deterministic',
        environment: 'local',
        deterministicDemoEnabled: false,
      }),
    ).toThrow(expect.objectContaining({ code: 'CONFIGURATION_INVALID' }));
    expect(() =>
      assertProviderMode({
        providerMode: 'live',
        environment: 'production',
        deterministicDemoEnabled: true,
      }),
    ).toThrow(expect.objectContaining({ code: 'CONFIGURATION_INVALID' }));
    expect(() =>
      assertProviderMode({
        providerMode: 'deterministic',
        environment: 'local',
        deterministicDemoEnabled: true,
      }),
    ).not.toThrow();
  });
});
