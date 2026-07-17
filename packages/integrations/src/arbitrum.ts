import type {
  ArbitrumReadPort,
  ChainBlock,
  Eip7702AuthorizationEvidenceReadPort,
  RawContractLog,
} from '@opentab/application';
import {
  AppError,
  ARBITRUM_ONE_CHAIN_ID,
  type CanonicalEventProof,
  CanonicalEventProofSchema,
  ChainIdSchema,
  type EvmAddress,
  EvmAddressSchema,
  type OrderKey,
  type ProductId,
  type TransactionHash,
  TransactionHashSchema,
} from '@opentab/shared';
import {
  createPublicClient,
  decodeEventLog,
  fallback,
  getAddress,
  type Hex,
  http,
  keccak256,
  parseAbi,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
} from 'viem';
import { recoverAuthorizationAddress } from 'viem/utils';
import { z } from 'zod';
import { arbitrumOneChain } from './arbitrum-chain.js';
import { mapRpcError } from './vendor-errors.js';

const eip7702Designator = /^0xef0100([0-9a-fA-F]{40})$/;
const ERC1155_RECEIVER_INTERFACE_ID = '0x4e2312e0' as const;

const orderPaidAbi = parseAbi([
  'event OrderPaid(bytes32 indexed orderKey,uint256 indexed merchantId,uint256 indexed productId,address payer,address recipient,address token,uint64 quantity,uint256 amount,uint256 platformFee,uint256 passTokenId,uint64 refundDeadline,bytes32 intentDigest)',
]);
const checkoutReadAbi = parseAbi([
  'function getProduct(uint256 productId) view returns ((uint256 merchantId,uint128 unitPrice,uint64 startsAt,uint64 endsAt,uint64 maxSupply,uint64 sold,uint64 maxPerWallet,uint64 version,uint32 loyaltyPoints,uint32 refundWindow,bool active,bytes32 metadataHash))',
  'function platformFeeBps() view returns (uint16)',
]);
const erc165Abi = parseAbi(['function supportsInterface(bytes4 interfaceId) view returns (bool)']);
const erc1155ReceiverAbi = parseAbi([
  'function onERC1155Received(address operator,address from,uint256 id,uint256 value,bytes data) returns (bytes4)',
]);
const ERC1155_RECEIVED_SELECTOR = '0xf23a6e61' as const;

const BlockSchema = z.object({
  number: z.bigint().nonnegative(),
  hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  parentHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  timestamp: z.bigint().nonnegative(),
});
const LogSchema = z.object({
  address: EvmAddressSchema,
  transactionHash: TransactionHashSchema,
  blockNumber: z.bigint().nonnegative(),
  blockHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  logIndex: z.number().int().nonnegative().safe(),
  topics: z.array(z.string().regex(/^0x[0-9a-fA-F]{64}$/)).min(1),
  data: z.string().regex(/^0x[0-9a-fA-F]*$/),
});
const ReceiptSchema = z.object({
  status: z.enum(['success', 'reverted']),
  blockHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  blockNumber: z.bigint().nonnegative(),
});
const TransactionSchema = z.object({
  hash: TransactionHashSchema,
  from: EvmAddressSchema,
  to: EvmAddressSchema.nullable(),
  value: z.bigint().nonnegative(),
  nonce: z.number().int().nonnegative().safe(),
  input: z.string().regex(/^0x[0-9a-fA-F]*$/),
  blockNumber: z.bigint().nonnegative().nullable(),
  blockHash: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .nullable(),
});
const AuthorizationHexSchema = z.string().regex(/^0x[0-9a-fA-F]{1,64}$/);
const SignedAuthorizationSchema = z
  .object({
    address: EvmAddressSchema,
    chainId: z.number().int().nonnegative().safe(),
    nonce: z.number().int().nonnegative().safe(),
    r: AuthorizationHexSchema,
    s: AuthorizationHexSchema,
    yParity: z.union([z.literal(0), z.literal(1)]),
  })
  .strict();
const AuthorizationEvidenceTransactionSchema = z.object({
  hash: TransactionHashSchema,
  from: EvmAddressSchema,
  type: z.string().min(1).max(32),
  chainId: z.number().int().nonnegative().safe(),
  authorizationList: z.unknown().optional(),
  blockNumber: z.bigint().nonnegative().nullable(),
  blockHash: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .nullable(),
});

interface PublicClientLike {
  getChainId(): Promise<number>;
  getBlock(input?: { blockNumber?: bigint }): Promise<unknown>;
  getBlockNumber(): Promise<bigint>;
  getLogs(input: Readonly<Record<string, unknown>>): Promise<unknown>;
  getBalance(input: { address: `0x${string}` }): Promise<bigint>;
  getCode(input: { address: `0x${string}` }): Promise<Hex | undefined>;
  getTransactionReceipt(input: { hash: Hex }): Promise<unknown>;
  getTransaction?(input: { hash: Hex }): Promise<unknown>;
  getTransactionCount?(input: { address: `0x${string}`; blockTag: 'pending' }): Promise<number>;
  readContract(input: Readonly<Record<string, unknown>>): Promise<unknown>;
}

export interface ArbitrumAdapterConfig {
  readonly environment: string;
  readonly primaryRpcUrl: string;
  readonly fallbackRpcUrl: string;
  readonly checkoutAddress: EvmAddress;
  readonly passAddress: EvmAddress;
  readonly splitAddress?: EvmAddress;
  readonly expectedDelegationImplementation?: EvmAddress;
  readonly deploymentBlock: bigint;
  readonly maxLogRange: bigint;
  /** Bounded active-recovery lookup; the indexer owns complete history. */
  readonly maxOrderLookupBlocks: bigint;
  readonly requestTimeoutMs?: number;
  readonly resolveProductOnchainId: (productId: ProductId) => bigint;
}

function validateRpcUrl(value: string, environment: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new AppError('CONFIGURATION_INVALID', 'Arbitrum RPC URL is invalid.', { cause: error });
  }
  const local = ['local', 'test'].includes(environment);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new AppError('CONFIGURATION_INVALID', 'Arbitrum RPC must use HTTPS.');
  }
  if (url.username || url.password) {
    throw new AppError('CONFIGURATION_INVALID', 'RPC credentials cannot be embedded in a URL.');
  }
  return url;
}

function asChainBlock(raw: unknown): ChainBlock {
  const block = BlockSchema.parse(raw);
  return {
    number: block.number.toString(),
    hash: block.hash as `0x${string}`,
    parentHash: block.parentHash as `0x${string}`,
    timestamp: block.timestamp.toString(),
  };
}

function toRawLog(raw: unknown): RawContractLog {
  const log = LogSchema.parse(raw);
  return {
    chainId: ARBITRUM_ONE_CHAIN_ID,
    contractAddress: log.address,
    transactionHash: log.transactionHash,
    blockNumber: log.blockNumber.toString(),
    blockHash: log.blockHash as `0x${string}`,
    logIndex: log.logIndex.toString(),
    topics: log.topics as readonly `0x${string}`[],
    data: log.data as `0x${string}`,
  };
}

export class ViemArbitrumReadAdapter implements ArbitrumReadPort {
  readonly #allowedContracts: ReadonlySet<string>;
  #remoteChainVerified = false;

  constructor(
    private readonly client: PublicClientLike,
    private readonly config: ArbitrumAdapterConfig,
  ) {
    const primary = validateRpcUrl(config.primaryRpcUrl, config.environment);
    const secondary = validateRpcUrl(config.fallbackRpcUrl, config.environment);
    if (primary.hostname.toLowerCase() === secondary.hostname.toLowerCase()) {
      throw new AppError('CONFIGURATION_INVALID', 'Arbitrum RPC providers must be independent.');
    }
    if (
      config.maxLogRange < 1n ||
      config.maxLogRange > 100_000n ||
      config.maxOrderLookupBlocks < config.maxLogRange ||
      config.maxOrderLookupBlocks > 5_000_000n ||
      config.deploymentBlock < 0n
    ) {
      throw new AppError('CONFIGURATION_INVALID', 'Arbitrum scan bounds are invalid.');
    }
    if (
      config.requestTimeoutMs !== undefined &&
      (!Number.isInteger(config.requestTimeoutMs) ||
        config.requestTimeoutMs < 1_000 ||
        config.requestTimeoutMs > 30_000)
    ) {
      throw new AppError('CONFIGURATION_INVALID', 'Arbitrum RPC timeout is invalid.');
    }
    this.#allowedContracts = new Set(
      [config.checkoutAddress, config.passAddress, config.splitAddress]
        .filter((entry): entry is EvmAddress => entry !== undefined)
        .map((entry) => entry.toLowerCase()),
    );
  }

  async getLatestBlock(): Promise<ChainBlock> {
    try {
      await this.#assertRemoteChain();
      return asChainBlock(await this.client.getBlock());
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw mapRpcError(error);
    }
  }

  async getBlock(blockNumber: string): Promise<ChainBlock> {
    try {
      await this.#assertRemoteChain();
      const number = BigInt(blockNumber);
      if (number < 0n) throw new Error('negative block');
      return asChainBlock(await this.client.getBlock({ blockNumber: number }));
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw mapRpcError(error);
    }
  }

  async getLogs(input: {
    fromBlock: string;
    toBlock: string;
    addresses: readonly EvmAddress[];
  }): Promise<readonly RawContractLog[]> {
    const fromBlock = BigInt(input.fromBlock);
    const toBlock = BigInt(input.toBlock);
    if (
      fromBlock < 0n ||
      toBlock < fromBlock ||
      toBlock - fromBlock + 1n > this.config.maxLogRange
    ) {
      throw new AppError('VALIDATION_FAILED', 'The Arbitrum log range is invalid.');
    }
    if (
      input.addresses.length === 0 ||
      input.addresses.some((entry) => !this.#allowedContracts.has(entry.toLowerCase()))
    ) {
      throw new AppError('VALIDATION_FAILED', 'The Arbitrum log address is not allowed.');
    }
    try {
      await this.#assertRemoteChain();
      const raw = await this.client.getLogs({
        fromBlock,
        toBlock,
        address: input.addresses.map((entry) => getAddress(entry)),
      });
      return z.array(z.unknown()).parse(raw).map(toRawLog);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw mapRpcError(error);
    }
  }

  async getNativeBalance(address: EvmAddress): Promise<string> {
    try {
      return (await this.client.getBalance({ address: getAddress(address) })).toString();
    } catch (error) {
      throw mapRpcError(error);
    }
  }

  async getDelegationCode(address: EvmAddress): Promise<{
    accountType: 'eoa' | 'delegated_eoa' | 'contract';
    implementation?: EvmAddress;
    codeHash: `0x${string}`;
  }> {
    try {
      const code = (await this.client.getCode({ address: getAddress(address) })) ?? '0x';
      const match = eip7702Designator.exec(code);
      if (match === null) {
        return { accountType: code === '0x' ? 'eoa' : 'contract', codeHash: keccak256(code) };
      }
      const implementationRaw = match[1];
      if (implementationRaw === undefined) {
        return { accountType: 'contract', codeHash: keccak256(code) };
      }
      const implementation = EvmAddressSchema.parse(`0x${implementationRaw}`);
      return { accountType: 'delegated_eoa', implementation, codeHash: keccak256(code) };
    } catch (error) {
      throw mapRpcError(error);
    }
  }

  async getCodeHash(address: EvmAddress): Promise<`0x${string}`> {
    try {
      const code = (await this.client.getCode({ address: getAddress(address) })) ?? '0x';
      return keccak256(code);
    } catch (error) {
      throw mapRpcError(error);
    }
  }

  async getEip7702AuthorizationEvidence(
    input: Parameters<Eip7702AuthorizationEvidenceReadPort['getEip7702AuthorizationEvidence']>[0],
  ): ReturnType<Eip7702AuthorizationEvidenceReadPort['getEip7702AuthorizationEvidence']> {
    const getTransaction = this.client.getTransaction;
    if (getTransaction === undefined) {
      throw new AppError(
        'CONFIGURATION_INVALID',
        'Arbitrum EIP-7702 transaction evidence reads are unavailable.',
      );
    }

    try {
      const transaction = AuthorizationEvidenceTransactionSchema.parse(
        await getTransaction.call(this.client, { hash: input.transactionHash as Hex }),
      );
      if (transaction.hash.toLowerCase() !== input.transactionHash.toLowerCase()) {
        throw new AppError(
          'RPC_INCONSISTENT',
          'The Arbitrum transaction response does not match the requested hash.',
          { retryable: true },
        );
      }
      if (transaction.type !== 'eip7702') {
        throw new AppError(
          'UA_DELEGATION_REQUIRED',
          'The supplied transaction is not an EIP-7702 authorization transaction.',
        );
      }
      if (transaction.chainId !== Number(ARBITRUM_ONE_CHAIN_ID)) {
        throw new AppError('UA_DELEGATION_REQUIRED', 'The EIP-7702 transaction chain is invalid.');
      }
      if (transaction.blockNumber === null || transaction.blockHash === null) {
        throw new AppError(
          'PAYMENT_NOT_CANONICAL',
          'The EIP-7702 transaction is not yet canonical.',
          { retryable: true },
        );
      }

      const authorizationList = z
        .array(SignedAuthorizationSchema)
        .length(1)
        .safeParse(transaction.authorizationList);
      if (!authorizationList.success) {
        throw new AppError(
          'UA_PROVIDER_SCHEMA_INVALID',
          'The EIP-7702 authorization list is invalid.',
          { cause: authorizationList.error },
        );
      }
      const authorization = authorizationList.data[0];
      if (authorization === undefined) {
        throw new AppError('UA_PROVIDER_SCHEMA_INVALID', 'The EIP-7702 authorization is missing.');
      }
      if (
        authorization.chainId !== Number(ARBITRUM_ONE_CHAIN_ID) ||
        !sameAddress(authorization.address, input.expectedDelegate)
      ) {
        throw new AppError(
          'UA_DELEGATION_REQUIRED',
          'The EIP-7702 authorization does not match the trusted delegation.',
        );
      }

      let authority: EvmAddress;
      try {
        authority = EvmAddressSchema.parse(
          await recoverAuthorizationAddress({
            authorization: {
              address: getAddress(authorization.address),
              chainId: authorization.chainId,
              nonce: authorization.nonce,
              r: authorization.r as Hex,
              s: authorization.s as Hex,
              yParity: authorization.yParity,
            },
          }),
        );
      } catch (error) {
        throw new AppError(
          'UA_PROVIDER_SCHEMA_INVALID',
          'The EIP-7702 authorization signature is invalid.',
          { cause: error },
        );
      }
      if (!sameAddress(authority, input.expectedAuthority)) {
        throw new AppError(
          'UA_DELEGATION_REQUIRED',
          'The EIP-7702 authorization authority does not match the authenticated wallet.',
        );
      }

      const receipt = ReceiptSchema.parse(
        await this.client.getTransactionReceipt({ hash: input.transactionHash as Hex }),
      );
      const canonicalBlock = BlockSchema.parse(
        await this.client.getBlock({ blockNumber: transaction.blockNumber }),
      );
      if (receipt.status !== 'success') {
        throw new AppError(
          'UA_DELEGATION_REQUIRED',
          'The EIP-7702 transaction did not complete successfully.',
        );
      }
      if (
        receipt.blockNumber !== transaction.blockNumber ||
        receipt.blockHash.toLowerCase() !== transaction.blockHash.toLowerCase() ||
        canonicalBlock.number !== transaction.blockNumber ||
        canonicalBlock.hash.toLowerCase() !== transaction.blockHash.toLowerCase()
      ) {
        throw new AppError(
          'PAYMENT_NOT_CANONICAL',
          'The EIP-7702 transaction receipt is not canonical.',
        );
      }

      return {
        transactionHash: transaction.hash,
        transactionFrom: transaction.from,
        transactionType: 'eip7702',
        blockNumber: transaction.blockNumber.toString(),
        blockHash: transaction.blockHash as `0x${string}`,
        authority,
        delegate: authorization.address,
        chainId: ARBITRUM_ONE_CHAIN_ID,
        authorizationIndex: 0,
        authorizationNonce: authorization.nonce.toString(),
        canonical: true,
      };
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (
        error instanceof TransactionNotFoundError ||
        error instanceof TransactionReceiptNotFoundError
      ) {
        throw new AppError(
          'PAYMENT_NOT_CANONICAL',
          'The EIP-7702 transaction is not yet canonical.',
          { retryable: true, cause: error },
        );
      }
      if (error instanceof z.ZodError) {
        throw new AppError(
          'UA_PROVIDER_SCHEMA_INVALID',
          'The Arbitrum EIP-7702 transaction response is invalid.',
          { cause: error },
        );
      }
      throw mapRpcError(error);
    }
  }

  async getTransactionReceipt(
    hash: TransactionHash,
  ): Promise<{ success: boolean; blockHash: `0x${string}`; blockNumber: string }> {
    try {
      const receipt = ReceiptSchema.parse(
        await this.client.getTransactionReceipt({ hash: hash as Hex }),
      );
      return {
        success: receipt.status === 'success',
        blockHash: receipt.blockHash as `0x${string}`,
        blockNumber: receipt.blockNumber.toString(),
      };
    } catch (error) {
      throw mapRpcError(error);
    }
  }

  async findTransaction(hash: TransactionHash) {
    const getTransaction = this.client.getTransaction;
    if (getTransaction === undefined) {
      throw new AppError('CONFIGURATION_INVALID', 'Arbitrum transaction reads are unavailable.');
    }
    try {
      const transaction = TransactionSchema.parse(
        await getTransaction.call(this.client, { hash: hash as Hex }),
      );
      return {
        hash: transaction.hash,
        from: transaction.from,
        ...(transaction.to === null ? {} : { to: transaction.to }),
        valueWei: transaction.value.toString(),
        nonce: transaction.nonce.toString(),
        input: transaction.input as `0x${string}`,
        ...(transaction.blockNumber === null
          ? {}
          : { blockNumber: transaction.blockNumber.toString() }),
        ...(transaction.blockHash === null
          ? {}
          : { blockHash: transaction.blockHash as `0x${string}` }),
      };
    } catch (error) {
      if (error instanceof TransactionNotFoundError) return undefined;
      throw mapRpcError(error);
    }
  }

  async findTransactionReceipt(hash: TransactionHash) {
    try {
      const receipt = ReceiptSchema.parse(
        await this.client.getTransactionReceipt({ hash: hash as Hex }),
      );
      return {
        success: receipt.status === 'success',
        blockHash: receipt.blockHash as `0x${string}`,
        blockNumber: receipt.blockNumber.toString(),
      };
    } catch (error) {
      if (error instanceof TransactionReceiptNotFoundError) return undefined;
      throw mapRpcError(error);
    }
  }

  async getPendingTransactionCount(address: EvmAddress): Promise<string> {
    const getTransactionCount = this.client.getTransactionCount;
    if (getTransactionCount === undefined) {
      throw new AppError('CONFIGURATION_INVALID', 'Arbitrum nonce reads are unavailable.');
    }
    try {
      return (
        await getTransactionCount.call(this.client, {
          address: getAddress(address),
          blockTag: 'pending',
        })
      ).toString();
    } catch (error) {
      throw mapRpcError(error);
    }
  }

  async findOrderEvent(orderKey: OrderKey): Promise<CanonicalEventProof | undefined> {
    try {
      await this.#assertRemoteChain();
      const latest = await this.client.getBlockNumber();
      if (latest < this.config.deploymentBlock) return undefined;
      const boundedFrom = latest - this.config.maxOrderLookupBlocks + 1n;
      const lookupFloor =
        boundedFrom < this.config.deploymentBlock ? this.config.deploymentBlock : boundedFrom;
      let toBlock = latest;
      while (toBlock >= lookupFloor) {
        const possibleFrom = toBlock - this.config.maxLogRange + 1n;
        const fromBlock = possibleFrom < lookupFloor ? lookupFloor : possibleFrom;
        const raw = z.array(z.unknown()).parse(
          await this.client.getLogs({
            address: getAddress(this.config.checkoutAddress),
            event: orderPaidAbi[0],
            args: { orderKey: orderKey as Hex },
            fromBlock,
            toBlock,
          }),
        );
        if (raw.length > 0) {
          const log = LogSchema.parse(raw.at(-1));
          const receipt = ReceiptSchema.parse(
            await this.client.getTransactionReceipt({ hash: log.transactionHash as Hex }),
          );
          const canonicalBlock = BlockSchema.parse(
            await this.client.getBlock({ blockNumber: log.blockNumber }),
          );
          if (
            receipt.status !== 'success' ||
            receipt.blockHash.toLowerCase() !== log.blockHash.toLowerCase() ||
            receipt.blockNumber !== log.blockNumber ||
            !sameAddress(log.address, this.config.checkoutAddress) ||
            canonicalBlock.hash.toLowerCase() !== log.blockHash.toLowerCase()
          ) {
            throw new AppError('PAYMENT_NOT_CANONICAL', 'The order event is not canonical.');
          }
          const decoded = decodeEventLog({
            abi: orderPaidAbi,
            data: log.data as Hex,
            topics: log.topics as [Hex, ...Hex[]],
            strict: true,
          });
          if (decoded.eventName !== 'OrderPaid') {
            throw new AppError('PAYMENT_EVENT_MISMATCH', 'The Arbitrum order event is invalid.');
          }
          const args = decoded.args;
          if (args.orderKey.toLowerCase() !== orderKey.toLowerCase()) {
            throw new AppError('PAYMENT_EVENT_MISMATCH', 'The Arbitrum order key is invalid.');
          }
          return CanonicalEventProofSchema.parse({
            eventName: 'OrderPaid',
            chainId: ARBITRUM_ONE_CHAIN_ID,
            contractAddress: this.config.checkoutAddress,
            transactionHash: log.transactionHash,
            blockNumber: log.blockNumber.toString(),
            blockHash: log.blockHash,
            logIndex: log.logIndex.toString(),
            confirmations: (latest - log.blockNumber + 1n).toString(),
            canonical: true,
            observedAt: new Date().toISOString(),
            fields: {
              orderKey: args.orderKey,
              merchantOnchainId: args.merchantId.toString(),
              productOnchainId: args.productId.toString(),
              payer: args.payer,
              recipient: args.recipient,
              token: args.token,
              quantity: args.quantity.toString(),
              amountBaseUnits: args.amount.toString(),
              platformFeeBaseUnits: args.platformFee.toString(),
              intentDigest: args.intentDigest,
              passTokenId: args.passTokenId.toString(),
              refundDeadline: args.refundDeadline.toString(),
            },
          });
        }
        if (fromBlock === lookupFloor) break;
        toBlock = fromBlock - 1n;
      }
      return undefined;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw mapRpcError(error);
    }
  }

  async readProduct(productId: ProductId): Promise<unknown> {
    try {
      const onchainId = this.config.resolveProductOnchainId(productId);
      if (onchainId <= 0n) throw new Error('invalid product ID');
      return await this.client.readContract({
        address: getAddress(this.config.checkoutAddress),
        abi: checkoutReadAbi,
        functionName: 'getProduct',
        args: [onchainId],
      });
    } catch (error) {
      throw mapRpcError(error);
    }
  }

  async readPlatformFeeBps(): Promise<string> {
    try {
      const raw = await this.client.readContract({
        address: getAddress(this.config.checkoutAddress),
        abi: checkoutReadAbi,
        functionName: 'platformFeeBps',
      });
      const value =
        typeof raw === 'bigint' ? raw : BigInt(z.number().int().nonnegative().parse(raw));
      if (value > 500n) {
        throw new AppError('CONFIGURATION_INVALID', 'The checkout platform fee exceeds its cap.');
      }
      return value.toString();
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw mapRpcError(error);
    }
  }

  /** Mandatory live compatibility check for safe ERC-1155 minting to a delegated EOA. */
  async assertDelegatedErc1155Receiver(address: EvmAddress): Promise<void> {
    const expectedDelegationImplementation = this.config.expectedDelegationImplementation;
    if (expectedDelegationImplementation === undefined) {
      throw new AppError(
        'CONFIGURATION_INVALID',
        'Delegated receiver checks require a reviewed EIP-7702 implementation address.',
      );
    }
    const evidence = await this.getDelegationCode(address);
    if (
      evidence.implementation === undefined ||
      !sameAddress(evidence.implementation, expectedDelegationImplementation)
    ) {
      throw new AppError(
        'UA_DELEGATION_REQUIRED',
        'The expected EIP-7702 delegation is not active.',
      );
    }
    try {
      const supported = z.boolean().parse(
        await this.client.readContract({
          address: getAddress(address),
          abi: erc165Abi,
          functionName: 'supportsInterface',
          args: [ERC1155_RECEIVER_INTERFACE_ID],
        }),
      );
      if (!supported) {
        throw new AppError(
          'CONFIGURATION_INVALID',
          'The delegated account cannot safely receive the OpenTab pass.',
        );
      }
      const selector = z
        .string()
        .regex(/^0x[0-9a-fA-F]{8}$/)
        .parse(
          await this.client.readContract({
            address: getAddress(address),
            abi: erc1155ReceiverAbi,
            functionName: 'onERC1155Received',
            account: getAddress(this.config.passAddress),
            args: [
              getAddress(this.config.checkoutAddress),
              '0x0000000000000000000000000000000000000000',
              1n,
              1n,
              '0x',
            ],
          }),
        );
      if (selector.toLowerCase() !== ERC1155_RECEIVED_SELECTOR) {
        throw new AppError(
          'CONFIGURATION_INVALID',
          'The delegated account returned an invalid ERC-1155 receiver selector.',
        );
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        'CONFIGURATION_INVALID',
        'ERC-1155 receiver compatibility could not be verified.',
        { cause: error },
      );
    }
  }

  async #assertRemoteChain(): Promise<void> {
    if (this.#remoteChainVerified) return;
    const remoteChainId = z
      .number()
      .int()
      .positive()
      .safe()
      .parse(await this.client.getChainId());
    if (remoteChainId !== Number(ARBITRUM_ONE_CHAIN_ID)) {
      throw new AppError(
        'RPC_INCONSISTENT',
        'The Arbitrum RPC endpoint returned an unexpected chain ID.',
        { retryable: true },
      );
    }
    this.#remoteChainVerified = true;
  }
}

function sameAddress(left: EvmAddress, right: EvmAddress): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

export function createViemArbitrumReadAdapter(
  config: ArbitrumAdapterConfig,
): ViemArbitrumReadAdapter {
  validateRpcUrl(config.primaryRpcUrl, config.environment);
  validateRpcUrl(config.fallbackRpcUrl, config.environment);
  const timeout = config.requestTimeoutMs ?? 12_000;
  const client = createPublicClient({
    chain: arbitrumOneChain,
    transport: fallback(
      [
        http(config.primaryRpcUrl, { timeout, retryCount: 2 }),
        http(config.fallbackRpcUrl, { timeout, retryCount: 2 }),
      ],
      { rank: false, retryCount: 1 },
    ),
  });
  if (client.chain?.id !== Number(ARBITRUM_ONE_CHAIN_ID)) {
    throw new AppError('CONFIGURATION_INVALID', 'Arbitrum client chain is invalid.');
  }
  return new ViemArbitrumReadAdapter(client as unknown as PublicClientLike, config);
}

export const ARBITRUM_ADAPTER_CHAIN_ID = ChainIdSchema.parse(arbitrumOneChain.id.toString());
