import { parseServerEnvironment } from '@opentab/config';
import { EvmAddressSchema, TransactionHashSchema } from '@opentab/shared';
import { describe, expect, it } from 'vitest';
import { createDeterministicBackendParts } from '../app/api/_lib/deterministic-composition.js';

const OWNER = EvmAddressSchema.parse('0x1111111111111111111111111111111111111111');
const OTHER = EvmAddressSchema.parse('0x9999999999999999999999999999999999999999');
const TRANSACTION_HASH = TransactionHashSchema.parse(`0x${'ab'.repeat(32)}`);

function parts() {
  return createDeterministicBackendParts(
    parseServerEnvironment({
      APP_ENV: 'local',
      NEXT_PUBLIC_APP_ENV: 'local',
      PROVIDER_MODE: 'deterministic',
      DETERMINISTIC_DEMO_ENABLED: 'true',
      PAYMENTS_ENABLED: 'false',
    }),
  );
}

describe('deterministic EIP-7702 chain evidence', () => {
  it('binds a dynamic transaction to the fixed demo owner/delegate and transitions readiness', async () => {
    const deterministic = parts();
    await expect(deterministic.chain.getDelegationCode(OWNER)).resolves.toMatchObject({
      accountType: 'eoa',
    });
    const proof = await deterministic.chain.getEip7702AuthorizationEvidence?.({
      transactionHash: TRANSACTION_HASH,
      expectedAuthority: OWNER,
      expectedDelegate: deterministic.implementationAddress,
    });
    expect(proof).toEqual({
      transactionHash: TRANSACTION_HASH,
      transactionFrom: OWNER,
      transactionType: 'eip7702',
      blockNumber: '1',
      blockHash: `0x${'11'.repeat(32)}`,
      authority: OWNER,
      delegate: deterministic.implementationAddress,
      chainId: '42161',
      authorizationIndex: 0,
      authorizationNonce: '0',
      canonical: true,
    });
    await expect(deterministic.chain.getDelegationCode(OWNER)).resolves.toMatchObject({
      accountType: 'delegated_eoa',
      implementation: deterministic.implementationAddress,
    });
  });

  it('rejects unrelated authorities or delegates without transitioning the demo account', async () => {
    for (const binding of [
      { expectedAuthority: OTHER, expectedDelegate: parts().implementationAddress },
      { expectedAuthority: OWNER, expectedDelegate: OTHER },
    ]) {
      const deterministic = parts();
      await expect(
        deterministic.chain.getEip7702AuthorizationEvidence?.({
          transactionHash: TRANSACTION_HASH,
          ...binding,
        }),
      ).rejects.toMatchObject({ code: 'UA_CONFIGURATION_INVALID' });
      await expect(deterministic.chain.getDelegationCode(OWNER)).resolves.toMatchObject({
        accountType: 'eoa',
      });
    }
  });
});
