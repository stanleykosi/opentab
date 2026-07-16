import {
  ARBITRUM_ONE_CHAIN_ID,
  BoundOperationTemplateSchema,
  EvmAddressSchema,
  ValidatedOperationPlanSchema,
  VerifiedDelegationPlanSchema,
} from '@opentab/shared';
import { getBytes, Wallet } from 'ethers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MagicBrowserWalletAdapter } from '../src/magic-client.js';

const wallet = new Wallet(`0x${'13'.repeat(32)}`);
const owner = EvmAddressSchema.parse(wallet.address);
const other = EvmAddressSchema.parse(`0x${'2'.repeat(40)}`);
const implementation = EvmAddressSchema.parse(`0x${'3'.repeat(40)}`);
const transactionHash = `0x${'4'.repeat(64)}`;
const bytes32 = (character: string) => `0x${character.repeat(64)}` as `0x${string}`;

function userMetadata(address = owner) {
  return {
    issuer: 'did:magic:test',
    email: 'customer@example.test',
    phoneNumber: null,
    isMfaEnabled: false,
    recoveryFactors: [],
    firstLoginAt: '2026-07-14T00:00:00.000Z',
    wallets: {
      ethereum: { publicAddress: address, subAccounts: [] },
    },
  };
}

function createFake() {
  let chainId = '0x1';
  const loginWithRedirect = vi.fn(async () => undefined);
  const sign7702Authorization = vi.fn(
    async (input: { contractAddress: string; chainId: number; nonce?: number }) => ({
      ...input,
      nonce: input.nonce ?? 0,
      v: 27,
      r: bytes32('5'),
      s: bytes32('6'),
    }),
  );
  const send7702Transaction = vi.fn(async () => ({ transactionHash }));
  const rpcRequest = vi.fn(async (input: { method: string; params?: readonly unknown[] }) => {
    if (input.method === 'eth_accounts' || input.method === 'eth_requestAccounts') return [owner];
    if (input.method === 'eth_chainId') return chainId;
    if (input.method === 'personal_sign') {
      const message = input.params?.[0];
      if (typeof message !== 'string') throw new Error('personal_sign message missing');
      return wallet.signMessage(getBytes(message));
    }
    throw new Error(`Unexpected RPC method: ${input.method}`);
  });
  return {
    controls: {
      loginWithRedirect,
      sign7702Authorization,
      send7702Transaction,
      rpcRequest,
      setChain(value: string) {
        chainId = value;
      },
    },
    magic: {
      auth: {
        loginWithEmailOTP: vi.fn(async () => 'deterministic-did-token-for-browser-test'),
      },
      user: {
        getIdToken: vi.fn(async () => 'fresh-did-token-for-restored-browser-session'),
        getInfo: vi.fn(async () => userMetadata()),
        logout: vi.fn(async () => undefined),
      },
      wallet: { sign7702Authorization, send7702Transaction },
      oauth2: {
        loginWithRedirect,
        getRedirectResult: vi.fn(async () => ({
          oauth: { provider: 'google' },
          magic: {
            idToken: 'deterministic-google-did-token',
            userMetadata: userMetadata(),
          },
        })),
      },
      evm: {
        switchChain: vi.fn(async (next: number) => {
          chainId = `0x${next.toString(16)}`;
        }),
      },
      rpcProvider: { request: rpcRequest },
    },
  };
}

function config(overrides: Record<string, unknown> = {}) {
  return {
    publishableKey: 'pk_live_verified_test_key',
    environment: 'test',
    allowedRedirectUris: ['https://opentab.example/auth/callback'],
    rpcNetworks: [{ chainId: 42161, rpcUrl: 'https://arb.example.test', default: true }],
    ...overrides,
  };
}

function delegationPlan() {
  return VerifiedDelegationPlanSchema.parse({
    ownerAddress: owner,
    chainId: ARBITRUM_ONE_CHAIN_ID,
    implementationAddress: implementation,
    implementationCodeHash: bytes32('7'),
    nonce: '8',
    transactionTarget: owner,
    data: '0x',
    valueWei: '0',
    expiresAt: '2099-07-14T12:05:00.000Z',
    bindingDigest: bytes32('8'),
  });
}

function validatedPlan() {
  const template = BoundOperationTemplateSchema.parse({
    kind: 'checkout',
    ownerAddress: owner,
    chainId: ARBITRUM_ONE_CHAIN_ID,
    calls: [{ to: implementation, data: '0x1234', valueWei: '0' }],
    bindingDigest: bytes32('9'),
    expiresAt: '2099-07-14T12:05:00.000Z',
  });
  return ValidatedOperationPlanSchema.parse({
    planId: bytes32('a'),
    template,
    rootHash: bytes32('b'),
    quote: {
      amountBaseUnits: '1000000',
      estimatedFeeUsd: '0.1',
      totalUsd: '1.1',
      slippageBps: '100',
      sources: [{ chainId: '8453', symbol: 'USDC', amount: '1.1', amountUsd: '1.1' }],
      quotedAt: '2099-07-14T12:00:00.000Z',
      expiresAt: '2099-07-14T12:05:00.000Z',
    },
    validatedAt: '2099-07-14T12:00:00.000Z',
    expiresAt: '2099-07-14T12:05:00.000Z',
  });
}

describe('Magic browser wallet adapter', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('passes only an allowlisted redirect and opaque server continuation to Google OAuth', async () => {
    const fake = createFake();
    const adapter = new MagicBrowserWalletAdapter(config(), async () => fake.magic);
    await adapter.loginWithGoogle({
      redirectUri: 'https://opentab.example/auth/callback',
      continuationId: 'authcont_01J00000000000000000000000',
    });
    expect(fake.controls.loginWithRedirect).toHaveBeenCalledWith({
      provider: 'google',
      redirectURI: 'https://opentab.example/auth/callback',
      scope: ['openid', 'email'],
      customData: 'authcont_01J00000000000000000000000',
    });
    await expect(
      adapter.loginWithGoogle({
        redirectUri: 'https://attacker.example/callback',
        continuationId: 'authcont_01J00000000000000000000000',
      }),
    ).rejects.toMatchObject({ code: 'AUTH_STATE_MISMATCH' });
  });

  it('normalizes Google/email login and verifies provider-to-metadata address continuity', async () => {
    const fake = createFake();
    const adapter = new MagicBrowserWalletAdapter(config(), async () => fake.magic);
    await expect(adapter.completeGoogleRedirect()).resolves.toMatchObject({ authMethod: 'google' });
    await expect(
      adapter.loginWithEmailOtp({ email: 'Customer@Example.Test' }),
    ).resolves.toMatchObject({
      authMethod: 'email_otp',
    });
    expect(fake.magic.auth.loginWithEmailOTP).toHaveBeenCalledWith({
      email: 'customer@example.test',
      showUI: true,
    });

    fake.magic.user.getInfo.mockResolvedValueOnce(userMetadata(other));
    await expect(adapter.getOwnerAddress()).rejects.toMatchObject({
      code: 'WALLET_ADDRESS_MISMATCH',
    });
  });

  it('requests a bounded fresh proof for an already authenticated Magic wallet', async () => {
    const fake = createFake();
    const adapter = new MagicBrowserWalletAdapter(config(), async () => fake.magic);
    await expect(adapter.getFreshIdentityProof()).resolves.toEqual({
      didToken: 'fresh-did-token-for-restored-browser-session',
    });
    expect(fake.magic.user.getIdToken).toHaveBeenCalledWith({ lifespan: 300 });
    expect(fake.controls.rpcRequest).toHaveBeenCalledWith({ method: 'eth_accounts' });
  });

  it('independently verifies the chain after Magic switchChain', async () => {
    const fake = createFake();
    const adapter = new MagicBrowserWalletAdapter(config(), async () => fake.magic);
    await adapter.switchToArbitrum();
    expect(fake.magic.evm.switchChain).toHaveBeenCalledWith(42161);
    expect(fake.controls.rpcRequest).toHaveBeenCalledWith({ method: 'eth_chainId' });
    await expect(adapter.getChainId()).resolves.toBe(ARBITRUM_ONE_CHAIN_ID);
  });

  it('binds the installed 7702 authorization and Type-4 response to the verified plan', async () => {
    const fake = createFake();
    fake.controls.setChain('0xa4b1');
    const adapter = new MagicBrowserWalletAdapter(config(), async () => fake.magic);
    const plan = delegationPlan();
    const signed = await adapter.authorizeDelegation(plan);
    expect(fake.controls.sign7702Authorization).toHaveBeenCalledWith({
      contractAddress: implementation,
      chainId: 42161,
      nonce: 8,
    });
    await expect(adapter.submitDelegation(plan, signed)).resolves.toEqual({
      transactionHash,
      submissionPossible: true,
    });
    expect(fake.controls.send7702Transaction).toHaveBeenCalledWith({
      to: owner,
      value: '0x0',
      data: '0x',
      authorizationList: [signed.authorization],
    });
  });

  it('signs root bytes through the Magic EIP-1193 provider and independently recovers the owner', async () => {
    const fake = createFake();
    const adapter = new MagicBrowserWalletAdapter(config(), async () => fake.magic);
    const signed = await adapter.signValidatedRoot(validatedPlan());
    expect(signed.recoveredOwner.toLowerCase()).toBe(owner.toLowerCase());
    expect(signed.signature).toMatch(/^0x[0-9a-f]+$/i);
  });

  it('rejects insecure production RPCs and callback origins at construction', () => {
    expect(
      () =>
        new MagicBrowserWalletAdapter(
          config({
            environment: 'production',
            rpcNetworks: [{ chainId: 42161, rpcUrl: 'http://arb.example.test' }],
          }),
          async () => createFake().magic,
        ),
    ).toThrow(expect.objectContaining({ code: 'CONFIGURATION_INVALID' }));
    expect(
      () =>
        new MagicBrowserWalletAdapter(
          config({
            environment: 'production',
            allowedRedirectUris: ['http://opentab.example/auth/callback'],
          }),
          async () => createFake().magic,
        ),
    ).toThrow(expect.objectContaining({ code: 'CONFIGURATION_INVALID' }));
  });
});
