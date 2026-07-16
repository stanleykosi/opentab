import type {
  CanonicalEventProof,
  ChainId,
  EvmAddress,
  OrderKey,
  ProductId,
  TransactionHash,
} from '@opentab/shared';

export interface ChainBlock {
  number: string;
  hash: `0x${string}`;
  parentHash: `0x${string}`;
  timestamp: string;
}

export interface RawContractLog {
  chainId: ChainId;
  contractAddress: EvmAddress;
  transactionHash: TransactionHash;
  blockNumber: string;
  blockHash: `0x${string}`;
  logIndex: string;
  topics: readonly `0x${string}`[];
  data: `0x${string}`;
}

export interface ChainTransaction {
  readonly hash: TransactionHash;
  readonly from: EvmAddress;
  readonly to?: EvmAddress;
  readonly valueWei: string;
  readonly nonce: string;
  readonly input: `0x${string}`;
  readonly blockNumber?: string;
  readonly blockHash?: `0x${string}`;
}

/**
 * Public, signature-free proof that a canonical Arbitrum Type-4 transaction
 * carried the exact EIP-7702 authorization expected by the application.
 */
export interface Eip7702AuthorizationEvidence {
  readonly transactionHash: TransactionHash;
  readonly transactionFrom: EvmAddress;
  readonly transactionType: 'eip7702';
  readonly blockNumber: string;
  readonly blockHash: `0x${string}`;
  readonly authority: EvmAddress;
  readonly delegate: EvmAddress;
  readonly chainId: ChainId;
  readonly authorizationIndex: 0;
  readonly authorizationNonce: string;
  readonly canonical: true;
}

export interface Eip7702AuthorizationEvidenceReadPort {
  getEip7702AuthorizationEvidence(input: {
    transactionHash: TransactionHash;
    expectedAuthority: EvmAddress;
    expectedDelegate: EvmAddress;
  }): Promise<Eip7702AuthorizationEvidence>;
}

export interface ArbitrumReadPort {
  getLatestBlock(): Promise<ChainBlock>;
  getBlock(blockNumber: string): Promise<ChainBlock>;
  getLogs(input: {
    fromBlock: string;
    toBlock: string;
    addresses: readonly EvmAddress[];
  }): Promise<readonly RawContractLog[]>;
  getNativeBalance(address: EvmAddress): Promise<string>;
  getDelegationCode(address: EvmAddress): Promise<{
    accountType: 'eoa' | 'delegated_eoa' | 'contract';
    implementation?: EvmAddress;
    codeHash: `0x${string}`;
  }>;
  /** Returns the exact runtime bytecode hash for a trusted implementation check. */
  getCodeHash?(address: EvmAddress): Promise<`0x${string}`>;
  /**
   * Optional only for backwards-compatible read doubles. Live composition must
   * require this capability before accepting delegation evidence.
   */
  getEip7702AuthorizationEvidence?(
    input: Parameters<Eip7702AuthorizationEvidenceReadPort['getEip7702AuthorizationEvidence']>[0],
  ): ReturnType<Eip7702AuthorizationEvidenceReadPort['getEip7702AuthorizationEvidence']>;
  getTransactionReceipt(
    hash: TransactionHash,
  ): Promise<{ success: boolean; blockHash: `0x${string}`; blockNumber: string }>;
  /** Sponsor reconciliation uses these optional reads only after runtime capability checks. */
  findTransaction?(hash: TransactionHash): Promise<ChainTransaction | undefined>;
  findTransactionReceipt?(
    hash: TransactionHash,
  ): Promise<{ success: boolean; blockHash: `0x${string}`; blockNumber: string } | undefined>;
  getPendingTransactionCount?(address: EvmAddress): Promise<string>;
  findOrderEvent(orderKey: OrderKey): Promise<CanonicalEventProof | undefined>;
  readProduct(productId: ProductId): Promise<unknown>;
  /** Reads the checkout contract's current fee for signer/startup parity checks. */
  readPlatformFeeBps?(): Promise<string>;
}
