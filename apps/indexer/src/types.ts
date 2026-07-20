import type { ArbitrumReadPort, RawContractLog } from '@opentab/application';
import type { CanonicalEventProof, ChainId, EvmAddress, TransactionHash } from '@opentab/shared';

export interface IndexedBlock {
  readonly number: bigint;
  readonly hash: `0x${string}`;
  readonly parentHash: `0x${string}`;
  readonly observedAt: Date;
}

export interface DecodedContractEvent {
  readonly eventName: string;
  readonly fields: Readonly<Record<string, string>>;
  readonly decoderVersion: string;
}

export type DecodeResult =
  | { readonly kind: 'decoded'; readonly event: DecodedContractEvent }
  | {
      readonly kind: 'quarantined';
      readonly reasonCode: string;
      readonly safeDetails: Readonly<Record<string, string>>;
      readonly decoderVersion: string;
    };

export interface IndexedLog {
  readonly raw: RawContractLog;
  readonly decoded: DecodeResult;
  readonly payloadDigest: `0x${string}`;
  readonly confirmations: bigint;
  readonly observedAt: Date;
}

export interface IndexerCursor {
  readonly chainId: ChainId;
  readonly stream: string;
  readonly nextBlock: bigint;
  readonly lastProcessedBlock?: bigint;
  readonly lastProcessedBlockHash?: `0x${string}`;
  readonly confirmationDepth: number;
}

export interface ReorgDetails {
  readonly detectedAtBlock: bigint;
  readonly commonAncestorBlock: bigint;
  readonly oldHeadHash: `0x${string}`;
  readonly newHeadHash: `0x${string}`;
}

export interface QuarantinedLogReference {
  readonly canonicalLogId: string;
  readonly chainId: ChainId;
  readonly stream: string;
  readonly contractAddress: EvmAddress;
  readonly transactionHash: TransactionHash;
  readonly blockNumber: bigint;
  readonly blockHash: `0x${string}`;
  readonly logIndex: number;
  readonly payloadDigest: `0x${string}`;
  readonly observedAt: Date;
}

export interface IndexerStore {
  loadOrCreateCursor(input: {
    chainId: ChainId;
    stream: string;
    startBlock: bigint;
    confirmationDepth: number;
  }): Promise<IndexerCursor>;
  tryAcquireLease(input: {
    chainId: ChainId;
    stream: string;
    owner: string;
    ttlMs: number;
    now: Date;
  }): Promise<boolean>;
  releaseLease(input: {
    chainId: ChainId;
    stream: string;
    owner: string;
    now: Date;
  }): Promise<void>;
  getCanonicalBlock(input: {
    chainId: ChainId;
    stream: string;
    blockNumber: bigint;
  }): Promise<IndexedBlock | undefined>;
  commitRange(input: {
    cursor: IndexerCursor;
    blocks: readonly IndexedBlock[];
    logs: readonly IndexedLog[];
    nextBlock: bigint;
    now: Date;
  }): Promise<void>;
  rewind(input: { cursor: IndexerCursor; details: ReorgDetails; now: Date }): Promise<void>;
  loadQuarantinedLogs(input: {
    chainId: ChainId;
    stream: string;
    decoderVersion: string;
    limit: number;
  }): Promise<readonly QuarantinedLogReference[]>;
  reprocessQuarantinedLog(input: {
    canonicalLogId: string;
    log: IndexedLog;
    now: Date;
  }): Promise<boolean>;
  replayQuarantined(input: {
    chainId: ChainId;
    stream: string;
    limit: number;
    now: Date;
  }): Promise<number>;
}

export interface ContractLogDecoder {
  readonly version: string;
  decode(log: RawContractLog): DecodeResult;
}

export interface IndexerActiveScanResult {
  readonly kind: 'idle' | 'processed' | 'reorg_rewound';
  readonly latestBlock: bigint;
  readonly safeHead: bigint;
  readonly nextBlock: bigint;
  readonly processedBlocks: number;
  readonly processedLogs: number;
  readonly lagBlocks: bigint;
}

/** A healthy passive worker waiting for the single active stream lease. */
export interface IndexerLeaseStandbyResult {
  readonly kind: 'lease_standby';
  readonly nextBlock: bigint;
}

export type IndexerScanResult = IndexerActiveScanResult | IndexerLeaseStandbyResult;

export type IndexerChainSource = ArbitrumReadPort;

export interface CanonicalProjectorEvent {
  readonly event: CanonicalEventProof;
  readonly canonicalLogId: string;
}
