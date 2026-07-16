import type {
  BoundOperationTemplate,
  DelegationStatus,
  EvmAddress,
  ProviderOperation,
  ProviderOperationId,
  UnifiedBalance,
  UntrustedPreparedOperation,
  ValidatedOperationPlan,
  VerifiedDelegationPlan,
} from '@opentab/shared';

export interface UniversalAccountIdentity {
  ownerAddress: EvmAddress;
  evmAddress: EvmAddress;
  solanaAddress?: string;
  protocolVersion: string;
  eip7702: true;
}

export interface UniversalOperationPort {
  getAccount(): Promise<UniversalAccountIdentity>;
  getUnifiedBalance(): Promise<UnifiedBalance>;
  getDelegation(): Promise<DelegationStatus>;
  prepareDelegation(): Promise<VerifiedDelegationPlan>;
  prepareOperation(template: BoundOperationTemplate): Promise<UntrustedPreparedOperation>;
  validateOperation(input: {
    template: BoundOperationTemplate;
    prepared: UntrustedPreparedOperation;
  }): Promise<ValidatedOperationPlan>;
  submitValidated(input: {
    plan: ValidatedOperationPlan;
    rootSignature: string;
  }): Promise<ProviderOperation>;
  getOperation(id: ProviderOperationId): Promise<ProviderOperation>;
}
