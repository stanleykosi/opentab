import type { ArbitrumReadPort } from '@opentab/application';
import { ARBITRUM_ONE_CHAIN_ID, EvmAddressSchema } from '@opentab/shared';
import { describe, expect, it } from 'vitest';
import { parseIndexerRuntimeConfig } from '../src/config.js';
import { startIndexerRuntime } from '../src/runtime.js';
import type {
  IndexedBlock,
  IndexedLog,
  IndexerCursor,
  IndexerStore,
  QuarantinedLogReference,
} from '../src/types.js';

const checkout = EvmAddressSchema.parse(`0x${'1'.repeat(40)}`);
const pass = EvmAddressSchema.parse(`0x${'2'.repeat(40)}`);
const hash = `0x${'0'.repeat(64)}` as const;

function environment(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    APP_ENV: 'test',
    NEXT_PUBLIC_APP_ENV: 'test',
    INDEXER_ENABLED: 'true',
    INDEXER_WRITES_ENABLED: 'true',
    INDEXER_RECONCILIATION_ENABLED: 'false',
    NEXT_PUBLIC_CHECKOUT_ADDRESS: checkout,
    NEXT_PUBLIC_PASS_ADDRESS: pass,
    DATABASE_URL_INDEXER: 'postgres://opentab_indexer@localhost:5432/opentab',
    ARBITRUM_RPC_URL: 'http://rpc-primary.test',
    ARBITRUM_FALLBACK_RPC_URL: 'http://rpc-fallback.test',
    PARTICLE_EIP7702_IMPLEMENTATION_ADDRESS: `0x${'4'.repeat(40)}`,
    CONFIRMATION_DEPTH: '1',
    REORG_WINDOW_BLOCKS: '16',
    INDEXER_DEPLOYMENT_BLOCK: '1',
    INDEXER_HEALTH_PORT: '0',
    ...overrides,
  };
}

function source(): ArbitrumReadPort {
  const unused = async (): Promise<never> => {
    throw new Error('not used');
  };
  return {
    getLatestBlock: async () => ({ number: '0', hash, parentHash: hash, timestamp: '0' }),
    getBlock: unused,
    getLogs: async () => [],
    getNativeBalance: unused,
    getDelegationCode: unused,
    getTransactionReceipt: unused,
    findOrderEvent: async () => undefined,
    readProduct: async () => undefined,
  };
}

class RuntimeStore implements IndexerStore {
  releases = 0;
  readonly cursor: IndexerCursor = {
    chainId: ARBITRUM_ONE_CHAIN_ID,
    stream: 'opentab-contracts-v3',
    nextBlock: 1n,
    confirmationDepth: 1,
  };

  async loadOrCreateCursor(): Promise<IndexerCursor> {
    return this.cursor;
  }

  async tryAcquireLease(): Promise<boolean> {
    return true;
  }

  async releaseLease(): Promise<void> {
    this.releases += 1;
  }

  async getCanonicalBlock(): Promise<IndexedBlock | undefined> {
    return undefined;
  }

  async commitRange(): Promise<void> {
    throw new Error('idle scan must not commit');
  }

  async rewind(): Promise<void> {
    throw new Error('idle scan must not rewind');
  }

  async replayQuarantined(): Promise<number> {
    return 0;
  }

  async loadQuarantinedLogs(): Promise<readonly QuarantinedLogReference[]> {
    return [];
  }

  async reprocessQuarantinedLog(_input: { log: IndexedLog }): Promise<boolean> {
    return false;
  }
}

function logger() {
  const events: string[] = [];
  return {
    events,
    value: {
      info: (_fields: unknown, message?: string) => {
        if (message !== undefined) events.push(message);
      },
      warn: (_fields: unknown, message?: string) => {
        if (message !== undefined) events.push(message);
      },
      error: (_fields: unknown, message?: string) => {
        if (message !== undefined) events.push(message);
      },
    },
  };
}

describe('validated indexer runtime composition', () => {
  it('allows an explicitly disabled built artifact without live dependencies', async () => {
    const log = logger();
    const runtime = await startIndexerRuntime({
      env: environment({ INDEXER_ENABLED: 'false', INDEXER_WRITES_ENABLED: 'false' }),
      logger: log.value,
    });
    await runtime.completion;
    expect(runtime.mode).toBe('disabled');
    expect(log.events).toContain('OpenTab indexer is disabled');
  });

  it('fails closed when enabled without injected RPC adapters', async () => {
    await expect(
      startIndexerRuntime({ env: environment(), logger: logger().value }),
    ).rejects.toMatchObject({ code: 'CONFIGURATION_INVALID' });
  });

  it('runs one complete scan with injected ports, health server, lease, and drain', async () => {
    const store = new RuntimeStore();
    let closes = 0;
    const runtime = await startIndexerRuntime({
      env: environment(),
      dependencies: {
        primaryChain: source(),
        fallbackChain: source(),
        store,
        close: async () => {
          closes += 1;
        },
      },
      logger: logger().value,
      runOnce: true,
    });
    await runtime.completion;

    expect(runtime.mode).toBe('running');
    expect(store.releases).toBe(1);
    expect(closes).toBe(1);
  });

  it('starts paused without scanning and closes on drain', async () => {
    const store = new RuntimeStore();
    let closes = 0;
    const runtime = await startIndexerRuntime({
      env: environment({ INDEXER_WRITES_ENABLED: 'false' }),
      dependencies: {
        primaryChain: source(),
        fallbackChain: source(),
        store,
        close: async () => {
          closes += 1;
        },
      },
      logger: logger().value,
    });
    expect(runtime.mode).toBe('paused');
    await runtime.stop();
    await runtime.completion;
    expect(store.releases).toBe(0);
    expect(closes).toBe(1);
  });

  it('rejects unsafe address and retry configuration before opening resources', () => {
    expect(() =>
      parseIndexerRuntimeConfig(environment({ NEXT_PUBLIC_PASS_ADDRESS: `0x${'0'.repeat(40)}` })),
    ).toThrow();
    expect(() =>
      parseIndexerRuntimeConfig(
        environment({ INDEXER_RETRY_BASE_MS: '5000', INDEXER_RETRY_MAX_MS: '1000' }),
      ),
    ).toThrow();
  });

  it('uses explicit health port first, otherwise Railway PORT, and rejects loose values', () => {
    expect(parseIndexerRuntimeConfig(environment({ PORT: '4310' })).healthPort).toBe(0);
    expect(
      parseIndexerRuntimeConfig(environment({ INDEXER_HEALTH_PORT: '4311', PORT: '4310' }))
        .healthPort,
    ).toBe(4311);
    const railwayOnly = environment({ PORT: '4310' });
    delete railwayOnly['INDEXER_HEALTH_PORT'];
    expect(parseIndexerRuntimeConfig(railwayOnly).healthPort).toBe(4310);
    for (const value of [' 3002', '1e3', '-1', '65536']) {
      const invalid = environment({ PORT: value });
      delete invalid['INDEXER_HEALTH_PORT'];
      expect(() => parseIndexerRuntimeConfig(invalid)).toThrow();
    }
  });
});
