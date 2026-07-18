import type { ArbitrumReadPort, RawContractLog } from '@opentab/application';
import { ARBITRUM_ONE_CHAIN_ID, EvmAddressSchema, TransactionHashSchema } from '@opentab/shared';
import { describe, expect, it } from 'vitest';
import { IndexerScanner, type IndexerScannerOptions } from '../src/scanner.js';
import type {
  ContractLogDecoder,
  IndexedBlock,
  IndexedLog,
  IndexerCursor,
  IndexerStore,
  ReorgDetails,
} from '../src/types.js';

const chainId = ARBITRUM_ONE_CHAIN_ID;
const contract = EvmAddressSchema.parse(`0x${'1'.repeat(40)}`);
const passContract = EvmAddressSchema.parse(`0x${'2'.repeat(40)}`);
const now = new Date('2026-07-14T03:00:00.000Z');

function hash(value: number, fork = 0): `0x${string}` {
  return `0x${(value + fork * 10_000).toString(16).padStart(64, '0')}`;
}

function block(number: number, fork = 0) {
  return {
    number: number.toString(),
    hash: hash(number, fork),
    parentHash: number === 0 ? hash(0) : hash(number - 1, fork),
    timestamp: (1_700_000_000 + number).toString(),
  };
}

function rawLog(
  blockNumber: number,
  logIndex: number,
  tx = logIndex,
  contractAddress = contract,
): RawContractLog {
  return {
    chainId,
    contractAddress,
    transactionHash: TransactionHashSchema.parse(hash(1_000 + tx)),
    blockNumber: blockNumber.toString(),
    blockHash: hash(blockNumber),
    logIndex: logIndex.toString(),
    topics: [hash(7)],
    data: '0x',
  };
}

const decoder: ContractLogDecoder = {
  version: 'test-v1',
  decode: () => ({
    kind: 'decoded',
    event: { eventName: 'OrderPaid', fields: {}, decoderVersion: 'test-v1' },
  }),
};

class MemoryStore implements IndexerStore {
  cursor: IndexerCursor;
  leaseAvailable = true;
  releases = 0;
  rewinds: ReorgDetails[] = [];
  commits: {
    blocks: readonly IndexedBlock[];
    logs: readonly IndexedLog[];
    nextBlock: bigint;
  }[] = [];
  readonly canonicalBlocks = new Map<bigint, IndexedBlock>();
  readonly uniqueLogIdentities = new Set<string>();

  constructor(startBlock = 1n) {
    this.cursor = {
      chainId,
      stream: 'checkout',
      nextBlock: startBlock,
      confirmationDepth: 1,
    };
  }

  async loadOrCreateCursor(): Promise<IndexerCursor> {
    return this.cursor;
  }

  async tryAcquireLease(): Promise<boolean> {
    return this.leaseAvailable;
  }

  async releaseLease(): Promise<void> {
    this.releases += 1;
  }

  async getCanonicalBlock(input: { blockNumber: bigint }): Promise<IndexedBlock | undefined> {
    return this.canonicalBlocks.get(input.blockNumber);
  }

  async commitRange(input: {
    blocks: readonly IndexedBlock[];
    logs: readonly IndexedLog[];
    nextBlock: bigint;
  }): Promise<void> {
    this.commits.push({ blocks: input.blocks, logs: input.logs, nextBlock: input.nextBlock });
    for (const item of input.blocks) this.canonicalBlocks.set(item.number, item);
    for (const item of input.logs) {
      this.uniqueLogIdentities.add(
        `${item.raw.chainId}:${item.raw.transactionHash}:${item.raw.logIndex}:${item.raw.blockHash}`,
      );
    }
    const last = input.blocks.at(-1);
    this.cursor = {
      ...this.cursor,
      nextBlock: input.nextBlock,
      ...(last === undefined
        ? {}
        : { lastProcessedBlock: last.number, lastProcessedBlockHash: last.hash }),
    };
  }

  async rewind(input: { details: ReorgDetails }): Promise<void> {
    this.rewinds.push(input.details);
    const ancestor = this.canonicalBlocks.get(input.details.commonAncestorBlock);
    this.cursor = {
      ...this.cursor,
      nextBlock: input.details.commonAncestorBlock + 1n,
      lastProcessedBlock: input.details.commonAncestorBlock,
      ...(ancestor === undefined ? {} : { lastProcessedBlockHash: ancestor.hash }),
    };
  }

  async replayQuarantined(): Promise<number> {
    return 0;
  }
}

class MemorySource implements ArbitrumReadPort {
  latest = 4;
  readonly blocks = new Map<number, ReturnType<typeof block>>();
  logs: readonly RawContractLog[] = [];
  readonly logRanges: string[] = [];
  failWideRanges = false;

  constructor() {
    for (let value = 0; value <= 12; value += 1) this.blocks.set(value, block(value));
  }

  async getLatestBlock() {
    const result = this.blocks.get(this.latest);
    if (result === undefined) throw new Error('Latest block missing');
    return result;
  }

  async getBlock(blockNumber: string) {
    const result = this.blocks.get(Number(blockNumber));
    if (result === undefined) throw new Error(`Block ${blockNumber} missing`);
    return result;
  }

  async getLogs(input: Parameters<ArbitrumReadPort['getLogs']>[0]) {
    this.logRanges.push(`${input.fromBlock}-${input.toBlock}`);
    if (this.failWideRanges && BigInt(input.toBlock) > BigInt(input.fromBlock)) {
      throw new Error('provider range limit');
    }
    return this.logs.filter(
      (item) =>
        BigInt(item.blockNumber) >= BigInt(input.fromBlock) &&
        BigInt(item.blockNumber) <= BigInt(input.toBlock),
    );
  }

  async getNativeBalance() {
    return '0';
  }

  async getDelegationCode() {
    return { accountType: 'eoa' as const, codeHash: hash(0) };
  }

  async getTransactionReceipt(): Promise<never> {
    throw new Error('not used');
  }

  async findOrderEvent() {
    return undefined;
  }

  async readProduct() {
    return undefined;
  }
}

function options(overrides: Partial<IndexerScannerOptions> = {}): IndexerScannerOptions {
  return {
    chainId,
    stream: 'checkout',
    addresses: [contract as `0x${string}`, passContract as `0x${string}`],
    contracts: {
      checkout: contract as `0x${string}`,
      pass: passContract as `0x${string}`,
    },
    startBlock: 1n,
    confirmationDepth: 1,
    reorgWindowBlocks: 4,
    maxBlockRange: 10,
    leaseOwner: 'worker-a',
    leaseTtlMs: 30_000,
    now: () => new Date(now),
    ...overrides,
  };
}

describe('IndexerScanner deterministic range processing', () => {
  it('loads sparse canonical checkpoints concurrently instead of every empty block', async () => {
    const source = new MemorySource();
    source.latest = 12;
    let active = 0;
    let maximumActive = 0;
    const requestedBlocks: string[] = [];
    const originalGetBlock = source.getBlock.bind(source);
    source.getBlock = async (blockNumber: string) => {
      requestedBlocks.push(blockNumber);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      try {
        return await originalGetBlock(blockNumber);
      } finally {
        active -= 1;
      }
    };
    const store = new MemoryStore();

    await expect(
      new IndexerScanner(source, store, decoder, options({ maxBlockRange: 12 })).scanOnce(),
    ).resolves.toMatchObject({ kind: 'processed', processedBlocks: 12 });
    expect(maximumActive).toBeGreaterThan(1);
    expect(requestedBlocks).toEqual(['1', '8', '12']);
    expect(store.cursor.nextBlock).toBe(13n);
  });

  it('always loads and verifies the canonical header for every returned log', async () => {
    const source = new MemorySource();
    source.latest = 12;
    source.logs = [rawLog(7, 0)];
    const requestedBlocks: string[] = [];
    const originalGetBlock = source.getBlock.bind(source);
    source.getBlock = async (blockNumber: string) => {
      requestedBlocks.push(blockNumber);
      return originalGetBlock(blockNumber);
    };
    const store = new MemoryStore();

    await new IndexerScanner(source, store, decoder, options({ maxBlockRange: 12 })).scanOnce();

    expect(requestedBlocks).toEqual(['1', '7', '8', '12']);
    expect(store.commits[0]?.logs).toHaveLength(1);
  });

  it('retains an exact reorg-floor checkpoint after a sparse bootstrap', async () => {
    const source = new MemorySource();
    source.latest = 12;
    const store = new MemoryStore();
    const scanner = new IndexerScanner(source, store, decoder, options({ maxBlockRange: 12 }));
    await scanner.scanOnce();
    source.blocks.set(11, { ...block(11, 1), parentHash: hash(10) });
    source.blocks.set(12, block(12, 1));

    const result = await scanner.scanOnce();

    expect(result.kind).toBe('reorg_rewound');
    expect(store.rewinds[0]?.commonAncestorBlock).toBe(8n);
    expect(store.cursor.nextBlock).toBe(9n);
  });

  it('sorts out-of-order logs and keeps duplicate delivery idempotent at the store identity', async () => {
    const source = new MemorySource();
    source.latest = 2;
    source.logs = [rawLog(2, 1, 4), rawLog(1, 3, 3), rawLog(1, 1, 1), rawLog(1, 1, 1)];
    const store = new MemoryStore();
    const result = await new IndexerScanner(source, store, decoder, options()).scanOnce();

    expect(result).toMatchObject({ kind: 'processed', processedBlocks: 2, processedLogs: 4 });
    expect(
      store.commits[0]?.logs.map((item) => `${item.raw.blockNumber}:${item.raw.logIndex}`),
    ).toEqual(['1:1', '1:1', '1:3', '2:1']);
    expect(store.uniqueLogIdentities.size).toBe(3);
    expect(store.cursor.nextBlock).toBe(3n);
    expect(store.releases).toBe(1);
  });

  it('detects a header gap and never advances the cursor', async () => {
    const source = new MemorySource();
    source.latest = 2;
    source.blocks.set(2, { ...block(2), parentHash: hash(99) });
    const store = new MemoryStore();

    await expect(
      new IndexerScanner(source, store, decoder, options()).scanOnce(),
    ).rejects.toMatchObject({
      code: 'RPC_INCONSISTENT',
      retryable: true,
    });
    expect(store.commits).toHaveLength(0);
    expect(store.cursor.nextBlock).toBe(1n);
    expect(store.releases).toBe(1);
  });

  it('rejects an orphan log paired with a newer canonical block header', async () => {
    const source = new MemorySource();
    source.latest = 2;
    source.logs = [{ ...rawLog(2, 0), blockHash: hash(2, 1) }];
    const store = new MemoryStore();

    await expect(
      new IndexerScanner(source, store, decoder, options()).scanOnce(),
    ).rejects.toMatchObject({ code: 'RPC_INCONSISTENT', retryable: true });
    expect(store.commits).toHaveLength(0);
    expect(store.cursor.nextBlock).toBe(1n);
  });

  it('rejects logs from an unconfigured address and events emitted by the wrong contract role', async () => {
    for (const item of [
      rawLog(1, 0, 0, EvmAddressSchema.parse(`0x${'9'.repeat(40)}`)),
      rawLog(1, 0, 0, passContract),
    ]) {
      const source = new MemorySource();
      source.latest = 1;
      source.logs = [item];
      const store = new MemoryStore();
      await expect(
        new IndexerScanner(source, store, decoder, options()).scanOnce(),
      ).rejects.toMatchObject({ code: 'RPC_INCONSISTENT', retryable: true });
      expect(store.commits).toHaveLength(0);
    }
  });

  it('adaptively bisects provider-limited log ranges down to successful single blocks', async () => {
    const source = new MemorySource();
    source.latest = 4;
    source.failWideRanges = true;
    source.logs = [rawLog(3, 0)];
    const store = new MemoryStore();
    const result = await new IndexerScanner(source, store, decoder, options()).scanOnce();

    expect(result).toMatchObject({ kind: 'processed', processedBlocks: 4, processedLogs: 1 });
    expect(source.logRanges).toEqual(['1-4', '1-2', '1-1', '2-2', '3-4', '3-3', '4-4']);
    expect(store.cursor.nextBlock).toBe(5n);
  });

  it('resumes from the committed cursor after a process restart', async () => {
    const source = new MemorySource();
    source.latest = 4;
    const store = new MemoryStore();
    await new IndexerScanner(source, store, decoder, options({ maxBlockRange: 2 })).scanOnce();
    await new IndexerScanner(source, store, decoder, options({ maxBlockRange: 2 })).scanOnce();

    expect(store.commits.map((item) => item.blocks.map((entry) => entry.number))).toEqual([
      [1n, 2n],
      [1n, 3n, 4n],
    ]);
    expect(store.cursor.nextBlock).toBe(5n);
  });

  it('rewinds to the common ancestor on a shallow reorg before reading new logs', async () => {
    const source = new MemorySource();
    const store = new MemoryStore();
    for (let value = 1; value <= 3; value += 1) {
      store.canonicalBlocks.set(BigInt(value), {
        number: BigInt(value),
        hash: hash(value),
        parentHash: hash(value - 1),
        observedAt: now,
      });
    }
    store.cursor = {
      ...store.cursor,
      nextBlock: 4n,
      lastProcessedBlock: 3n,
      lastProcessedBlockHash: hash(3),
    };
    source.latest = 5;
    source.blocks.set(3, { ...block(3, 1), parentHash: hash(2) });

    const result = await new IndexerScanner(source, store, decoder, options()).scanOnce();

    expect(result.kind).toBe('reorg_rewound');
    expect(store.rewinds).toHaveLength(1);
    expect(store.rewinds[0]?.commonAncestorBlock).toBe(2n);
    expect(store.cursor.nextBlock).toBe(3n);
    expect(source.logRanges).toHaveLength(0);
  });

  it('halts without rewinding when a reorg exceeds the configured retention window', async () => {
    const source = new MemorySource();
    const store = new MemoryStore();
    for (let value = 2; value <= 6; value += 1) {
      store.canonicalBlocks.set(BigInt(value), {
        number: BigInt(value),
        hash: hash(value),
        parentHash: hash(value - 1),
        observedAt: now,
      });
      source.blocks.set(value, block(value, 1));
    }
    store.cursor = {
      ...store.cursor,
      nextBlock: 7n,
      lastProcessedBlock: 6n,
      lastProcessedBlockHash: hash(6),
    };
    source.latest = 8;

    await expect(
      new IndexerScanner(source, store, decoder, options({ reorgWindowBlocks: 4 })).scanOnce(),
    ).rejects.toMatchObject({ code: 'RPC_INCONSISTENT' });
    expect(store.rewinds).toHaveLength(0);
    expect(store.cursor.nextBlock).toBe(7n);
  });

  it('enters standby for a competing worker without releasing a lease it never owned', async () => {
    const source = new MemorySource();
    const store = new MemoryStore();
    store.leaseAvailable = false;

    await expect(new IndexerScanner(source, store, decoder, options()).scanOnce()).resolves.toEqual(
      { kind: 'lease_standby', nextBlock: 1n },
    );
    expect(store.commits).toHaveLength(0);
    expect(store.releases).toBe(0);
  });
});
