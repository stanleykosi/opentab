import type {
  ArbitrumReadPort,
  ChainTransaction,
  SponsorGrantReconciliationCandidate,
  SponsorGrantReconciliationStorePort,
} from '@opentab/application';
import { AppError, type EvmAddress, sameEvmAddress, TransactionHashSchema } from '@opentab/shared';

type SponsorEvidenceChain = ArbitrumReadPort & {
  findTransaction(
    hash: ReturnType<typeof TransactionHashSchema.parse>,
  ): Promise<ChainTransaction | undefined>;
  findTransactionReceipt(
    hash: ReturnType<typeof TransactionHashSchema.parse>,
  ): Promise<{ success: boolean; blockHash: `0x${string}`; blockNumber: string } | undefined>;
  getPendingTransactionCount(address: EvmAddress): Promise<string>;
};

export interface SponsorReconciliationSummary {
  readonly inspected: number;
  readonly confirmed: number;
  readonly failed: number;
  readonly orphaned: number;
  readonly pending: number;
}

export class SponsorGrantReconciler {
  constructor(
    private readonly chain: SponsorEvidenceChain,
    private readonly store: SponsorGrantReconciliationStorePort,
    private readonly options: {
      confirmationDepth: number;
      batchSize: number;
      now?: () => Date;
    },
  ) {
    if (
      !Number.isSafeInteger(options.confirmationDepth) ||
      options.confirmationDepth < 1 ||
      options.confirmationDepth > 10_000 ||
      !Number.isSafeInteger(options.batchSize) ||
      options.batchSize < 1 ||
      options.batchSize > 250
    ) {
      throw new AppError('CONFIGURATION_INVALID', 'Sponsor reconciliation bounds are invalid.');
    }
  }

  async reconcileOnce(): Promise<SponsorReconciliationSummary> {
    const candidates = await this.store.listCandidates({ limit: this.options.batchSize });
    const summary = {
      inspected: candidates.length,
      confirmed: 0,
      failed: 0,
      orphaned: 0,
      pending: 0,
    };
    for (const candidate of candidates) {
      const outcome = await this.#reconcile(candidate);
      summary[outcome] += 1;
    }
    return summary;
  }

  async #reconcile(
    candidate: SponsorGrantReconciliationCandidate,
  ): Promise<'confirmed' | 'failed' | 'orphaned' | 'pending'> {
    const currentTransactionHash = TransactionHashSchema.parse(candidate.transactionHash);
    const transactionHashes = candidate.transactionHashes.map((hash) =>
      TransactionHashSchema.parse(hash),
    );
    if (
      transactionHashes.length === 0 ||
      transactionHashes.length > 4 ||
      !transactionHashes.includes(currentTransactionHash) ||
      new Set(transactionHashes.map((hash) => hash.toLowerCase())).size !== transactionHashes.length
    ) {
      throw new AppError('INTERNAL_ERROR', 'Sponsor transaction candidates are invalid.');
    }
    const [latest, evidence] = await Promise.all([
      this.chain.getLatestBlock(),
      Promise.all(
        transactionHashes.map(async (transactionHash) => ({
          transactionHash,
          transaction: await this.chain.findTransaction(transactionHash),
          receipt: await this.chain.findTransactionReceipt(transactionHash),
        })),
      ),
    ]);
    let canonicalEvidence:
      | {
          transactionHash: ReturnType<typeof TransactionHashSchema.parse>;
          transaction: ChainTransaction;
          receipt: { success: boolean; blockHash: `0x${string}`; blockNumber: string };
        }
      | undefined;
    for (const observed of evidence) {
      if (observed.transaction === undefined || observed.receipt === undefined) continue;
      const block = await this.chain.getBlock(observed.receipt.blockNumber);
      if (
        block.hash.toLowerCase() === observed.receipt.blockHash.toLowerCase() &&
        observed.transaction.blockHash?.toLowerCase() ===
          observed.receipt.blockHash.toLowerCase() &&
        observed.transaction.blockNumber === observed.receipt.blockNumber
      ) {
        canonicalEvidence = {
          transactionHash: observed.transactionHash,
          transaction: observed.transaction,
          receipt: observed.receipt,
        };
        break;
      }
    }
    if (canonicalEvidence === undefined) {
      if (
        candidate.status === 'confirmed' &&
        candidate.blockNumber !== undefined &&
        candidate.blockHash !== undefined
      ) {
        const canonicalBlock = await this.chain.getBlock(candidate.blockNumber);
        if (canonicalBlock.hash.toLowerCase() !== candidate.blockHash.toLowerCase()) {
          await this.store.markCanonicalOutcome({
            id: candidate.id,
            expectedTransactionHash: currentTransactionHash,
            outcome: 'orphaned',
            now: this.options.now?.() ?? new Date(),
          });
          return 'orphaned';
        }
      }
      // A consumed nonce without the exact prepared hash is not payment proof.
      // Keep it pending for operator/replacement reconciliation and never send
      // another grant automatically.
      await this.chain.getPendingTransactionCount(candidate.sponsorSignerAddress);
      return 'pending';
    }
    const { transactionHash, transaction, receipt } = canonicalEvidence;
    const latestNumber = BigInt(latest.number);
    const receiptNumber = BigInt(receipt.blockNumber);
    if (
      latestNumber < receiptNumber ||
      latestNumber - receiptNumber + 1n < BigInt(this.options.confirmationDepth)
    ) {
      return 'pending';
    }
    const exactTransfer =
      transaction.hash.toLowerCase() === transactionHash.toLowerCase() &&
      sameEvmAddress(transaction.from, candidate.sponsorSignerAddress) &&
      transaction.to !== undefined &&
      sameEvmAddress(transaction.to, candidate.recipient) &&
      BigInt(transaction.valueWei) === BigInt(candidate.amountWei) &&
      BigInt(transaction.nonce) === BigInt(candidate.signerNonce) &&
      transaction.input === '0x';
    const now = this.options.now?.() ?? new Date();
    if (!exactTransfer || !receipt.success) {
      await this.store.markCanonicalOutcome({
        id: candidate.id,
        expectedTransactionHash: transactionHash,
        outcome: 'failed',
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash,
        errorCode: exactTransfer ? 'SPONSOR_TRANSACTION_REVERTED' : 'SPONSOR_TRANSACTION_MISMATCH',
        now,
      });
      return 'failed';
    }
    await this.store.markCanonicalOutcome({
      id: candidate.id,
      expectedTransactionHash: transactionHash,
      outcome: 'confirmed',
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash,
      now,
    });
    return 'confirmed';
  }
}
