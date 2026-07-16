import type {
  ChainTransaction,
  SponsorGrantReconciliationCandidate,
  SponsorGrantReconciliationStorePort,
} from '@opentab/application';
import { BaseUnitAmountSchema, EvmAddressSchema, TransactionHashSchema } from '@opentab/shared';
import { describe, expect, it, vi } from 'vitest';
import { SponsorGrantReconciler } from '../src/sponsor-reconciler.js';

const signer = EvmAddressSchema.parse(`0x${'1'.repeat(40)}`);
const recipient = EvmAddressSchema.parse(`0x${'2'.repeat(40)}`);
const transactionHash = TransactionHashSchema.parse(`0x${'3'.repeat(64)}`);
const replacementTransactionHash = TransactionHashSchema.parse(`0x${'6'.repeat(64)}`);
const blockHash = `0x${'4'.repeat(64)}` as const;
const replacementBlockHash = `0x${'5'.repeat(64)}` as const;

function candidate(
  status: SponsorGrantReconciliationCandidate['status'] = 'submitted',
  transactionHashes: readonly string[] = [transactionHash],
): SponsorGrantReconciliationCandidate {
  const currentTransactionHash = transactionHashes.at(-1);
  if (currentTransactionHash === undefined) throw new Error('Missing sponsor transaction hash');
  return {
    id: 'grant-reconcile-1',
    status,
    recipient,
    amountWei: BaseUnitAmountSchema.parse('50000'),
    sponsorSignerAddress: signer,
    signerNonce: '7',
    transactionHashes,
    transactionHash: currentTransactionHash,
    ...(status === 'confirmed' ? { blockNumber: '100', blockHash } : {}),
  };
}

function transaction(overrides: Partial<ChainTransaction> = {}): ChainTransaction {
  return {
    hash: transactionHash,
    from: signer,
    to: recipient,
    valueWei: '50000',
    nonce: '7',
    input: '0x',
    blockNumber: '100',
    blockHash,
    ...overrides,
  };
}

function harness(input: {
  status?: SponsorGrantReconciliationCandidate['status'];
  transaction?: ChainTransaction;
  receipt?: { success: boolean; blockHash: `0x${string}`; blockNumber: string };
  canonicalBlockHash?: `0x${string}`;
  transactionHashes?: readonly string[];
  evidence?: Readonly<
    Record<
      string,
      {
        transaction?: ChainTransaction;
        receipt?: { success: boolean; blockHash: `0x${string}`; blockNumber: string };
      }
    >
  >;
}) {
  let record = candidate(input.status, input.transactionHashes);
  const transitions: string[] = [];
  const outcomeHashes: string[] = [];
  const store: SponsorGrantReconciliationStorePort = {
    listCandidates: async () => [record],
    markCanonicalOutcome: async (outcome) => {
      if (outcome.outcome === record.status) return;
      transitions.push(outcome.outcome);
      outcomeHashes.push(outcome.expectedTransactionHash);
      record = { ...record, status: outcome.outcome } as SponsorGrantReconciliationCandidate;
    },
  };
  const getPendingTransactionCount = vi.fn(async () => '8');
  const chain = {
    findTransaction: async (hash: string) =>
      input.evidence?.[hash]?.transaction ??
      (hash === transactionHash ? input.transaction : undefined),
    findTransactionReceipt: async (hash: string) =>
      input.evidence?.[hash]?.receipt ?? (hash === transactionHash ? input.receipt : undefined),
    getPendingTransactionCount,
    getLatestBlock: async () => ({
      number: '120',
      hash: replacementBlockHash,
      parentHash: blockHash,
      timestamp: '1784030700',
    }),
    getBlock: async () => ({
      number: '100',
      hash: input.canonicalBlockHash ?? blockHash,
      parentHash: replacementBlockHash,
      timestamp: '1784030600',
    }),
  };
  return {
    reconciler: new SponsorGrantReconciler(chain as never, store, {
      confirmationDepth: 12,
      batchSize: 25,
      now: () => new Date('2026-07-14T12:00:00.000Z'),
    }),
    transitions,
    outcomeHashes,
    getPendingTransactionCount,
  };
}

describe('bootstrap sponsor canonical reconciliation', () => {
  it('confirms only the exact successful transfer after canonical confirmation depth', async () => {
    const h = harness({
      transaction: transaction(),
      receipt: { success: true, blockHash, blockNumber: '100' },
    });
    await expect(h.reconciler.reconcileOnce()).resolves.toMatchObject({ confirmed: 1 });
    expect(h.transitions).toEqual(['confirmed']);
  });

  it('marks a canonically reverted transaction failed', async () => {
    const h = harness({
      transaction: transaction(),
      receipt: { success: false, blockHash, blockNumber: '100' },
    });
    await expect(h.reconciler.reconcileOnce()).resolves.toMatchObject({ failed: 1 });
    expect(h.transitions).toEqual(['failed']);
  });

  it('quarantines a wrong recipient as failed rather than treating the hash as proof', async () => {
    const h = harness({
      transaction: transaction({ to: signer }),
      receipt: { success: true, blockHash, blockNumber: '100' },
    });
    await expect(h.reconciler.reconcileOnce()).resolves.toMatchObject({ failed: 1 });
    expect(h.transitions).toEqual(['failed']);
  });

  it('keeps timeout and possible replacement states pending without rebroadcast', async () => {
    const h = harness({});
    await expect(h.reconciler.reconcileOnce()).resolves.toMatchObject({ pending: 1 });
    expect(h.transitions).toEqual([]);
    expect(h.getPendingTransactionCount).toHaveBeenCalledWith(signer);
  });

  it('confirms an earlier exact candidate when a crash-recovery replacement never settles', async () => {
    const h = harness({
      transactionHashes: [transactionHash, replacementTransactionHash],
      evidence: {
        [transactionHash]: {
          transaction: transaction(),
          receipt: { success: true, blockHash, blockNumber: '100' },
        },
      },
    });
    await expect(h.reconciler.reconcileOnce()).resolves.toMatchObject({ confirmed: 1 });
    expect(h.transitions).toEqual(['confirmed']);
    expect(h.outcomeHashes).toEqual([transactionHash]);
  });

  it('rolls a confirmed grant back to orphaned when its block is no longer canonical', async () => {
    const h = harness({
      status: 'confirmed',
      transaction: transaction(),
      receipt: { success: true, blockHash, blockNumber: '100' },
      canonicalBlockHash: replacementBlockHash,
    });
    await expect(h.reconciler.reconcileOnce()).resolves.toMatchObject({ orphaned: 1 });
    expect(h.transitions).toEqual(['orphaned']);
  });

  it('is idempotent across restart-style repeated scans', async () => {
    const h = harness({
      transaction: transaction(),
      receipt: { success: true, blockHash, blockNumber: '100' },
    });
    await h.reconciler.reconcileOnce();
    await h.reconciler.reconcileOnce();
    expect(h.transitions).toEqual(['confirmed']);
  });
});
