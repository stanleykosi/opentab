import {
  ARBITRUM_ONE_CHAIN_ID,
  type BoundOperationTemplate,
  Bytes32Schema,
  CheckoutBindingSchema,
  EvmAddressSchema,
  ProviderOperationIdSchema,
} from '@opentab/shared';
import { getBytes, Wallet } from 'ethers';
import { encodeFunctionData, parseAbi } from 'viem';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createCheckoutOperationTemplate,
  createParticleUniversalAccountAdapter,
  type ParticleAdapterConfig,
  ParticleUniversalAccountAdapter,
} from '../src/particle.js';

const privateKey = `0x${'12'.repeat(32)}` as const;
const wallet = new Wallet(privateKey);
const owner = EvmAddressSchema.parse(wallet.address);
const usdc = EvmAddressSchema.parse('0xaf88d065e77c8cC2239327C5EDb3A432268e5831');
const checkout = EvmAddressSchema.parse(`0x${'2'.repeat(40)}`);
const implementation = EvmAddressSchema.parse(`0x${'3'.repeat(40)}`);
const sourceToken = EvmAddressSchema.parse('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
const sourceRouter = EvmAddressSchema.parse(`0x${'4'.repeat(40)}`);
const sourceApprovalData = encodeFunctionData({
  abi: parseAbi(['function approve(address spender, uint256 amount) returns (bool)']),
  functionName: 'approve',
  args: [sourceRouter as `0x${string}`, 1_100_000n],
});
const now = new Date('2026-07-14T12:00:00.000Z');
const expiry = new Date(now.getTime() + 5 * 60_000).toISOString();

const digest = (character: string) => `0x${character.repeat(64)}` as `0x${string}`;

const profile = {
  profileId: 'particle-2.0.3-deterministic-fixture-v1',
  provenance: 'deterministic' as const,
  deploymentsFixtureDigest: digest('1'),
  authFixtureDigest: digest('2'),
  submissionFixtureDigest: digest('3'),
  statusFixtureDigest: digest('4'),
  magicAuthorizationNonceOffset: 1 as const,
  delegationPlanTtlSeconds: 300,
};

function config(overrides: Partial<ParticleAdapterConfig> = {}): ParticleAdapterConfig {
  return {
    projectId: 'project-test',
    projectClientKey: 'client-test',
    projectAppUuid: 'app-test',
    ownerAddress: owner,
    expectedImplementationAddress: implementation,
    expectedImplementationCodeHash: digest('5'),
    environment: 'test',
    slippageBps: 100,
    maxFeeUsdMicros: 5_000_000n,
    allowedSourceChainIds: ['1', '8453', ARBITRUM_ONE_CHAIN_ID],
    allowedSourceAssets: ['USDC', 'USDT', 'ETH'],
    allowedSourceTokens: [
      {
        chainId: '8453',
        asset: 'USDC',
        address: sourceToken,
      },
    ],
    sourceCallProfiles: [
      {
        profileId: 'base-usdc-approval-v1',
        chainId: '8453',
        asset: 'USDC',
        tokenAddress: sourceToken,
        sourceAmount: '1.1',
        fixtureDigest: Bytes32Schema.parse(digest('a')),
        calls: [
          {
            uaType: 'evm',
            to: sourceToken,
            data: sourceApprovalData,
            valueWei: '0',
          },
        ],
      },
    ],
    responseProfile: profile,
    now: () => now,
    ...overrides,
  };
}

function binding() {
  return CheckoutBindingSchema.parse({
    checkoutSessionId: 'chk_01J00000000000000000000000',
    attemptId: 'pay_01J00000000000000000000000',
    orderId: 'ord_01J00000000000000000000000',
    orderIntent: {
      orderKey: digest('6'),
      payer: owner,
      recipient: owner,
      merchantOnchainId: '1',
      productOnchainId: '2',
      productVersion: '1',
      token: usdc,
      amountBaseUnits: '1000000',
      platformFeeBps: '100',
      platformFeeBaseUnits: '10000',
      quantity: '1',
      validAfter: '0',
      validUntil: '1784030700',
      refundDeadline: '1784034300',
      metadataHash: digest('7'),
    },
    orderIntentDigest: digest('8'),
    orderIntentSignature: `0x${'ab'.repeat(65)}`,
    signerKeyId: 'test-order-key',
    chainId: ARBITRUM_ONE_CHAIN_ID,
    usdcAddress: usdc,
    checkoutAddress: checkout,
    expiresAt: expiry,
    bindingDigest: digest('9'),
  });
}

function preparedFor(template: BoundOperationTemplate) {
  const userOps = [
    {
      chainId: 42161,
      userOpHash: digest('a'),
      expiredAt: Math.floor(new Date(expiry).getTime() / 1_000),
      txs: template.calls.map((call) => ({
        uaType: 'evm',
        to: call.to,
        data: call.data,
        value: '0x0',
      })),
      eip7702Delegated: true,
    },
    {
      chainId: 8453,
      userOpHash: digest('f'),
      expiredAt: Math.floor(new Date(expiry).getTime() / 1_000),
      txs: [
        {
          uaType: 'evm',
          to: sourceToken,
          data: sourceApprovalData,
          value: '0x0',
        },
      ],
      eip7702Delegated: true,
    },
  ];
  const source = {
    token: {
      type: 'usdc',
      chainId: 8453,
      address: sourceToken,
      symbol: 'USDC',
      decimals: 18,
      realDecimals: 6,
    },
    amount: '1.1',
    amountInUSD: '1.1',
    senderAddress: owner,
  };
  return {
    type: 'universal',
    mode: 'mainnet',
    sender: owner,
    receiver: owner,
    transactionId: 'particle-prepared-id',
    smartAccountOptions: {
      name: 'UNIVERSAL',
      version: '2.0.1',
      ownerAddress: owner,
      senderAddress: owner,
      senderSolanaAddress: 'deterministic-solana-address',
    },
    depositTokens: [source],
    feeQuotes: [
      {
        fees: { totals: { feeTokenAmountInUSD: '100000000000000000' } },
        userOps,
      },
    ],
    gasless: null,
    tokenChanges: {
      decr: [source],
      totalFeeInUSD: '0.1',
      slippage: 100,
    },
    rootHash: digest('b'),
    userOps,
    quotedAt: now.toISOString(),
  };
}

function sdk(template: BoundOperationTemplate) {
  const state = { prepared: preparedFor(template) };
  return {
    state,
    getSmartAccountOptions: vi.fn(async () => ({
      name: 'UNIVERSAL',
      version: '2.0.1',
      ownerAddress: owner,
      smartAccountAddress: owner,
      solanaSmartAccountAddress: 'deterministic-solana-address',
      useEIP7702: true,
    })),
    getPrimaryAssets: vi.fn(async () => ({
      assets: [
        {
          tokenType: 'usdc',
          price: 1,
          amount: 2,
          amountInUSD: 2,
          chainAggregation: [
            {
              token: {
                type: 'usdc',
                chainId: 8453,
                address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
                symbol: 'USDC',
                decimals: 18,
                realDecimals: 6,
              },
              amount: 2,
              amountInUSD: 2,
              rawAmount: 2_000_000,
            },
          ],
        },
      ],
      totalAmountInUSD: 2,
    })),
    getEIP7702Deployments: vi.fn(async () => [
      { chainId: 42161, isDelegated: false, address: implementation },
    ]),
    getEIP7702Auth: vi.fn(async () => [{ chainId: 42161, address: implementation, nonce: 7 }]),
    createUniversalTransaction: vi.fn(async () => state.prepared),
    sendTransaction: vi.fn(async () => ({
      transactionId: 'particle-prepared-id',
      status: 0,
      updated_at: now.toISOString(),
    })),
    getTransaction: vi.fn(async () => ({
      transactionId: 'particle-operation-id',
      status: 7,
      updated_at: now.toISOString(),
      destinationTransactionHash: digest('c'),
    })),
  };
}

describe('Particle Universal Account 2.0.3 adapter', () => {
  let template: BoundOperationTemplate;

  beforeEach(() => {
    template = createCheckoutOperationTemplate(binding());
  });

  it('constructs the exact server-bound approve + signed pay call template', () => {
    expect(template.kind).toBe('checkout');
    expect(template.chainId).toBe('42161');
    expect(template.calls).toHaveLength(2);
    expect(template.calls[0]?.to.toLowerCase()).toBe(usdc.toLowerCase());
    expect(template.calls[1]?.to.toLowerCase()).toBe(checkout.toLowerCase());
    expect(template.calls.every((call) => call.valueWei === '0')).toBe(true);
  });

  it('preserves the Magic EOA, normalizes safe display balances, and applies explicit nonce policy', async () => {
    const fake = sdk(template);
    const adapter = new ParticleUniversalAccountAdapter(fake, config());

    await expect(adapter.getAccount()).resolves.toMatchObject({
      ownerAddress: owner,
      evmAddress: owner,
      eip7702: true,
      protocolVersion: '2.0.1',
    });
    await expect(adapter.getUnifiedBalance()).resolves.toMatchObject({ totalUsd: '2' });
    await expect(adapter.prepareDelegation()).resolves.toMatchObject({
      chainId: '42161',
      implementationAddress: implementation,
      nonce: '8',
    });
    expect(fake.getEIP7702Auth).toHaveBeenCalledWith([42161]);
  });

  it('validates exact destination calls, source policy, hard fee, and explicit delegation', async () => {
    const fake = sdk(template);
    const adapter = new ParticleUniversalAccountAdapter(fake, config());
    const prepared = await adapter.prepareOperation(template);
    const plan = await adapter.validateOperation({ template, prepared });

    expect(plan.quote.amountBaseUnits).toBe('1000000');
    expect(plan.quote.estimatedFeeUsd).toBe('0.1');
    expect(plan.quote.totalUsd).toBe('1.1');
    expect(plan.quote.sources).toEqual([
      expect.objectContaining({ chainId: '8453', symbol: 'USDC' }),
    ]);
  });

  it('rejects injected destination calls before signing', async () => {
    const fake = sdk(template);
    const destinationOp = fake.state.prepared.userOps[0];
    if (destinationOp === undefined) throw new Error('fixture destination operation missing');
    fake.state.prepared = {
      ...fake.state.prepared,
      userOps: [
        {
          ...destinationOp,
          txs: [
            ...destinationOp.txs,
            {
              uaType: 'evil',
              to: EvmAddressSchema.parse(`0x${'e'.repeat(40)}`),
              data: '0x',
              value: '0x0',
            },
          ],
        },
      ],
    };
    const adapter = new ParticleUniversalAccountAdapter(fake, config());
    await expect(adapter.prepareOperation(template)).rejects.toMatchObject({
      code: 'UA_PROVIDER_SCHEMA_INVALID',
    });
  });

  it('rejects an unreviewed source-chain call before signing the multi-chain root', async () => {
    const fake = sdk(template);
    const injectedUserOps = [
      ...fake.state.prepared.userOps,
      {
        chainId: 8453,
        userOpHash: digest('d'),
        expiredAt: Math.floor(new Date(expiry).getTime() / 1_000),
        txs: [
          {
            uaType: 'evm',
            to: EvmAddressSchema.parse(`0x${'e'.repeat(40)}`),
            data: '0xdeadbeef',
            value: '0x0',
          },
        ],
        eip7702Delegated: true,
      },
    ];
    fake.state.prepared = {
      ...fake.state.prepared,
      userOps: injectedUserOps,
      feeQuotes: fake.state.prepared.feeQuotes.map((quote) => ({
        ...quote,
        userOps: injectedUserOps,
      })),
    };
    const adapter = new ParticleUniversalAccountAdapter(fake, config());
    const prepared = await adapter.prepareOperation(template);

    await expect(adapter.validateOperation({ template, prepared })).rejects.toMatchObject({
      code: 'UA_PROVIDER_SCHEMA_INVALID',
    });
  });

  it('rejects a duplicated reviewed source operation instead of reusing one profile', async () => {
    const fake = sdk(template);
    const sourceOp = fake.state.prepared.userOps.find((entry) => entry.chainId === 8453);
    if (sourceOp === undefined) throw new Error('fixture source operation missing');
    const duplicatedUserOps = [
      ...fake.state.prepared.userOps,
      { ...sourceOp, userOpHash: digest('e') },
    ];
    fake.state.prepared = {
      ...fake.state.prepared,
      userOps: duplicatedUserOps,
      feeQuotes: fake.state.prepared.feeQuotes.map((quote) => ({
        ...quote,
        userOps: duplicatedUserOps,
      })),
    };
    const adapter = new ParticleUniversalAccountAdapter(fake, config());
    const prepared = await adapter.prepareOperation(template);

    await expect(adapter.validateOperation({ template, prepared })).rejects.toMatchObject({
      code: 'UA_PROVIDER_SCHEMA_INVALID',
    });
  });

  it('rejects same-chain source metadata that substitutes another asset for the reviewed call', async () => {
    const fake = sdk(template);
    const source = fake.state.prepared.tokenChanges.decr[0];
    if (source === undefined) throw new Error('fixture source asset missing');
    const substituted = {
      ...source,
      token: {
        ...source.token,
        type: 'usdt' as const,
        address: EvmAddressSchema.parse(`0x${'7'.repeat(40)}`),
        symbol: 'USDT',
      },
    };
    fake.state.prepared = {
      ...fake.state.prepared,
      depositTokens: [substituted],
      tokenChanges: { ...fake.state.prepared.tokenChanges, decr: [substituted] },
    };
    const adapter = new ParticleUniversalAccountAdapter(
      fake,
      config({
        allowedSourceTokens: [
          ...(config().allowedSourceTokens ?? []),
          {
            chainId: '8453',
            asset: 'USDT',
            address: substituted.token.address,
          },
        ],
      }),
    );
    const prepared = await adapter.prepareOperation(template);

    await expect(adapter.validateOperation({ template, prepared })).rejects.toMatchObject({
      code: 'UA_PROVIDER_SCHEMA_INVALID',
    });
  });

  it('rejects a symbol-only or wrong-contract source masquerading as USDC', async () => {
    for (const mutate of [
      (current: ReturnType<typeof preparedFor>['tokenChanges']['decr'][number]['token']) => {
        const token = {
          ...current,
          address: EvmAddressSchema.parse(`0x${'d'.repeat(40)}`),
          symbol: 'USDC',
        };
        Reflect.deleteProperty(token, 'type');
        return token;
      },
      (current: ReturnType<typeof preparedFor>['tokenChanges']['decr'][number]['token']) => ({
        ...current,
        type: 'usdc' as const,
        address: EvmAddressSchema.parse(`0x${'d'.repeat(40)}`),
        symbol: 'USDC',
      }),
    ]) {
      const fake = sdk(template);
      const source = fake.state.prepared.tokenChanges.decr[0];
      if (source === undefined) throw new Error('fixture source is missing');
      fake.state.prepared = {
        ...fake.state.prepared,
        tokenChanges: {
          ...fake.state.prepared.tokenChanges,
          decr: [{ ...source, token: mutate(source.token) }],
        },
      };
      const adapter = new ParticleUniversalAccountAdapter(fake, config());
      const prepared = await adapter.prepareOperation(template);
      await expect(adapter.validateOperation({ template, prepared })).rejects.toMatchObject({
        code: 'UA_PROVIDER_SCHEMA_INVALID',
      });
    }
  });

  it('rejects an unapproved source chain or token', async () => {
    const fake = sdk(template);
    const source = fake.state.prepared.tokenChanges.decr[0];
    if (source === undefined) throw new Error('fixture source asset missing');
    fake.state.prepared = {
      ...fake.state.prepared,
      tokenChanges: {
        ...fake.state.prepared.tokenChanges,
        decr: [
          {
            ...source,
            token: { ...source.token, chainId: 56 },
          },
        ],
      },
    };
    const adapter = new ParticleUniversalAccountAdapter(fake, config());
    const prepared = await adapter.prepareOperation(template);
    await expect(adapter.validateOperation({ template, prepared })).rejects.toMatchObject({
      code: 'UA_PROVIDER_SCHEMA_INVALID',
    });
  });

  it('persists a parseable operation ID result and never treats Particle success as chain payment proof', async () => {
    const fake = sdk(template);
    const adapter = new ParticleUniversalAccountAdapter(fake, config());
    const prepared = await adapter.prepareOperation(template);
    const plan = await adapter.validateOperation({ template, prepared });
    const signature = await wallet.signMessage(getBytes(plan.rootHash));
    const submitted = await adapter.submitValidated({ plan, rootSignature: signature });

    expect(submitted).toMatchObject({
      id: 'particle-prepared-id',
      status: 'preparing',
      submissionPossible: true,
    });
    const status = await adapter.getOperation(
      ProviderOperationIdSchema.parse('particle-operation-id'),
    );
    expect(status.status).toBe('succeeded');
    expect(status.destinationTransactionHash).toBe(digest('c'));
    // `succeeded` is provider workflow state only; no `paid` state exists in this port.
    expect(status).not.toHaveProperty('paid');
  });

  it('rejects a submission ID that does not equal the pre-persisted prepared transaction ID', async () => {
    const fake = sdk(template);
    fake.sendTransaction.mockResolvedValueOnce({
      transactionId: 'different-operation-id',
      status: 0,
      updated_at: now.toISOString(),
    });
    const adapter = new ParticleUniversalAccountAdapter(fake, config());
    const prepared = await adapter.prepareOperation(template);
    const plan = await adapter.validateOperation({ template, prepared });
    const signature = await wallet.signMessage(getBytes(plan.rootHash));

    await expect(adapter.submitValidated({ plan, rootSignature: signature })).rejects.toMatchObject(
      {
        code: 'UA_PROVIDER_SCHEMA_INVALID',
      },
    );
  });

  it('marks a send timeout as possibly submitted and non-retryable', async () => {
    const fake = sdk(template);
    fake.sendTransaction.mockRejectedValueOnce(new Error('timeout'));
    const adapter = new ParticleUniversalAccountAdapter(fake, config());
    const prepared = await adapter.prepareOperation(template);
    const plan = await adapter.validateOperation({ template, prepared });
    const signature = await wallet.signMessage(getBytes(plan.rootHash));

    await expect(adapter.submitValidated({ plan, rootSignature: signature })).rejects.toMatchObject(
      {
        code: 'UA_SUBMISSION_FAILED',
        submissionPossible: true,
        retryable: false,
      },
    );
  });

  it('maps future status values to unknown rather than success', async () => {
    const fake = sdk(template);
    fake.getTransaction.mockResolvedValueOnce({
      transactionId: 'particle-operation-id',
      status: 999,
      updated_at: now.toISOString(),
      destinationTransactionHash: digest('d'),
    });
    const adapter = new ParticleUniversalAccountAdapter(fake, config());
    await expect(
      adapter.getOperation(ProviderOperationIdSchema.parse('particle-operation-id')),
    ).resolves.toMatchObject({ status: 'unknown', submissionPossible: true });
  });

  it('fails production-like construction without recorded-live schema evidence', () => {
    const fake = sdk(template);
    expect(
      () =>
        new ParticleUniversalAccountAdapter(
          fake,
          config({ environment: 'production', responseProfile: profile }),
        ),
    ).toThrow(expect.objectContaining({ code: 'UA_CONFIGURATION_INVALID' }));
  });

  it('requires exact source-token contracts in live mode and rejects policy expansion', () => {
    const fake = sdk(template);
    const recordedProfile = { ...profile, provenance: 'recorded_live' as const };
    expect(
      () =>
        new ParticleUniversalAccountAdapter(
          fake,
          config({
            environment: 'production',
            responseProfile: recordedProfile,
            allowedSourceTokens: [],
          }),
        ),
    ).toThrow(expect.objectContaining({ code: 'UA_CONFIGURATION_INVALID' }));
    expect(
      () =>
        new ParticleUniversalAccountAdapter(
          fake,
          config({
            environment: 'production',
            responseProfile: recordedProfile,
            allowedSourceTokens: [
              {
                chainId: '56',
                asset: 'USDC',
                address: EvmAddressSchema.parse('0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d'),
              },
            ],
          }),
        ),
    ).toThrow(expect.objectContaining({ code: 'UA_CONFIGURATION_INVALID' }));
  });

  it('rejects unsupported and unsafe chain IDs against installed SDK runtime support', () => {
    const fake = sdk(template);
    for (const chainId of ['10', '999', '9007199254740992']) {
      expect(
        () =>
          new ParticleUniversalAccountAdapter(
            fake,
            config({
              allowedSourceChainIds: [ARBITRUM_ONE_CHAIN_ID, chainId],
              allowedSourceTokens: [],
            }),
          ),
      ).toThrow(expect.objectContaining({ code: 'UA_CONFIGURATION_INVALID' }));
    }
    expect(() =>
      createParticleUniversalAccountAdapter(
        config({
          allowedSourceChainIds: [ARBITRUM_ONE_CHAIN_ID, '10'],
          allowedSourceTokens: [],
        }),
      ),
    ).toThrow(expect.objectContaining({ code: 'UA_CONFIGURATION_INVALID' }));
  });

  it('fails closed when the SDK number representation cannot preserve raw base units', async () => {
    const fake = sdk(template);
    fake.getPrimaryAssets.mockResolvedValueOnce({
      assets: [
        {
          tokenType: 'usdc',
          price: 1,
          amount: 1,
          amountInUSD: 1,
          chainAggregation: [
            {
              token: {
                type: 'usdc',
                chainId: 8453,
                address: usdc,
                symbol: 'USDC',
                decimals: 18,
                realDecimals: 6,
              },
              amount: 1,
              amountInUSD: 1,
              rawAmount: Number.MAX_SAFE_INTEGER + 1,
            },
          ],
        },
      ],
      totalAmountInUSD: 1,
    });
    const adapter = new ParticleUniversalAccountAdapter(fake, config());
    await expect(adapter.getUnifiedBalance()).rejects.toMatchObject({
      code: 'UA_PROVIDER_SCHEMA_INVALID',
    });
  });
});
