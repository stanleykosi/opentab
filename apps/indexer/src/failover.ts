import type { ArbitrumReadPort } from '@opentab/application';
import { AppError } from '@opentab/shared';

type AsyncMethodName =
  | 'getLatestBlock'
  | 'getBlock'
  | 'getLogs'
  | 'getNativeBalance'
  | 'getDelegationCode'
  | 'getEip7702AuthorizationEvidence'
  | 'getTransactionReceipt'
  | 'findTransaction'
  | 'findTransactionReceipt'
  | 'getPendingTransactionCount'
  | 'findOrderEvent'
  | 'readProduct';

export class FailoverArbitrumReadPort implements ArbitrumReadPort {
  #primaryFailures = 0;
  #primaryDisabledUntil = 0;

  constructor(
    private readonly primary: ArbitrumReadPort,
    private readonly fallback: ArbitrumReadPort,
    private readonly options: {
      failureThreshold: number;
      cooldownMs: number;
      timeoutMs: number;
      now?: () => number;
      onFailover?: (method: AsyncMethodName) => void;
    },
  ) {
    if (
      !Number.isSafeInteger(options.failureThreshold) ||
      options.failureThreshold < 1 ||
      !Number.isSafeInteger(options.cooldownMs) ||
      options.cooldownMs < 1_000 ||
      !Number.isSafeInteger(options.timeoutMs) ||
      options.timeoutMs < 100
    ) {
      throw new RangeError('RPC failover configuration is invalid');
    }
  }

  getLatestBlock() {
    return this.#call(
      'getLatestBlock',
      () => this.primary.getLatestBlock(),
      () => this.fallback.getLatestBlock(),
    );
  }
  getBlock(blockNumber: string) {
    return this.#call(
      'getBlock',
      () => this.primary.getBlock(blockNumber),
      () => this.fallback.getBlock(blockNumber),
    );
  }
  getLogs(input: Parameters<ArbitrumReadPort['getLogs']>[0]) {
    return this.#call(
      'getLogs',
      () => this.primary.getLogs(input),
      () => this.fallback.getLogs(input),
    );
  }
  getNativeBalance(address: Parameters<ArbitrumReadPort['getNativeBalance']>[0]) {
    return this.#call(
      'getNativeBalance',
      () => this.primary.getNativeBalance(address),
      () => this.fallback.getNativeBalance(address),
    );
  }
  getDelegationCode(address: Parameters<ArbitrumReadPort['getDelegationCode']>[0]) {
    return this.#call(
      'getDelegationCode',
      () => this.primary.getDelegationCode(address),
      () => this.fallback.getDelegationCode(address),
    );
  }
  getEip7702AuthorizationEvidence(
    input: Parameters<NonNullable<ArbitrumReadPort['getEip7702AuthorizationEvidence']>>[0],
  ) {
    if (
      this.primary.getEip7702AuthorizationEvidence === undefined ||
      this.fallback.getEip7702AuthorizationEvidence === undefined
    ) {
      throw new AppError(
        'CONFIGURATION_INVALID',
        'EIP-7702 authorization evidence reads are not available from both RPC adapters.',
      );
    }
    return this.#call(
      'getEip7702AuthorizationEvidence',
      () =>
        this.primary.getEip7702AuthorizationEvidence?.(input) as ReturnType<
          NonNullable<ArbitrumReadPort['getEip7702AuthorizationEvidence']>
        >,
      () =>
        this.fallback.getEip7702AuthorizationEvidence?.(input) as ReturnType<
          NonNullable<ArbitrumReadPort['getEip7702AuthorizationEvidence']>
        >,
    );
  }
  getTransactionReceipt(hash: Parameters<ArbitrumReadPort['getTransactionReceipt']>[0]) {
    return this.#call(
      'getTransactionReceipt',
      () => this.primary.getTransactionReceipt(hash),
      () => this.fallback.getTransactionReceipt(hash),
    );
  }
  findTransaction(hash: Parameters<NonNullable<ArbitrumReadPort['findTransaction']>>[0]) {
    if (this.primary.findTransaction === undefined || this.fallback.findTransaction === undefined) {
      throw new AppError(
        'CONFIGURATION_INVALID',
        'Sponsor transaction reads are not available from both RPC adapters.',
      );
    }
    return this.#call(
      'findTransaction',
      () =>
        this.primary.findTransaction?.(hash) as ReturnType<
          NonNullable<ArbitrumReadPort['findTransaction']>
        >,
      () =>
        this.fallback.findTransaction?.(hash) as ReturnType<
          NonNullable<ArbitrumReadPort['findTransaction']>
        >,
    );
  }
  findTransactionReceipt(
    hash: Parameters<NonNullable<ArbitrumReadPort['findTransactionReceipt']>>[0],
  ) {
    if (
      this.primary.findTransactionReceipt === undefined ||
      this.fallback.findTransactionReceipt === undefined
    ) {
      throw new AppError(
        'CONFIGURATION_INVALID',
        'Sponsor receipt reads are not available from both RPC adapters.',
      );
    }
    return this.#call(
      'findTransactionReceipt',
      () =>
        this.primary.findTransactionReceipt?.(hash) as ReturnType<
          NonNullable<ArbitrumReadPort['findTransactionReceipt']>
        >,
      () =>
        this.fallback.findTransactionReceipt?.(hash) as ReturnType<
          NonNullable<ArbitrumReadPort['findTransactionReceipt']>
        >,
    );
  }
  getPendingTransactionCount(
    address: Parameters<NonNullable<ArbitrumReadPort['getPendingTransactionCount']>>[0],
  ) {
    if (
      this.primary.getPendingTransactionCount === undefined ||
      this.fallback.getPendingTransactionCount === undefined
    ) {
      throw new AppError(
        'CONFIGURATION_INVALID',
        'Sponsor nonce reads are not available from both RPC adapters.',
      );
    }
    return this.#call(
      'getPendingTransactionCount',
      () => this.primary.getPendingTransactionCount?.(address) as Promise<string>,
      () => this.fallback.getPendingTransactionCount?.(address) as Promise<string>,
    );
  }
  findOrderEvent(orderKey: Parameters<ArbitrumReadPort['findOrderEvent']>[0]) {
    return this.#call(
      'findOrderEvent',
      () => this.primary.findOrderEvent(orderKey),
      () => this.fallback.findOrderEvent(orderKey),
    );
  }
  readProduct(productId: Parameters<ArbitrumReadPort['readProduct']>[0]) {
    return this.#call(
      'readProduct',
      () => this.primary.readProduct(productId),
      () => this.fallback.readProduct(productId),
    );
  }

  async #call<T>(
    method: AsyncMethodName,
    primaryCall: () => Promise<T>,
    fallbackCall: () => Promise<T>,
  ): Promise<T> {
    const now = this.options.now?.() ?? Date.now();
    if (now >= this.#primaryDisabledUntil) {
      try {
        const result = await this.#withTimeout(primaryCall());
        this.#primaryFailures = 0;
        return result;
      } catch {
        this.#primaryFailures += 1;
        if (this.#primaryFailures >= this.options.failureThreshold) {
          this.#primaryDisabledUntil = now + this.options.cooldownMs;
        }
      }
    }
    this.options.onFailover?.(method);
    try {
      return await this.#withTimeout(fallbackCall());
    } catch (error) {
      throw new AppError('RPC_UNAVAILABLE', 'Both RPC providers are unavailable.', {
        retryable: true,
        cause: error,
      });
    }
  }

  async #withTimeout<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('RPC request timed out')),
            this.options.timeoutMs,
          );
          timer.unref();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
