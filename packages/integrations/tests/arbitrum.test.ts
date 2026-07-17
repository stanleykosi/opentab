import {
  type EvmAddress,
  EvmAddressSchema,
  OrderKeySchema,
  ProductIdSchema,
  TransactionHashSchema,
} from '@opentab/shared';
import {
  encodeAbiParameters,
  encodeEventTopics,
  type Hex,
  parseAbi,
  parseAbiParameters,
  type SignedAuthorization,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it, vi } from 'vitest';
import { ViemArbitrumReadAdapter } from '../src/arbitrum.js';
import { arbitrumOneChain } from '../src/arbitrum-chain.js';

const checkout = EvmAddressSchema.parse(`0x${'1'.repeat(40)}`);
const pass = EvmAddressSchema.parse(`0x${'2'.repeat(40)}`);
const implementation = EvmAddressSchema.parse(`0x${'3'.repeat(40)}`);
const payer = EvmAddressSchema.parse(`0x${'4'.repeat(40)}`);
const token = EvmAddressSchema.parse('0xaf88d065e77c8cC2239327C5EDb3A432268e5831');
const orderKey = OrderKeySchema.parse(`0x${'5'.repeat(64)}`);
const transactionHash = TransactionHashSchema.parse(`0x${'6'.repeat(64)}`);
const blockHash = `0x${'7'.repeat(64)}` as const;
const parentHash = `0x${'8'.repeat(64)}` as const;
const intentDigest = `0x${'9'.repeat(64)}` as const;

const orderPaidAbi = parseAbi([
  'event OrderPaid(bytes32 indexed orderKey,uint256 indexed merchantId,uint256 indexed productId,address payer,address recipient,address token,uint64 quantity,uint256 amount,uint256 platformFee,uint256 passTokenId,uint64 refundDeadline,bytes32 intentDigest)',
]);

function orderPaidLog() {
  const topics = encodeEventTopics({
    abi: orderPaidAbi,
    eventName: 'OrderPaid',
    args: { orderKey: orderKey as Hex, merchantId: 1n, productId: 2n },
  });
  return {
    address: checkout,
    transactionHash,
    blockNumber: 120n,
    blockHash,
    logIndex: 3,
    topics,
    data: encodeAbiParameters(
      parseAbiParameters(
        'address payer,address recipient,address token,uint64 quantity,uint256 amount,uint256 platformFee,uint256 passTokenId,uint64 refundDeadline,bytes32 intentDigest',
      ),
      [
        payer as Hex,
        payer as Hex,
        token as Hex,
        1n,
        1_000_000n,
        10_000n,
        42n,
        1_784_034_300n,
        intentDigest,
      ],
    ),
  };
}

function client(overrides: Record<string, unknown> = {}) {
  return {
    getChainId: vi.fn(async () => 42_161),
    getBlock: vi.fn(async (_input?: { blockNumber?: bigint }) => ({
      number: 120n,
      hash: blockHash,
      parentHash,
      timestamp: 1_784_030_000n,
    })),
    getBlockNumber: vi.fn(async () => 125n),
    getLogs: vi.fn(
      async (_input: Readonly<Record<string, unknown>>): Promise<unknown[]> => [orderPaidLog()],
    ),
    getBalance: vi.fn(async (_input: { address: Hex }) => 1_000n),
    getCode: vi.fn(async (_input: { address: Hex }): Promise<Hex | undefined> => '0x'),
    getTransactionReceipt: vi.fn(async (_input: { hash: Hex }) => ({
      status: 'success' as const,
      blockHash,
      blockNumber: 120n,
    })),
    readContract: vi.fn(
      async (_input: Readonly<Record<string, unknown>>): Promise<unknown> => true,
    ),
    ...overrides,
  };
}

function config(overrides: Record<string, unknown> = {}) {
  return {
    environment: 'test',
    primaryRpcUrl: 'https://arb-primary.example',
    fallbackRpcUrl: 'https://arb-fallback.example',
    checkoutAddress: checkout,
    passAddress: pass,
    expectedDelegationImplementation: implementation,
    deploymentBlock: 100n,
    maxLogRange: 10n,
    maxOrderLookupBlocks: 30n,
    requestTimeoutMs: 12_000,
    resolveProductOnchainId: () => 2n,
    ...overrides,
  };
}

async function createSignedAuthorization(
  input: { delegate?: EvmAddress; chainId?: number; nonce?: number } = {},
): Promise<{
  authority: ReturnType<typeof privateKeyToAccount>;
  authorization: SignedAuthorization;
}> {
  const authority = privateKeyToAccount(generatePrivateKey());
  const signed = await authority.signAuthorization({
    address: (input.delegate ?? implementation) as `0x${string}`,
    chainId: input.chainId ?? 42_161,
    nonce: input.nonce ?? 7,
  });
  if (signed.yParity !== 0 && signed.yParity !== 1) {
    throw new Error('viem returned an invalid authorization yParity');
  }
  return {
    authority,
    authorization: {
      address: signed.address,
      chainId: signed.chainId,
      nonce: signed.nonce,
      r: signed.r,
      s: signed.s,
      yParity: signed.yParity,
    },
  };
}

function type4Transaction(
  from: EvmAddress,
  authorization: SignedAuthorization,
  overrides: Record<string, unknown> = {},
) {
  return {
    hash: transactionHash,
    from,
    to: from,
    value: 0n,
    nonce: 8,
    input: '0x' as const,
    blockNumber: 120n,
    blockHash,
    type: 'eip7702' as const,
    chainId: 42_161,
    authorizationList: [authorization],
    ...overrides,
  };
}

describe('Arbitrum read and payment-proof adapter', () => {
  it('pins the reviewed Arbitrum One descriptor without an aggregate chain import', () => {
    expect(arbitrumOneChain.id).toBe(42_161);
    expect(arbitrumOneChain.name).toBe('Arbitrum One');
    expect(arbitrumOneChain.rpcUrls.default.http).toEqual(['https://arb1.arbitrum.io/rpc']);
    expect(arbitrumOneChain.blockExplorers.default.url).toBe('https://arbiscan.io');
  });

  it('rejects a wrong-chain RPC before returning a scanner head', async () => {
    const adapter = new ViemArbitrumReadAdapter(
      client({ getChainId: vi.fn(async () => 1) }),
      config({ environment: 'production' }),
    );
    await expect(adapter.getLatestBlock()).rejects.toMatchObject({ code: 'RPC_INCONSISTENT' });
  });
  it('requires HTTPS and independent provider hostnames outside local mode', () => {
    expect(
      () =>
        new ViemArbitrumReadAdapter(
          client(),
          config({ environment: 'production', primaryRpcUrl: 'http://arb-primary.example' }),
        ),
    ).toThrow(expect.objectContaining({ code: 'CONFIGURATION_INVALID' }));
    expect(
      () =>
        new ViemArbitrumReadAdapter(
          client(),
          config({ fallbackRpcUrl: 'https://arb-primary.example/second-key' }),
        ),
    ).toThrow(expect.objectContaining({ code: 'CONFIGURATION_INVALID' }));
    expect(() => new ViemArbitrumReadAdapter(client(), config({ requestTimeoutMs: 100 }))).toThrow(
      expect.objectContaining({ code: 'CONFIGURATION_INVALID' }),
    );
  });

  it('distinguishes an EOA, exact EIP-7702 designator, and ordinary contract code', async () => {
    const fake = client();
    const adapter = new ViemArbitrumReadAdapter(fake, config());
    await expect(adapter.getDelegationCode(payer)).resolves.toMatchObject({ accountType: 'eoa' });

    fake.getCode.mockResolvedValueOnce(`0xef0100${implementation.slice(2)}` as `0x${string}`);
    await expect(adapter.getDelegationCode(payer)).resolves.toMatchObject({
      accountType: 'delegated_eoa',
      implementation,
    });

    fake.getCode.mockResolvedValueOnce('0x60016000' as const);
    await expect(adapter.getDelegationCode(payer)).resolves.toMatchObject({
      accountType: 'contract',
    });
  });

  it('recovers the exact authority from one canonical viem-normalized Type-4 authorization', async () => {
    const { authority, authorization } = await createSignedAuthorization({ nonce: 9 });
    const actor = EvmAddressSchema.parse(authority.address);
    const fake = client({
      getTransaction: vi.fn(async () => type4Transaction(actor, authorization)),
    });

    await expect(
      new ViemArbitrumReadAdapter(fake, config()).getEip7702AuthorizationEvidence({
        transactionHash,
        expectedAuthority: actor,
        expectedDelegate: implementation,
      }),
    ).resolves.toEqual({
      transactionHash,
      transactionFrom: actor,
      transactionType: 'eip7702',
      blockNumber: '120',
      blockHash,
      authority: actor,
      delegate: implementation,
      chainId: '42161',
      authorizationIndex: 0,
      authorizationNonce: '9',
      canonical: true,
    });
  });

  it('rejects an unrelated non-Type-4 transaction', async () => {
    const { authority, authorization } = await createSignedAuthorization();
    const actor = EvmAddressSchema.parse(authority.address);
    const fake = client({
      getTransaction: vi.fn(async () =>
        type4Transaction(actor, authorization, {
          type: 'eip1559',
          authorizationList: undefined,
        }),
      ),
    });

    await expect(
      new ViemArbitrumReadAdapter(fake, config()).getEip7702AuthorizationEvidence({
        transactionHash,
        expectedAuthority: actor,
        expectedDelegate: implementation,
      }),
    ).rejects.toMatchObject({ code: 'UA_DELEGATION_REQUIRED' });
  });

  it('rejects a Type-4 authorization signed by a different authority', async () => {
    const { authorization } = await createSignedAuthorization();
    const expected = privateKeyToAccount(generatePrivateKey());
    const actor = EvmAddressSchema.parse(expected.address);
    const fake = client({
      getTransaction: vi.fn(async () => type4Transaction(actor, authorization)),
    });

    await expect(
      new ViemArbitrumReadAdapter(fake, config()).getEip7702AuthorizationEvidence({
        transactionHash,
        expectedAuthority: actor,
        expectedDelegate: implementation,
      }),
    ).rejects.toMatchObject({ code: 'UA_DELEGATION_REQUIRED' });
  });

  it('rejects a Type-4 transaction whose own chain ID is not Arbitrum One', async () => {
    const { authority, authorization } = await createSignedAuthorization();
    const actor = EvmAddressSchema.parse(authority.address);
    const fake = client({
      getTransaction: vi.fn(async () => type4Transaction(actor, authorization, { chainId: 1 })),
    });

    await expect(
      new ViemArbitrumReadAdapter(fake, config()).getEip7702AuthorizationEvidence({
        transactionHash,
        expectedAuthority: actor,
        expectedDelegate: implementation,
      }),
    ).rejects.toMatchObject({ code: 'UA_DELEGATION_REQUIRED' });
  });

  it('rejects wildcard, foreign-chain, and wrong-delegate authorizations', async () => {
    for (const input of [{ chainId: 0 }, { chainId: 1 }, { delegate: checkout }] as const) {
      const { authority, authorization } = await createSignedAuthorization(input);
      const actor = EvmAddressSchema.parse(authority.address);
      const fake = client({
        getTransaction: vi.fn(async () => type4Transaction(actor, authorization)),
      });
      await expect(
        new ViemArbitrumReadAdapter(fake, config()).getEip7702AuthorizationEvidence({
          transactionHash,
          expectedAuthority: actor,
          expectedDelegate: implementation,
        }),
      ).rejects.toMatchObject({ code: 'UA_DELEGATION_REQUIRED' });
    }
  });

  it('rejects multiple authorizations and receipt or canonical-block divergence', async () => {
    const { authority, authorization } = await createSignedAuthorization();
    const actor = EvmAddressSchema.parse(authority.address);
    const multiple = client({
      getTransaction: vi.fn(async () =>
        type4Transaction(actor, authorization, {
          authorizationList: [authorization, authorization],
        }),
      ),
    });
    await expect(
      new ViemArbitrumReadAdapter(multiple, config()).getEip7702AuthorizationEvidence({
        transactionHash,
        expectedAuthority: actor,
        expectedDelegate: implementation,
      }),
    ).rejects.toMatchObject({ code: 'UA_PROVIDER_SCHEMA_INVALID' });

    const nonCanonical = client({
      getTransaction: vi.fn(async () => type4Transaction(actor, authorization)),
      getTransactionReceipt: vi.fn(async () => ({
        status: 'success' as const,
        blockHash: `0x${'a'.repeat(64)}`,
        blockNumber: 120n,
      })),
    });
    await expect(
      new ViemArbitrumReadAdapter(nonCanonical, config()).getEip7702AuthorizationEvidence({
        transactionHash,
        expectedAuthority: actor,
        expectedDelegate: implementation,
      }),
    ).rejects.toMatchObject({ code: 'PAYMENT_NOT_CANONICAL' });

    const canonicalBlockMismatch = client({
      getTransaction: vi.fn(async () => type4Transaction(actor, authorization)),
      getBlock: vi.fn(async () => ({
        number: 120n,
        hash: `0x${'b'.repeat(64)}`,
        parentHash,
        timestamp: 1_784_030_000n,
      })),
    });
    await expect(
      new ViemArbitrumReadAdapter(canonicalBlockMismatch, config()).getEip7702AuthorizationEvidence(
        {
          transactionHash,
          expectedAuthority: actor,
          expectedDelegate: implementation,
        },
      ),
    ).rejects.toMatchObject({ code: 'PAYMENT_NOT_CANONICAL' });

    const reverted = client({
      getTransaction: vi.fn(async () => type4Transaction(actor, authorization)),
      getTransactionReceipt: vi.fn(async () => ({
        status: 'reverted' as const,
        blockHash,
        blockNumber: 120n,
      })),
    });
    await expect(
      new ViemArbitrumReadAdapter(reverted, config()).getEip7702AuthorizationEvidence({
        transactionHash,
        expectedAuthority: actor,
        expectedDelegate: implementation,
      }),
    ).rejects.toMatchObject({ code: 'UA_DELEGATION_REQUIRED' });
  });

  it('returns paid proof only after receipt, canonical block, contract, key, and event decoding agree', async () => {
    const adapter = new ViemArbitrumReadAdapter(client(), config());
    const proof = await adapter.findOrderEvent(orderKey);
    expect(proof).toMatchObject({
      eventName: 'OrderPaid',
      contractAddress: checkout,
      transactionHash,
      blockNumber: '120',
      blockHash,
      confirmations: '6',
      canonical: true,
      fields: {
        orderKey,
        merchantOnchainId: '1',
        productOnchainId: '2',
        payer,
        token,
        amountBaseUnits: '1000000',
        passTokenId: '42',
      },
    });
  });

  it('rejects a receipt or canonical block divergence', async () => {
    const fake = client();
    fake.getTransactionReceipt.mockResolvedValueOnce({
      status: 'success',
      blockHash: `0x${'a'.repeat(64)}`,
      blockNumber: 120n,
    });
    await expect(
      new ViemArbitrumReadAdapter(fake, config()).findOrderEvent(orderKey),
    ).rejects.toMatchObject({ code: 'PAYMENT_NOT_CANONICAL' });
  });

  it('bounds active recovery lookups while leaving full history to the indexer', async () => {
    const fake = client();
    fake.getBlockNumber.mockResolvedValueOnce(150n);
    fake.getLogs.mockResolvedValue([]);
    const adapter = new ViemArbitrumReadAdapter(fake, config());
    await expect(adapter.findOrderEvent(orderKey)).resolves.toBeUndefined();
    expect(fake.getLogs.mock.calls.map(([call]) => [call.fromBlock, call.toBlock])).toEqual([
      [141n, 150n],
      [131n, 140n],
      [121n, 130n],
    ]);
  });

  it('enforces log address/range allowlists and delegated ERC-1155 receiver compatibility', async () => {
    const fake = client();
    const adapter = new ViemArbitrumReadAdapter(fake, config());
    await expect(
      adapter.getLogs({ fromBlock: '100', toBlock: '111', addresses: [checkout] }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      adapter.getLogs({ fromBlock: '100', toBlock: '100', addresses: [payer] }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    fake.getCode.mockResolvedValue(`0xef0100${implementation.slice(2)}` as `0x${string}`);
    fake.readContract.mockResolvedValueOnce(true).mockResolvedValueOnce('0xf23a6e61');
    await expect(adapter.assertDelegatedErc1155Receiver(payer)).resolves.toBeUndefined();
    fake.readContract.mockResolvedValueOnce(false);
    await expect(adapter.assertDelegatedErc1155Receiver(payer)).rejects.toMatchObject({
      code: 'CONFIGURATION_INVALID',
    });
    fake.readContract.mockResolvedValueOnce(true).mockResolvedValueOnce('0xdeadbeef');
    await expect(adapter.assertDelegatedErc1155Receiver(payer)).rejects.toMatchObject({
      code: 'CONFIGURATION_INVALID',
    });
    fake.readContract
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error('receiver reverted'));
    await expect(adapter.assertDelegatedErc1155Receiver(payer)).rejects.toMatchObject({
      code: 'CONFIGURATION_INVALID',
    });
  });

  it('resolves opaque product IDs only through the trusted application mapping', async () => {
    const fake = client();
    const resolver = vi.fn(() => 2n);
    const adapter = new ViemArbitrumReadAdapter(
      fake,
      config({ resolveProductOnchainId: resolver }),
    );
    const productId = ProductIdSchema.parse('prd_01J00000000000000000000000');
    await adapter.readProduct(productId);
    expect(resolver).toHaveBeenCalledWith(productId);
  });

  it('reads and bounds the checkout fee used by the server signer', async () => {
    const fake = client({ readContract: vi.fn(async () => 125) });
    await expect(new ViemArbitrumReadAdapter(fake, config()).readPlatformFeeBps()).resolves.toBe(
      '125',
    );

    fake.readContract.mockResolvedValueOnce(501);
    await expect(
      new ViemArbitrumReadAdapter(fake, config()).readPlatformFeeBps(),
    ).rejects.toMatchObject({ code: 'CONFIGURATION_INVALID' });
  });
});
