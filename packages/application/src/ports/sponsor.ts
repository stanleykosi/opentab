import type { BaseUnitAmount, ChainId, EvmAddress, TransactionHash } from '@opentab/shared';

export interface SponsorTransferPort {
  getSignerHealth(input: { chainId: ChainId }): Promise<{
    signerAddress: EvmAddress;
    balanceWei: BaseUnitAmount;
    pendingNonce: string;
    observedAt: string;
  }>;
  prepareActivationGas(input: {
    chainId: ChainId;
    recipient: EvmAddress;
    amountWei: BaseUnitAmount;
    idempotencyReference: string;
    signerNonce: string;
  }): Promise<{
    transactionHash: TransactionHash;
    signerNonce: string;
    submit(): Promise<
      | { status: 'submitted'; transactionHash: TransactionHash; signerNonce: string }
      | { status: 'submitted_unknown'; transactionHash: TransactionHash; signerNonce: string }
    >;
  }>;
}

export interface OrderIntentSignerPort<TIntent> {
  signIntent(intent: TIntent): Promise<{
    digest: `0x${string}`;
    signature: `0x${string}`;
    signerAddress: EvmAddress;
    signerKeyId: string;
  }>;
}
