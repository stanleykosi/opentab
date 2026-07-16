import {
  AppError,
  ARBITRUM_ONE_CHAIN_ID,
  type EvmAddress,
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
import { arbitrumOneChain } from './arbitrum-chain.js';
import { type AwsKmsClientLike, AwsKmsSecp256k1Signer, createAwsKmsClient } from './aws-kms.js';
import {
  type ManagedContractOperation,
  type SplitRevocationOperationBinding,
  validateSplitRevocationOperation,
} from './operation-templates.js';
import { mapRpcError } from './vendor-errors.js';

interface ManagedContractChainClientLike {
  getTransactionCount(input: { address: `0x${string}`; blockTag: 'pending' }): Promise<number>;
  estimateFeesPerGas(input: { type: 'eip1559' }): Promise<{
    maxFeePerGas?: bigint;
    maxPriorityFeePerGas?: bigint;
  }>;
  estimateGas(input: {
    account: `0x${string}`;
    to: `0x${string}`;
    data: Hex;
    value: bigint;
  }): Promise<bigint>;
  sendRawTransaction(input: { serializedTransaction: Hex }): Promise<Hex>;
}

export type ManagedContractSubmission =
  | {
      readonly status: 'submitted';
      readonly transactionHash: ReturnType<typeof TransactionHashSchema.parse>;
      readonly signerNonce: string;
    }
  | { readonly status: 'submitted_unknown'; readonly signerNonce: string };

export interface AwsKmsSplitRevocationSenderConfig {
  readonly splitContractAddress: EvmAddress;
  readonly maxFeePerGasWei: bigint;
  readonly maxGasLimit: bigint;
  readonly now?: () => Date;
}

/**
 * KMS sender that can execute only a server-bound SplitPaymentRevoked call.
 * The caller must hold the distributed signer-nonce lock and persist the
 * returned nonce/status before releasing that lock.
 */
export class AwsKmsSplitRevocationSender {
  constructor(
    private readonly chain: ManagedContractChainClientLike,
    private readonly kms: AwsKmsSecp256k1Signer,
    private readonly config: AwsKmsSplitRevocationSenderConfig,
  ) {
    if (config.maxFeePerGasWei <= 0n || config.maxGasLimit < 21_000n) {
      throw new AppError('CONFIGURATION_INVALID', 'Managed transaction limits are invalid.');
    }
  }

  async submit(input: {
    binding: SplitRevocationOperationBinding;
    operation: ManagedContractOperation;
  }): Promise<ManagedContractSubmission> {
    const operation = validateSplitRevocationOperation(input);
    if (
      !sameEvmAddress(input.binding.splitContractAddress, this.config.splitContractAddress) ||
      !sameEvmAddress(operation.call.to, this.config.splitContractAddress) ||
      !sameEvmAddress(operation.signerAddress, this.kms.address) ||
      operation.chainId !== ARBITRUM_ONE_CHAIN_ID ||
      operation.call.valueWei !== '0'
    ) {
      throw new AppError(
        'OPERATION_PLAN_INVALID',
        'Split revocation does not match the managed signer policy.',
      );
    }
    const now = this.config.now?.() ?? new Date();
    if (new Date(operation.expiresAt).getTime() <= now.getTime()) {
      throw new AppError('OPERATION_PLAN_INVALID', 'Split revocation operation has expired.');
    }

    let nonce: number;
    let maxFeePerGas: bigint;
    let maxPriorityFeePerGas: bigint;
    let gas: bigint;
    try {
      const [pendingNonce, fees, estimatedGas] = await Promise.all([
        this.chain.getTransactionCount({
          address: getAddress(this.kms.address),
          blockTag: 'pending',
        }),
        this.chain.estimateFeesPerGas({ type: 'eip1559' }),
        this.chain.estimateGas({
          account: getAddress(this.kms.address),
          to: getAddress(operation.call.to),
          data: operation.call.data as Hex,
          value: 0n,
        }),
      ]);
      if (!Number.isSafeInteger(pendingNonce) || pendingNonce < 0) {
        throw new AppError('RPC_INCONSISTENT', 'Arbitrum RPC returned an invalid nonce.');
      }
      if (
        typeof fees.maxFeePerGas !== 'bigint' ||
        typeof fees.maxPriorityFeePerGas !== 'bigint' ||
        fees.maxFeePerGas <= 0n ||
        fees.maxPriorityFeePerGas < 0n ||
        fees.maxPriorityFeePerGas > fees.maxFeePerGas
      ) {
        throw new AppError('RPC_INCONSISTENT', 'Arbitrum RPC returned an invalid fee quote.');
      }
      const paddedGas = (estimatedGas * 120n + 99n) / 100n;
      if (estimatedGas < 21_000n || paddedGas > this.config.maxGasLimit) {
        throw new AppError('OPERATION_PLAN_INVALID', 'Split revocation gas exceeds policy.');
      }
      if (fees.maxFeePerGas > this.config.maxFeePerGasWei) {
        throw new AppError('OPERATION_PLAN_INVALID', 'Split revocation fee exceeds policy.');
      }
      nonce = pendingNonce;
      maxFeePerGas = fees.maxFeePerGas;
      maxPriorityFeePerGas = fees.maxPriorityFeePerGas;
      gas = paddedGas;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw mapRpcError(error);
    }

    const transaction = {
      type: 'eip1559' as const,
      chainId: Number(ARBITRUM_ONE_CHAIN_ID),
      nonce,
      to: getAddress(operation.call.to),
      data: operation.call.data as Hex,
      value: 0n,
      gas,
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
    try {
      const parsed = TransactionHashSchema.safeParse(
        await this.chain.sendRawTransaction({ serializedTransaction }),
      );
      if (!parsed.success) return { status: 'submitted_unknown', signerNonce: nonce.toString() };
      return {
        status: 'submitted',
        transactionHash: parsed.data,
        signerNonce: nonce.toString(),
      };
    } catch {
      // A raw-send transport error cannot establish that broadcast did not
      // happen. Reconciliation owns the outcome; never auto-submit again.
      return { status: 'submitted_unknown', signerNonce: nonce.toString() };
    }
  }
}

function validateRpcEndpoints(input: {
  environment: string;
  primaryRpcUrl: string;
  fallbackRpcUrl: string;
}): void {
  const local = ['local', 'test'].includes(input.environment);
  const urls = [input.primaryRpcUrl, input.fallbackRpcUrl].map((value) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch (error) {
      throw new AppError('CONFIGURATION_INVALID', 'Managed signer RPC URL is invalid.', {
        cause: error,
      });
    }
    if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
      throw new AppError('CONFIGURATION_INVALID', 'Managed signer RPC URLs must use HTTPS.');
    }
    if (url.username || url.password) {
      throw new AppError(
        'CONFIGURATION_INVALID',
        'Managed signer RPC credentials cannot be embedded in a URL.',
      );
    }
    return url;
  });
  if (urls[0]?.hostname.toLowerCase() === urls[1]?.hostname.toLowerCase()) {
    throw new AppError(
      'CONFIGURATION_INVALID',
      'Managed signer RPC providers must be independent.',
    );
  }
}

export async function createAwsKmsSplitRevocationSender(input: {
  environment: string;
  region: string;
  keyId: string;
  expectedSignerAddress: EvmAddress;
  splitContractAddress: EvmAddress;
  primaryRpcUrl: string;
  fallbackRpcUrl: string;
  maxFeePerGasWei: bigint;
  maxGasLimit: bigint;
  requestTimeoutMs?: number;
  client?: AwsKmsClientLike;
  now?: () => Date;
}): Promise<AwsKmsSplitRevocationSender> {
  validateRpcEndpoints(input);
  const timeout = input.requestTimeoutMs ?? 12_000;
  if (!Number.isInteger(timeout) || timeout < 1_000 || timeout > 30_000) {
    throw new AppError('CONFIGURATION_INVALID', 'Managed signer RPC timeout is invalid.');
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
  }) as unknown as ManagedContractChainClientLike;
  return new AwsKmsSplitRevocationSender(chain, kms, {
    splitContractAddress: input.splitContractAddress,
    maxFeePerGasWei: input.maxFeePerGasWei,
    maxGasLimit: input.maxGasLimit,
    ...(input.now === undefined ? {} : { now: input.now }),
  });
}
