import type { SponsorTransferPort } from '@opentab/application';
import {
  AppError,
  ARBITRUM_ONE_CHAIN_ID,
  type BaseUnitAmount,
  BaseUnitAmountSchema,
  type ChainId,
  type EvmAddress,
  EvmAddressSchema,
  sameEvmAddress,
  TransactionHashSchema,
} from '@opentab/shared';
import {
  createPublicClient,
  fallback,
  getAddress,
  type Hex,
  http,
  keccak256,
  parseSignature,
  serializeTransaction,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrumOneChain } from './arbitrum-chain.js';
import { type AwsKmsClientLike, AwsKmsSecp256k1Signer, createAwsKmsClient } from './aws-kms.js';
import { mapRpcError } from './vendor-errors.js';

interface SponsorChainClientLike {
  getBalance(input: { address: `0x${string}` }): Promise<bigint>;
  getCode(input: { address: `0x${string}` }): Promise<Hex | undefined>;
  getTransactionCount(input: { address: `0x${string}`; blockTag: 'pending' }): Promise<number>;
}

interface ManagedSponsorChainClientLike extends SponsorChainClientLike {
  estimateFeesPerGas(input: { type: 'eip1559' }): Promise<{
    maxFeePerGas?: bigint;
    maxPriorityFeePerGas?: bigint;
  }>;
  sendRawTransaction(input: { serializedTransaction: Hex }): Promise<Hex>;
}

interface SponsorSignerLike {
  readonly address: EvmAddress;
  prepareNativeTransfer(input: {
    recipient: EvmAddress;
    amountWei: bigint;
    nonce: number;
  }): Promise<{
    transactionHash: Hex;
    broadcast(): Promise<Hex>;
  }>;
}

export interface SponsorTransferConfig {
  readonly environment: string;
  readonly maxGrantWei: bigint;
  readonly minimumGrantWei: bigint;
  readonly allowlistOnly: boolean;
  readonly allowedRecipients: readonly EvmAddress[];
  /** Hard cap for the plain-transfer EIP-1559 fee quote. Required by KMS mode. */
  readonly maxFeePerGasWei?: bigint;
  /** Per-request transport timeout used by concrete RPC-backed factories. */
  readonly requestTimeoutMs?: number;
}

type TransferResult =
  | {
      status: 'submitted';
      transactionHash: ReturnType<typeof TransactionHashSchema.parse>;
      signerNonce: string;
    }
  | {
      status: 'submitted_unknown';
      transactionHash: ReturnType<typeof TransactionHashSchema.parse>;
      signerNonce: string;
    };

export class PolicyBoundSponsorTransferAdapter implements SponsorTransferPort {
  readonly #allowlist: ReadonlySet<string>;
  readonly #results = new Map<string, TransferResult>();

  constructor(
    private readonly chain: SponsorChainClientLike,
    private readonly signer: SponsorSignerLike,
    private readonly config: SponsorTransferConfig,
  ) {
    if (
      config.minimumGrantWei <= 0n ||
      config.maxGrantWei < config.minimumGrantWei ||
      (config.maxFeePerGasWei !== undefined && config.maxFeePerGasWei <= 0n) ||
      (config.allowlistOnly && config.allowedRecipients.length === 0)
    ) {
      throw new AppError('CONFIGURATION_INVALID', 'Sponsor transfer policy is invalid.');
    }
    this.#allowlist = new Set(config.allowedRecipients.map((entry) => entry.toLowerCase()));
  }

  async getSignerHealth(input: { chainId: ChainId }) {
    if (input.chainId !== ARBITRUM_ONE_CHAIN_ID) {
      throw new AppError('CONFIGURATION_INVALID', 'Sponsor is restricted to Arbitrum One.');
    }
    try {
      const [balance, pendingNonce] = await Promise.all([
        this.chain.getBalance({ address: getAddress(this.signer.address) }),
        this.chain.getTransactionCount({
          address: getAddress(this.signer.address),
          blockTag: 'pending',
        }),
      ]);
      return {
        signerAddress: this.signer.address,
        balanceWei: BaseUnitAmountSchema.parse(balance.toString()),
        pendingNonce: pendingNonce.toString(),
        observedAt: new Date().toISOString(),
      };
    } catch (error) {
      throw mapRpcError(error);
    }
  }

  async prepareActivationGas(input: {
    chainId: ChainId;
    recipient: EvmAddress;
    amountWei: BaseUnitAmount;
    idempotencyReference: string;
    signerNonce: string;
  }) {
    if (input.chainId !== ARBITRUM_ONE_CHAIN_ID) {
      throw new AppError('CONFIGURATION_INVALID', 'Sponsor is restricted to Arbitrum One.');
    }
    if (!/^[A-Za-z0-9_-]{8,160}$/.test(input.idempotencyReference)) {
      throw new AppError('VALIDATION_FAILED', 'Sponsor idempotency reference is invalid.');
    }
    const cached = this.#results.get(input.idempotencyReference);
    if (cached !== undefined) {
      return {
        transactionHash: cached.transactionHash,
        signerNonce: cached.signerNonce,
        submit: async () => cached,
      };
    }
    const amount = BigInt(BaseUnitAmountSchema.parse(input.amountWei));
    if (amount < this.config.minimumGrantWei || amount > this.config.maxGrantWei) {
      throw new AppError('SPONSOR_INELIGIBLE', 'Sponsor amount is outside the activation policy.');
    }
    if (sameEvmAddress(input.recipient, this.signer.address)) {
      throw new AppError('SPONSOR_INELIGIBLE', 'Sponsor cannot transfer to itself.');
    }
    if (this.config.allowlistOnly && !this.#allowlist.has(input.recipient.toLowerCase())) {
      throw new AppError('SPONSOR_INELIGIBLE', 'This account is not sponsor-allowlisted.');
    }

    if (!/^\d+$/.test(input.signerNonce)) {
      throw new AppError('VALIDATION_FAILED', 'Sponsor signer nonce is invalid.');
    }
    const parsedNonce = BigInt(input.signerNonce);
    if (parsedNonce > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new AppError('VALIDATION_FAILED', 'Sponsor signer nonce is outside the safe range.');
    }
    const nonce = Number(parsedNonce);
    try {
      const [code, pendingNonce, balance] = await Promise.all([
        this.chain.getCode({ address: getAddress(input.recipient) }),
        this.chain.getTransactionCount({
          address: getAddress(this.signer.address),
          blockTag: 'pending',
        }),
        this.chain.getBalance({ address: getAddress(this.signer.address) }),
      ]);
      if (code !== undefined && code !== '0x') {
        throw new AppError('SPONSOR_INELIGIBLE', 'Sponsor recipient must be an undelegated EOA.');
      }
      const feeReserve = (this.config.maxFeePerGasWei ?? 0n) * 21_000n;
      if (balance <= amount + feeReserve) {
        throw new AppError('SPONSOR_BUDGET_EXHAUSTED', 'Sponsor signer balance is too low.');
      }
      if (pendingNonce > nonce) {
        throw new AppError(
          'SPONSOR_SUBMISSION_UNKNOWN',
          'The reserved sponsor nonce has already been consumed.',
          { retryable: true },
        );
      }
      if (pendingNonce < nonce) {
        throw new AppError(
          'RPC_INCONSISTENT',
          'The sponsor signer nonce regressed across RPC providers.',
          { retryable: true },
        );
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw mapRpcError(error);
    }

    const prepared = await this.signer.prepareNativeTransfer({
      recipient: input.recipient,
      amountWei: amount,
      nonce,
    });
    const expectedHash = TransactionHashSchema.parse(prepared.transactionHash);
    return {
      transactionHash: expectedHash,
      signerNonce: nonce.toString(),
      submit: async (): Promise<TransferResult> => {
        const submitted = this.#results.get(input.idempotencyReference);
        if (submitted !== undefined) return submitted;
        try {
          const returnedHash = TransactionHashSchema.parse(await prepared.broadcast());
          if (returnedHash.toLowerCase() !== expectedHash.toLowerCase()) {
            throw new AppError(
              'RPC_INCONSISTENT',
              'The sponsor RPC returned a different transaction hash.',
              { retryable: true, submissionPossible: true },
            );
          }
          const result = {
            status: 'submitted' as const,
            transactionHash: expectedHash,
            signerNonce: nonce.toString(),
          };
          this.#results.set(input.idempotencyReference, result);
          return result;
        } catch (error) {
          if (error instanceof AppError && !error.submissionPossible) throw error;
          // The exact hash is known before raw broadcast. Persist it with the
          // reserved nonce so reconciliation can prove the outcome after any
          // transport timeout without issuing another economic transfer.
          const result = {
            status: 'submitted_unknown' as const,
            transactionHash: expectedHash,
            signerNonce: nonce.toString(),
          };
          this.#results.set(input.idempotencyReference, result);
          return result;
        }
      },
    };
  }
}

/**
 * Serializes and signs only a plain Arbitrum native transfer. The destination,
 * amount, nonce, gas, fee cap, and absence of calldata are fixed before KMS.
 */
export class AwsKmsNativeTransferSigner implements SponsorSignerLike {
  readonly address: EvmAddress;

  constructor(
    private readonly chain: ManagedSponsorChainClientLike,
    private readonly kms: AwsKmsSecp256k1Signer,
    private readonly maxFeePerGasWei: bigint,
  ) {
    if (maxFeePerGasWei <= 0n) {
      throw new AppError('CONFIGURATION_INVALID', 'Sponsor fee cap must be positive.');
    }
    this.address = kms.address;
  }

  async prepareNativeTransfer(input: { recipient: EvmAddress; amountWei: bigint; nonce: number }) {
    if (input.amountWei <= 0n || !Number.isSafeInteger(input.nonce) || input.nonce < 0) {
      throw new AppError('VALIDATION_FAILED', 'Sponsor transfer inputs are invalid.');
    }
    let fees: Awaited<ReturnType<ManagedSponsorChainClientLike['estimateFeesPerGas']>>;
    try {
      fees = await this.chain.estimateFeesPerGas({ type: 'eip1559' });
    } catch (error) {
      throw mapRpcError(error);
    }
    const maxFeePerGas = fees.maxFeePerGas;
    const maxPriorityFeePerGas = fees.maxPriorityFeePerGas;
    if (
      typeof maxFeePerGas !== 'bigint' ||
      typeof maxPriorityFeePerGas !== 'bigint' ||
      maxFeePerGas <= 0n ||
      maxPriorityFeePerGas < 0n ||
      maxPriorityFeePerGas > maxFeePerGas
    ) {
      throw new AppError('RPC_INCONSISTENT', 'Arbitrum RPC returned an invalid fee quote.', {
        retryable: true,
      });
    }
    if (maxFeePerGas > this.maxFeePerGasWei) {
      throw new AppError(
        'SPONSOR_BUDGET_EXHAUSTED',
        'The current network fee exceeds the sponsor policy.',
        { retryable: true },
      );
    }
    const transaction = {
      type: 'eip1559' as const,
      chainId: Number(ARBITRUM_ONE_CHAIN_ID),
      nonce: input.nonce,
      to: getAddress(input.recipient),
      value: input.amountWei,
      gas: 21_000n,
      maxFeePerGas,
      maxPriorityFeePerGas,
    };
    const unsigned = serializeTransaction(transaction);
    const signature = parseSignature(await this.kms.signDigest(keccak256(unsigned)));
    const serializedTransaction = serializeTransaction(transaction, {
      r: signature.r,
      s: signature.s,
      yParity: signature.yParity,
    });
    const transactionHash = keccak256(serializedTransaction);
    return {
      transactionHash,
      broadcast: async () => {
        try {
          return await this.chain.sendRawTransaction({ serializedTransaction });
        } catch (error) {
          throw mapRpcError(error, { submissionPossible: true });
        }
      },
    };
  }
}

function validateSponsorRpcEndpoints(input: {
  environment: string;
  primaryRpcUrl: string;
  fallbackRpcUrl: string;
}): void {
  const local = ['local', 'test'].includes(input.environment);
  const endpoints = [input.primaryRpcUrl, input.fallbackRpcUrl].map((value) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch (error) {
      throw new AppError('CONFIGURATION_INVALID', 'Sponsor RPC URL is invalid.', { cause: error });
    }
    if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
      throw new AppError('CONFIGURATION_INVALID', 'Sponsor RPC URLs must use HTTPS.');
    }
    if (url.username || url.password) {
      throw new AppError(
        'CONFIGURATION_INVALID',
        'Sponsor RPC credentials cannot be embedded in a URL.',
      );
    }
    return url;
  });
  if (endpoints[0]?.hostname.toLowerCase() === endpoints[1]?.hostname.toLowerCase()) {
    throw new AppError('CONFIGURATION_INVALID', 'Sponsor RPC providers must be independent.');
  }
}

export function createPrivateKeySponsorTransferAdapter(input: {
  config: SponsorTransferConfig;
  privateKey: `0x${string}`;
  primaryRpcUrl: string;
  fallbackRpcUrl: string;
}): PolicyBoundSponsorTransferAdapter {
  if (!['local', 'test'].includes(input.config.environment)) {
    throw new AppError(
      'CONFIGURATION_INVALID',
      'Private-key sponsorship is restricted to local and test environments.',
    );
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.privateKey)) {
    throw new AppError('CONFIGURATION_INVALID', 'Sponsor private key is invalid.');
  }
  validateSponsorRpcEndpoints({
    environment: input.config.environment,
    primaryRpcUrl: input.primaryRpcUrl,
    fallbackRpcUrl: input.fallbackRpcUrl,
  });
  const timeout = input.config.requestTimeoutMs ?? 12_000;
  if (!Number.isInteger(timeout) || timeout < 1_000 || timeout > 30_000) {
    throw new AppError('CONFIGURATION_INVALID', 'Sponsor RPC timeout is invalid.');
  }
  const account = privateKeyToAccount(input.privateKey);
  const publicClient = createPublicClient({
    chain: arbitrumOneChain,
    transport: fallback(
      [
        http(input.primaryRpcUrl, { timeout, retryCount: 2 }),
        http(input.fallbackRpcUrl, { timeout, retryCount: 2 }),
      ],
      { rank: false, retryCount: 1 },
    ),
  });
  const managedChain = publicClient as unknown as ManagedSponsorChainClientLike;
  const signer: SponsorSignerLike = {
    address: EvmAddressSchema.parse(account.address),
    async prepareNativeTransfer(transfer) {
      const fees = await managedChain.estimateFeesPerGas({ type: 'eip1559' });
      if (typeof fees.maxFeePerGas !== 'bigint' || typeof fees.maxPriorityFeePerGas !== 'bigint') {
        throw new AppError('RPC_INCONSISTENT', 'Arbitrum RPC returned an invalid fee quote.', {
          retryable: true,
        });
      }
      const serializedTransaction = await account.signTransaction({
        type: 'eip1559',
        chainId: Number(ARBITRUM_ONE_CHAIN_ID),
        to: getAddress(transfer.recipient),
        value: transfer.amountWei,
        nonce: transfer.nonce,
        gas: 21_000n,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      });
      const transactionHash = keccak256(serializedTransaction);
      return {
        transactionHash,
        broadcast: () => managedChain.sendRawTransaction({ serializedTransaction }),
      };
    },
  };
  return new PolicyBoundSponsorTransferAdapter(
    publicClient as unknown as SponsorChainClientLike,
    signer,
    input.config,
  );
}

/** Production managed-signer sponsor factory. Resolves and verifies KMS at startup. */
export async function createAwsKmsSponsorTransferAdapter(input: {
  config: SponsorTransferConfig & { readonly maxFeePerGasWei: bigint };
  keyId: string;
  expectedSignerAddress: EvmAddress;
  region: string;
  primaryRpcUrl: string;
  fallbackRpcUrl: string;
  client?: AwsKmsClientLike;
}): Promise<PolicyBoundSponsorTransferAdapter> {
  validateSponsorRpcEndpoints({
    environment: input.config.environment,
    primaryRpcUrl: input.primaryRpcUrl,
    fallbackRpcUrl: input.fallbackRpcUrl,
  });
  const timeout = input.config.requestTimeoutMs ?? 12_000;
  if (!Number.isInteger(timeout) || timeout < 1_000 || timeout > 30_000) {
    throw new AppError('CONFIGURATION_INVALID', 'Sponsor RPC timeout is invalid.');
  }
  const kms = await AwsKmsSecp256k1Signer.create({
    client: input.client ?? createAwsKmsClient({ region: input.region }),
    keyId: input.keyId,
    expectedAddress: input.expectedSignerAddress,
  });
  const chain = createPublicClient({
    chain: arbitrumOneChain,
    transport: fallback(
      [
        http(input.primaryRpcUrl, { timeout, retryCount: 2 }),
        http(input.fallbackRpcUrl, { timeout, retryCount: 2 }),
      ],
      { rank: false, retryCount: 1 },
    ),
  }) as unknown as ManagedSponsorChainClientLike;
  return new PolicyBoundSponsorTransferAdapter(
    chain,
    new AwsKmsNativeTransferSigner(chain, kms, input.config.maxFeePerGasWei),
    input.config,
  );
}
