import { EVMExtension } from '@magic-ext/evm';
import { OAuthExtension } from '@magic-ext/oauth2';
import { Magic as MagicAdmin } from '@magic-sdk/admin';
import {
  CHAIN_ID,
  UNIVERSAL_ACCOUNT_VERSION,
  UniversalAccount,
} from '@particle-network/universal-account-sdk';
import { Magic } from 'magic-sdk';
import { recoverAuthorizationAddress } from 'viem/utils';
import { describe, expect, it } from 'vitest';

describe('pinned vendor runtime compatibility surface', () => {
  it('exposes Particle 2.0.3 methods used by the adapter and Arbitrum One', () => {
    expect(UNIVERSAL_ACCOUNT_VERSION).toBe('2.0.1');
    expect(CHAIN_ID.ARBITRUM_MAINNET_ONE).toBe(42161);
    expect(
      Object.values(CHAIN_ID)
        .filter((value): value is number => typeof value === 'number')
        .sort((left, right) => left - right),
    ).toEqual([1, 56, 101, 196, 8453, 42161]);
    for (const method of [
      'getSmartAccountOptions',
      'getPrimaryAssets',
      'getEIP7702Deployments',
      'getEIP7702Auth',
      'createUniversalTransaction',
      'sendTransaction',
      'getTransaction',
    ]) {
      expect(typeof UniversalAccount.prototype[method as keyof UniversalAccount]).toBe('function');
    }
  });

  it('exposes the pinned Magic browser, OAuth, EVM, and Admin constructors', () => {
    expect(typeof Magic).toBe('function');
    expect(typeof EVMExtension).toBe('function');
    expect(typeof OAuthExtension).toBe('function');
    expect(typeof MagicAdmin).toBe('function');
    expect(typeof MagicAdmin.init).toBe('function');
  });

  it('exposes EIP-7702 signer recovery from the pinned viem utils entrypoint', () => {
    expect(typeof recoverAuthorizationAddress).toBe('function');
  });
});
