import { ARBITRUM_ONE_CHAIN_ID, CheckoutBindingSchema, EvmAddressSchema } from '@opentab/shared';
import { keccak256 } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import { createCheckoutOperationTemplate } from '../src/particle.js';
import { ParticleOperatorCertificationAdapter } from '../src/particle-certification.js';

const digest = (character: string) => `0x${character.repeat(64)}` as `0x${string}`;
const owner = EvmAddressSchema.parse('0x1111111111111111111111111111111111111111');
const delegate = EvmAddressSchema.parse('0x2222222222222222222222222222222222222222');
const checkout = EvmAddressSchema.parse('0x3333333333333333333333333333333333333333');
const arbitrumUsdc = EvmAddressSchema.parse('0xaf88d065e77c8cC2239327C5EDb3A432268e5831');
const baseUsdc = EvmAddressSchema.parse('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
const sourceRouter = EvmAddressSchema.parse('0x4444444444444444444444444444444444444444');
const now = new Date('2026-07-18T00:00:00.000Z');

function binding() {
  return CheckoutBindingSchema.parse({
    checkoutSessionId: 'chk_01J00000000000000000000000',
    attemptId: 'pay_01J00000000000000000000000',
    orderId: 'ord_01J00000000000000000000000',
    orderIntent: {
      orderKey: digest('1'),
      payer: owner,
      recipient: owner,
      merchantOnchainId: '1',
      productOnchainId: '2',
      productVersion: '1',
      token: arbitrumUsdc,
      amountBaseUnits: '100000',
      platformFeeBps: '0',
      platformFeeBaseUnits: '0',
      quantity: '1',
      validAfter: '0',
      validUntil: '1784333100',
      refundDeadline: '1784336700',
      metadataHash: digest('2'),
    },
    orderIntentDigest: digest('3'),
    orderIntentSignature: `0x${'ab'.repeat(65)}`,
    signerKeyId: 'canary-order-key',
    chainId: ARBITRUM_ONE_CHAIN_ID,
    usdcAddress: arbitrumUsdc,
    checkoutAddress: checkout,
    expiresAt: '2026-07-18T00:05:00.000Z',
    bindingDigest: digest('4'),
  });
}

function fixture() {
  const checkoutBinding = binding();
  const template = createCheckoutOperationTemplate(checkoutBinding);
  const sourceCalldata = `0x12345678${'de'.repeat(32)}`;
  const prepared = {
    sender: owner,
    transactionId: 'sensitive-provider-transaction-id',
    smartAccountOptions: { ownerAddress: owner, senderAddress: owner },
    depositTokens: [],
    tokenChanges: {
      decr: [
        {
          token: { type: 'usdc', chainId: 8453, address: baseUsdc },
          amount: '0.42',
          amountInUSD: '0.42',
          senderAddress: owner,
        },
      ],
    },
    rootHash: digest('f'),
    userOps: [
      {
        chainId: 42161,
        txs: template.calls.map((call) => ({
          uaType: 'evm',
          to: call.to,
          data: call.data,
          value: '0x0',
        })),
      },
      {
        chainId: 8453,
        txs: [
          {
            uaType: 'evm',
            to: sourceRouter,
            data: sourceCalldata,
            value: '0x0',
          },
        ],
      },
    ],
  };
  const sdk = {
    getSmartAccountOptions: vi.fn(async () => ({
      name: 'UNIVERSAL',
      version: '2.0.1',
      ownerAddress: owner,
      smartAccountAddress: owner,
      useEIP7702: true,
    })),
    getPrimaryAssets: vi.fn(async () => ({
      assets: [
        {
          tokenType: 'usdc',
          amount: 1,
          amountInUSD: 1,
          chainAggregation: [],
        },
      ],
      totalAmountInUSD: 1,
    })),
    getEIP7702Deployments: vi.fn(async () => [
      { chainId: 42161, isDelegated: false, address: delegate },
    ]),
    getEIP7702Auth: vi.fn(async () => [{ chainId: 42161, address: delegate, nonce: 7 }]),
    createUniversalTransaction: vi.fn(async () => prepared),
  };
  const magic = {
    getOwnerAddress: vi.fn(async () => owner),
    getChainId: vi.fn(async () => ARBITRUM_ONE_CHAIN_ID),
    switchToArbitrum: vi.fn(async () => undefined),
    probeDelegationAuthorizationNonce: vi.fn(async () => ({
      chainId: ARBITRUM_ONE_CHAIN_ID,
      implementationAddress: delegate,
      nonce: '8',
    })),
  };
  const delegateCode = '0x6001600055' as const;
  const rpcFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as { params: [string] };
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: request.params[0]?.toLowerCase() === delegate.toLowerCase() ? delegateCode : '0x',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
  const adapter = new ParticleOperatorCertificationAdapter(
    {
      profileId: 'release-d955e617bc23',
      environment: 'demo-mainnet',
      projectId: 'particle-project',
      projectClientKey: 'particle-client-key',
      projectAppUuid: 'particle-app-id',
      ownerAddress: owner,
      magic,
      arbitrumRpcUrl: 'https://arb1.arbitrum.io/rpc',
      allowedArbitrumRpcOrigins: ['https://arb1.arbitrum.io'],
      allowedSourceChainIds: ['8453', ARBITRUM_ONE_CHAIN_ID],
      allowedSourceAssets: ['USDC'],
      slippageBps: 100,
      delegationPlanTtlSeconds: 300,
      now: () => now,
    },
    { sdk, fetch: rpcFetch },
  );
  return { adapter, sdk, magic, delegateCode, checkoutBinding, sourceCalldata, prepared };
}

describe('Particle operator compatibility certification', () => {
  it('captures one sanitized bootstrap profile and discards Magic authorization material', async () => {
    const { adapter, magic, delegateCode } = fixture();
    const { profile } = await adapter.captureBootstrap();

    expect(profile).toMatchObject({
      profileId: 'release-d955e617bc23:bootstrap',
      stage: 'bootstrap',
      useEIP7702: true,
      delegateAddress: delegate,
      delegateCodeHash: keccak256(delegateCode),
      nonceConvention: { magicAuthorizationNonceOffset: 1 },
    });
    expect(profile.responseDigests).not.toHaveProperty('submission');
    expect(profile.responseDigests).not.toHaveProperty('status');
    expect(JSON.stringify(profile).toLowerCase()).not.toContain(owner.toLowerCase());
    expect(magic.probeDelegationAuthorizationNonce).toHaveBeenCalledOnce();
  });

  it('captures a distinct canary-ready semantic policy without raw route data', async () => {
    const { adapter, sdk, checkoutBinding, sourceCalldata, prepared } = fixture();
    const result = await adapter.captureCanaryReady(checkoutBinding);

    expect(result.profile).toMatchObject({
      profileId: 'release-d955e617bc23:canary-ready',
      stage: 'canary_ready',
      sourceTokenProfile: {
        allowedSourceChainIds: ['42161', '8453'],
        allowedSourceAssets: ['USDC'],
        sourceCallPolicies: [
          expect.objectContaining({
            chainId: '8453',
            asset: 'USDC',
            target: sourceRouter,
            functionSelector: '0x12345678',
            nativeValueAllowed: false,
            maxCalls: 1,
          }),
        ],
      },
    });
    const serialized = JSON.stringify(result.profile);
    expect(serialized).not.toContain(sourceCalldata);
    expect(serialized).not.toContain(prepared.rootHash);
    expect(serialized).not.toContain(prepared.transactionId);
    expect(serialized).not.toContain('0.42');
    expect(sdk.createUniversalTransaction).toHaveBeenCalledOnce();
  });
});
