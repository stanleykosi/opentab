import type { RawContractLog } from '@opentab/application';
import { AppError, type ChainId } from '@opentab/shared';
import { digestRawLog } from './decoder.js';
import type {
  ContractLogDecoder,
  IndexedBlock,
  IndexedLog,
  IndexerChainSource,
  IndexerCursor,
  IndexerScanResult,
  IndexerStore,
} from './types.js';

export interface IndexerScannerOptions {
  readonly chainId: ChainId;
  readonly stream: string;
  readonly addresses: readonly `0x${string}`[];
  readonly contracts: {
    readonly checkout: `0x${string}`;
    readonly pass: `0x${string}`;
    readonly split?: `0x${string}`;
  };
  readonly startBlock: bigint;
  readonly confirmationDepth: number;
  readonly reorgWindowBlocks: number;
  readonly maxBlockRange: number;
  readonly leaseOwner: string;
  readonly leaseTtlMs: number;
  readonly now?: () => Date;
}

function parseBlock(value: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value))
    throw new AppError('RPC_INCONSISTENT', 'RPC returned an invalid block number.');
  return BigInt(value);
}

function toNumberBounded(value: bigint, label: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new AppError('RPC_INCONSISTENT', `${label} exceeds the supported range.`);
  }
  return Number(value);
}

const CHECKOUT_EVENTS = new Set([
  'MerchantCreated',
  'MerchantPayoutUpdated',
  'MerchantStatusChanged',
  'MerchantSuspensionChanged',
  'MerchantMetadataUpdated',
  'ProductCreated',
  'ProductUpdated',
  'ProductStatusChanged',
  'OrderPaid',
  'OrderRefunded',
  'OrderFinalized',
  'MerchantWithdrawal',
  'LoyaltyAwarded',
  'LoyaltyAdjusted',
  'FeeRecipientUpdated',
  'PlatformFeeUpdated',
  'PlatformWithdrawal',
]);
const PASS_EVENTS = new Set([
  'CheckoutBound',
  'ProductPassConfigured',
  'PassRevoked',
  'TransferSingle',
  'TransferBatch',
  'ApprovalForAll',
  'URI',
]);
const SPLIT_EVENTS = new Set(['SplitReimbursed', 'SplitPaymentRevoked']);
const SHARED_ADMIN_EVENTS = new Set([
  'Paused',
  'Unpaused',
  'RoleAdminChanged',
  'RoleGranted',
  'RoleRevoked',
  'DefaultAdminDelayChangeCanceled',
  'DefaultAdminDelayChangeScheduled',
  'DefaultAdminTransferCanceled',
  'DefaultAdminTransferScheduled',
  'EIP712DomainChanged',
]);
const BLOCK_HEADER_CONCURRENCY = 16;

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

export class IndexerScanner {
  readonly #now: () => Date;

  constructor(
    private readonly source: IndexerChainSource,
    private readonly store: IndexerStore,
    private readonly decoder: ContractLogDecoder,
    private readonly options: IndexerScannerOptions,
  ) {
    if (
      !Number.isSafeInteger(options.confirmationDepth) ||
      options.confirmationDepth < 1 ||
      !Number.isSafeInteger(options.reorgWindowBlocks) ||
      options.reorgWindowBlocks < 2 ||
      !Number.isSafeInteger(options.maxBlockRange) ||
      options.maxBlockRange < 1 ||
      options.maxBlockRange > 10_000
    ) {
      throw new RangeError('Indexer scanner ranges are invalid');
    }
    const normalizedAddresses = new Set(options.addresses.map((address) => address.toLowerCase()));
    const roleAddresses = [
      options.contracts.checkout,
      options.contracts.pass,
      options.contracts.split,
    ]
      .filter((address): address is `0x${string}` => address !== undefined)
      .map((address) => address.toLowerCase());
    if (
      options.addresses.length < 2 ||
      normalizedAddresses.size !== options.addresses.length ||
      roleAddresses.some((address) => !normalizedAddresses.has(address)) ||
      new Set(roleAddresses).size !== roleAddresses.length
    ) {
      throw new Error('Indexer contract roles and address allowlist are invalid');
    }
    this.#now = options.now ?? (() => new Date());
  }

  async scanOnce(): Promise<IndexerScanResult> {
    const initialCursor = await this.store.loadOrCreateCursor({
      chainId: this.options.chainId,
      stream: this.options.stream,
      startBlock: this.options.startBlock,
      confirmationDepth: this.options.confirmationDepth,
    });
    const acquired = await this.store.tryAcquireLease({
      chainId: this.options.chainId,
      stream: this.options.stream,
      owner: this.options.leaseOwner,
      ttlMs: this.options.leaseTtlMs,
      now: this.#now(),
    });
    if (!acquired) {
      return { kind: 'lease_standby', nextBlock: initialCursor.nextBlock };
    }

    try {
      return await this.#scanWithLease(initialCursor);
    } finally {
      await this.store.releaseLease({
        chainId: this.options.chainId,
        stream: this.options.stream,
        owner: this.options.leaseOwner,
        now: this.#now(),
      });
    }
  }

  async #scanWithLease(initialCursor: IndexerCursor): Promise<IndexerScanResult> {
    let cursor = initialCursor;
    const latest = await this.source.getLatestBlock();
    const latestBlock = parseBlock(latest.number);
    const safeHead =
      latestBlock >= BigInt(this.options.confirmationDepth)
        ? latestBlock - BigInt(this.options.confirmationDepth) + 1n
        : -1n;

    const reorg = await this.#detectReorg(cursor);
    if (reorg) {
      cursor = await this.store.loadOrCreateCursor({
        chainId: this.options.chainId,
        stream: this.options.stream,
        startBlock: this.options.startBlock,
        confirmationDepth: this.options.confirmationDepth,
      });
      return {
        kind: 'reorg_rewound',
        latestBlock,
        safeHead,
        nextBlock: cursor.nextBlock,
        processedBlocks: 0,
        processedLogs: 0,
        lagBlocks: safeHead >= cursor.nextBlock ? safeHead - cursor.nextBlock + 1n : 0n,
      };
    }

    await this.#reprocessDecoderQuarantines(latestBlock, safeHead);

    if (safeHead < cursor.nextBlock) {
      return {
        kind: 'idle',
        latestBlock,
        safeHead,
        nextBlock: cursor.nextBlock,
        processedBlocks: 0,
        processedLogs: 0,
        lagBlocks: 0n,
      };
    }

    const requestedEnd = cursor.nextBlock + BigInt(this.options.maxBlockRange) - 1n;
    const toBlock = requestedEnd > safeHead ? safeHead : requestedEnd;
    const rawLogs = await this.#getLogsAdaptive(cursor.nextBlock, toBlock);
    const blocks = await this.#loadProofBlocks(cursor.nextBlock, toBlock, cursor, rawLogs);
    const blocksByNumber = new Map(blocks.map((block) => [block.number, block]));
    const observedAt = this.#now();
    const logs: IndexedLog[] = rawLogs
      .slice()
      .sort((left, right) => {
        const blockDelta = parseBlock(left.blockNumber) - parseBlock(right.blockNumber);
        if (blockDelta !== 0n) return blockDelta < 0n ? -1 : 1;
        const logDelta = parseBlock(left.logIndex) - parseBlock(right.logIndex);
        return logDelta < 0n ? -1 : logDelta > 0n ? 1 : 0;
      })
      .map((raw) => {
        const blockNumber = parseBlock(raw.blockNumber);
        const canonicalBlock = blocksByNumber.get(blockNumber);
        if (
          raw.chainId !== this.options.chainId ||
          blockNumber < cursor.nextBlock ||
          blockNumber > toBlock ||
          canonicalBlock === undefined ||
          canonicalBlock.hash.toLowerCase() !== raw.blockHash.toLowerCase() ||
          !this.options.addresses.some((address) => sameAddress(address, raw.contractAddress))
        ) {
          throw new AppError(
            'RPC_INCONSISTENT',
            'RPC returned a log outside the canonical contract range.',
            { retryable: true },
          );
        }
        const decoded = this.decoder.decode(raw);
        this.#assertEventContractRole(raw, decoded);
        return {
          raw,
          decoded,
          payloadDigest: digestRawLog(raw),
          confirmations: latestBlock - blockNumber + 1n,
          observedAt,
        };
      });

    await this.store.commitRange({
      cursor,
      blocks,
      logs,
      nextBlock: toBlock + 1n,
      now: observedAt,
    });
    return {
      kind: 'processed',
      latestBlock,
      safeHead,
      nextBlock: toBlock + 1n,
      processedBlocks: toNumberBounded(toBlock - cursor.nextBlock + 1n, 'Processed block count'),
      processedLogs: logs.length,
      lagBlocks: safeHead > toBlock ? safeHead - toBlock : 0n,
    };
  }

  async #reprocessDecoderQuarantines(latestBlock: bigint, safeHead: bigint): Promise<void> {
    const references = await this.store.loadQuarantinedLogs({
      chainId: this.options.chainId,
      stream: this.options.stream,
      decoderVersion: this.decoder.version,
      limit: 25,
    });
    for (const reference of references) {
      if (reference.blockNumber > safeHead) continue;
      const canonicalBlock = await this.source.getBlock(reference.blockNumber.toString());
      if (canonicalBlock.hash.toLowerCase() !== reference.blockHash.toLowerCase()) {
        throw new AppError(
          'RPC_INCONSISTENT',
          'A quarantined event no longer belongs to its recorded canonical block.',
          { retryable: true },
        );
      }
      const candidates = await this.source.getLogs({
        fromBlock: reference.blockNumber.toString(),
        toBlock: reference.blockNumber.toString(),
        addresses: [reference.contractAddress],
      });
      const raw = candidates.find(
        (candidate) =>
          candidate.transactionHash.toLowerCase() === reference.transactionHash.toLowerCase() &&
          candidate.blockHash.toLowerCase() === reference.blockHash.toLowerCase() &&
          Number(candidate.logIndex) === reference.logIndex,
      );
      if (
        raw === undefined ||
        digestRawLog(raw).toLowerCase() !== reference.payloadDigest.toLowerCase()
      ) {
        throw new AppError(
          'RPC_INCONSISTENT',
          'A quarantined event could not be reproduced from the configured RPC.',
          { retryable: true },
        );
      }
      const decoded = this.decoder.decode(raw);
      this.#assertEventContractRole(raw, decoded);
      await this.store.reprocessQuarantinedLog({
        canonicalLogId: reference.canonicalLogId,
        log: {
          raw,
          decoded,
          payloadDigest: reference.payloadDigest,
          confirmations: latestBlock - reference.blockNumber + 1n,
          observedAt: reference.observedAt,
        },
        now: this.#now(),
      });
    }
  }

  #assertEventContractRole(raw: RawContractLog, decoded: IndexedLog['decoded']): void {
    if (decoded.kind !== 'decoded') return;
    const eventName = decoded.event.eventName;
    const allowed =
      (CHECKOUT_EVENTS.has(eventName) &&
        sameAddress(raw.contractAddress, this.options.contracts.checkout)) ||
      (PASS_EVENTS.has(eventName) &&
        sameAddress(raw.contractAddress, this.options.contracts.pass)) ||
      (SPLIT_EVENTS.has(eventName) &&
        this.options.contracts.split !== undefined &&
        sameAddress(raw.contractAddress, this.options.contracts.split)) ||
      (SHARED_ADMIN_EVENTS.has(eventName) &&
        this.options.addresses.some((address) => sameAddress(address, raw.contractAddress)));
    if (!allowed) {
      throw new AppError(
        'RPC_INCONSISTENT',
        'RPC returned an event from the wrong OpenTab contract role.',
        { retryable: true },
      );
    }
  }

  async #detectReorg(cursor: IndexerCursor): Promise<boolean> {
    if (cursor.lastProcessedBlock === undefined || cursor.lastProcessedBlockHash === undefined) {
      return false;
    }
    const live = await this.source.getBlock(cursor.lastProcessedBlock.toString());
    if (live.hash.toLowerCase() === cursor.lastProcessedBlockHash.toLowerCase()) return false;

    const floor =
      cursor.lastProcessedBlock > BigInt(this.options.reorgWindowBlocks)
        ? cursor.lastProcessedBlock - BigInt(this.options.reorgWindowBlocks)
        : 0n;
    let commonAncestor: bigint | undefined;
    let candidate = cursor.lastProcessedBlock;
    while (candidate >= floor) {
      const [stored, current] = await Promise.all([
        this.store.getCanonicalBlock({
          chainId: cursor.chainId,
          stream: cursor.stream,
          blockNumber: candidate,
        }),
        this.source.getBlock(candidate.toString()),
      ]);
      if (stored !== undefined && stored.hash.toLowerCase() === current.hash.toLowerCase()) {
        commonAncestor = candidate;
        break;
      }
      if (candidate === 0n) break;
      candidate -= 1n;
    }
    if (commonAncestor === undefined) {
      throw new AppError(
        'RPC_INCONSISTENT',
        'A chain reorganization exceeded the configured rewind window.',
      );
    }
    const ancestor = await this.source.getBlock(commonAncestor.toString());
    await this.store.rewind({
      cursor,
      details: {
        detectedAtBlock: cursor.lastProcessedBlock,
        commonAncestorBlock: commonAncestor,
        oldHeadHash: cursor.lastProcessedBlockHash,
        newHeadHash: live.hash,
      },
      now: this.#now(),
    });
    if (
      ancestor.hash.toLowerCase() !==
      (await this.source.getBlock(commonAncestor.toString())).hash.toLowerCase()
    ) {
      throw new AppError(
        'RPC_INCONSISTENT',
        'The chain changed while calculating the reorganization ancestor.',
      );
    }
    return true;
  }

  async #loadProofBlocks(
    fromBlock: bigint,
    toBlock: bigint,
    cursor: IndexerCursor,
    rawLogs: readonly RawContractLog[],
  ): Promise<readonly IndexedBlock[]> {
    // Empty blocks have no OpenTab state to project. Persist the exact reorg
    // floor, range start, range tip, and every log-bearing block. The dynamic
    // floor guarantees a stored common ancestor for every supported shallow
    // reorg without requesting every empty Arbitrum block during catch-up.
    const reorgWindow = BigInt(this.options.reorgWindowBlocks);
    const reorgFloor = toBlock > reorgWindow ? toBlock - reorgWindow : 0n;
    const retainedFloor =
      reorgFloor > this.options.startBlock ? reorgFloor : this.options.startBlock;
    const requestedNumbers = new Set<bigint>([retainedFloor, fromBlock, toBlock]);
    for (const raw of rawLogs) {
      const blockNumber = parseBlock(raw.blockNumber);
      if (blockNumber >= fromBlock && blockNumber <= toBlock) {
        requestedNumbers.add(blockNumber);
      }
    }
    const blockNumbers = [...requestedNumbers].sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    const blocks: IndexedBlock[] = [];
    let previousLoadedNumber: bigint | undefined;
    let previousLoadedHash: `0x${string}` | undefined;
    for (let offset = 0; offset < blockNumbers.length; offset += BLOCK_HEADER_CONCURRENCY) {
      const requested = blockNumbers.slice(offset, offset + BLOCK_HEADER_CONCURRENCY);
      const headers = await Promise.all(
        requested.map(async (blockNumber) => ({
          blockNumber,
          block: await this.source.getBlock(blockNumber.toString()),
        })),
      );
      for (const { blockNumber, block } of headers) {
        if (parseBlock(block.number) !== blockNumber) {
          throw new AppError('RPC_INCONSISTENT', 'RPC returned the wrong block header.');
        }
        if (
          (blockNumber === fromBlock &&
            cursor.lastProcessedBlock === fromBlock - 1n &&
            cursor.lastProcessedBlockHash !== undefined &&
            block.parentHash.toLowerCase() !== cursor.lastProcessedBlockHash.toLowerCase()) ||
          (previousLoadedNumber !== undefined &&
            previousLoadedHash !== undefined &&
            blockNumber === previousLoadedNumber + 1n &&
            block.parentHash.toLowerCase() !== previousLoadedHash.toLowerCase())
        ) {
          throw new AppError('RPC_INCONSISTENT', 'RPC block headers are not continuous.', {
            retryable: true,
          });
        }
        blocks.push({
          number: blockNumber,
          hash: block.hash,
          parentHash: block.parentHash,
          observedAt: this.#now(),
        });
        previousLoadedNumber = blockNumber;
        previousLoadedHash = block.hash;
      }
    }
    return blocks;
  }

  async #getLogsAdaptive(fromBlock: bigint, toBlock: bigint): Promise<readonly RawContractLog[]> {
    try {
      return await this.source.getLogs({
        fromBlock: fromBlock.toString(),
        toBlock: toBlock.toString(),
        addresses: this.options.addresses as never,
      });
    } catch (error) {
      if (fromBlock >= toBlock) {
        throw new AppError('RPC_UNAVAILABLE', 'The RPC provider could not return contract logs.', {
          retryable: true,
          cause: error,
        });
      }
      const midpoint = fromBlock + (toBlock - fromBlock) / 2n;
      const left: readonly RawContractLog[] = await this.#getLogsAdaptive(fromBlock, midpoint);
      const right: readonly RawContractLog[] = await this.#getLogsAdaptive(midpoint + 1n, toBlock);
      return [...left, ...right];
    }
  }
}
