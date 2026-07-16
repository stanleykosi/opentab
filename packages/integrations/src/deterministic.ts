import type {
  Eip7702AuthorizationEvidence,
  Eip7702AuthorizationEvidenceReadPort,
  MagicIdentityVerifierPort,
  MagicWalletPort,
  UniversalOperationPort,
} from '@opentab/application';
import {
  AdapterEvidenceSchema,
  AppError,
  ARBITRUM_ONE_CHAIN_ID,
  BaseUnitAmountSchema,
  type BoundOperationTemplate,
  BoundOperationTemplateSchema,
  DelegationStatusSchema,
  type EvmAddress,
  EvmAddressSchema,
  type ProviderOperation,
  type ProviderOperationId,
  ProviderOperationIdSchema,
  ProviderOperationSchema,
  QuotePreviewSchema,
  sameEvmAddress,
  TransactionHashSchema,
  type UnifiedBalance,
  type UntrustedPreparedOperation,
  UntrustedPreparedOperationSchema,
  type ValidatedOperationPlan,
  ValidatedOperationPlanSchema,
  VerifiedDelegationPlanSchema,
  type VerifiedMagicIdentity,
  VerifiedMagicIdentitySchema,
} from '@opentab/shared';
import { getBytes, verifyMessage, Wallet } from 'ethers';
import { digestUnknown } from './evidence.js';

function assertDeterministicEnvironment(environment: string): void {
  if (!['local', 'test', 'preview'].includes(environment)) {
    throw new AppError(
      'CONFIGURATION_INVALID',
      'Deterministic providers are restricted to local, test, and preview.',
    );
  }
}

function evidence(environment: string, payload: unknown) {
  return AdapterEvidenceSchema.parse({
    adapter: 'opentab-deterministic',
    packageVersion: '1.0.0',
    schemaVersion: 1,
    environment,
    observedAt: new Date().toISOString(),
    evidenceDigest: digestUnknown(payload),
    provenance: 'deterministic',
  });
}

export class DeterministicEip7702AuthorizationEvidenceAdapter
  implements Eip7702AuthorizationEvidenceReadPort
{
  readonly #evidenceByHash = new Map<string, Eip7702AuthorizationEvidence>();

  constructor(environment: string, records: readonly Eip7702AuthorizationEvidence[]) {
    assertDeterministicEnvironment(environment);
    for (const record of records) {
      const transactionHash = TransactionHashSchema.parse(record.transactionHash);
      EvmAddressSchema.parse(record.transactionFrom);
      EvmAddressSchema.parse(record.authority);
      EvmAddressSchema.parse(record.delegate);
      if (
        record.transactionType !== 'eip7702' ||
        record.chainId !== ARBITRUM_ONE_CHAIN_ID ||
        record.authorizationIndex !== 0 ||
        record.canonical !== true ||
        !/^0x[0-9a-fA-F]{64}$/.test(record.blockHash) ||
        !/^(0|[1-9][0-9]*)$/.test(record.blockNumber) ||
        !/^(0|[1-9][0-9]*)$/.test(record.authorizationNonce)
      ) {
        throw new AppError('CONFIGURATION_INVALID', 'Deterministic EIP-7702 evidence is invalid.');
      }
      const key = transactionHash.toLowerCase();
      if (this.#evidenceByHash.has(key)) {
        throw new AppError(
          'CONFIGURATION_INVALID',
          'Deterministic EIP-7702 evidence hashes must be unique.',
        );
      }
      this.#evidenceByHash.set(key, Object.freeze({ ...record }));
    }
  }

  async getEip7702AuthorizationEvidence(
    input: Parameters<Eip7702AuthorizationEvidenceReadPort['getEip7702AuthorizationEvidence']>[0],
  ): ReturnType<Eip7702AuthorizationEvidenceReadPort['getEip7702AuthorizationEvidence']> {
    const record = this.#evidenceByHash.get(input.transactionHash.toLowerCase());
    if (
      record === undefined ||
      !sameEvmAddress(record.authority, input.expectedAuthority) ||
      !sameEvmAddress(record.delegate, input.expectedDelegate)
    ) {
      throw new AppError(
        'UA_DELEGATION_REQUIRED',
        'No matching deterministic EIP-7702 authorization evidence exists.',
      );
    }
    return record;
  }
}

export class DeterministicMagicIdentityVerifier implements MagicIdentityVerifierPort {
  constructor(
    environment: string,
    private readonly acceptedToken: string,
    private readonly identity: VerifiedMagicIdentity,
  ) {
    assertDeterministicEnvironment(environment);
    VerifiedMagicIdentitySchema.parse(identity);
  }

  async verifyDidToken(input: {
    didToken: string;
    expectedAudience: string;
    expectedApplicationId: string;
  }): Promise<VerifiedMagicIdentity> {
    if (
      input.didToken !== this.acceptedToken ||
      input.expectedAudience !== this.identity.audience ||
      input.expectedApplicationId !== this.identity.applicationId
    ) {
      throw new AppError('AUTH_DID_INVALID', 'The deterministic identity proof is invalid.');
    }
    return this.identity;
  }
}

export class DeterministicMagicWallet implements MagicWalletPort {
  readonly #wallet: Wallet;
  #chainId = ARBITRUM_ONE_CHAIN_ID;

  constructor(
    environment: string,
    private readonly didToken: string,
    private readonly ownerAddress: EvmAddress,
    privateKey: `0x${string}`,
  ) {
    assertDeterministicEnvironment(environment);
    this.#wallet = new Wallet(privateKey);
    if (!sameEvmAddress(EvmAddressSchema.parse(this.#wallet.address), ownerAddress)) {
      throw new AppError('CONFIGURATION_INVALID', 'Deterministic wallet key/address mismatch.');
    }
  }

  async loginWithGoogle(): Promise<void> {}

  async completeGoogleRedirect() {
    return { didToken: this.didToken, authMethod: 'google' as const };
  }

  async loginWithEmailOtp() {
    return { didToken: this.didToken, authMethod: 'email_otp' as const };
  }

  async getOwnerAddress(): Promise<EvmAddress> {
    return this.ownerAddress;
  }

  async getChainId(): Promise<string> {
    return this.#chainId;
  }

  async switchToArbitrum(): Promise<void> {
    this.#chainId = ARBITRUM_ONE_CHAIN_ID;
  }

  async authorizeDelegation(planInput: Parameters<MagicWalletPort['authorizeDelegation']>[0]) {
    const plan = VerifiedDelegationPlanSchema.parse(planInput);
    if (!sameEvmAddress(plan.ownerAddress, this.ownerAddress)) {
      throw new AppError('WALLET_ADDRESS_MISMATCH', 'Deterministic delegation owner mismatch.');
    }
    return {
      authorization: {
        contractAddress: plan.implementationAddress,
        chainId: Number(plan.chainId),
        nonce: Number(plan.nonce),
        evidenceDigest: digestUnknown(plan),
      },
    };
  }

  async submitDelegation(planInput: Parameters<MagicWalletPort['submitDelegation']>[0]) {
    const plan = VerifiedDelegationPlanSchema.parse(planInput);
    return {
      transactionHash: digestUnknown({ kind: 'delegation', plan }),
      submissionPossible: true,
    };
  }

  async signValidatedRoot(planInput: ValidatedOperationPlan) {
    const plan = ValidatedOperationPlanSchema.parse(planInput);
    const signature = await this.#wallet.signMessage(getBytes(plan.rootHash));
    const recoveredOwner = EvmAddressSchema.parse(
      verifyMessage(getBytes(plan.rootHash), signature),
    );
    return { signature, recoveredOwner };
  }

  async logout(): Promise<void> {}
}

export interface DeterministicUniversalConfig {
  readonly environment: string;
  readonly ownerAddress: EvmAddress;
  readonly implementationAddress: EvmAddress;
  readonly implementationCodeHash: `0x${string}`;
  readonly delegated: boolean;
  readonly unifiedBalance: UnifiedBalance;
  readonly now?: () => Date;
}

interface DeterministicPrepared {
  readonly template: BoundOperationTemplate;
  readonly prepared: UntrustedPreparedOperation;
}

export class DeterministicUniversalOperationAdapter implements UniversalOperationPort {
  readonly #prepared = new Map<string, DeterministicPrepared>();
  readonly #operations = new Map<ProviderOperationId, ProviderOperation>();

  constructor(private readonly config: DeterministicUniversalConfig) {
    assertDeterministicEnvironment(config.environment);
  }

  async getAccount() {
    return {
      ownerAddress: this.config.ownerAddress,
      evmAddress: this.config.ownerAddress,
      protocolVersion: 'deterministic-eip7702-v1',
      eip7702: true as const,
    };
  }

  async getUnifiedBalance(): Promise<UnifiedBalance> {
    return this.config.unifiedBalance;
  }

  async getDelegation() {
    return DelegationStatusSchema.parse({
      ownerAddress: this.config.ownerAddress,
      chainId: ARBITRUM_ONE_CHAIN_ID,
      delegated: this.config.delegated,
      ...(this.config.delegated
        ? {
            implementationAddress: this.config.implementationAddress,
            implementationCodeHash: this.config.implementationCodeHash,
          }
        : {}),
      evidence: evidence(this.config.environment, { delegated: this.config.delegated }),
    });
  }

  async prepareDelegation() {
    const now = this.config.now?.() ?? new Date();
    return VerifiedDelegationPlanSchema.parse({
      ownerAddress: this.config.ownerAddress,
      chainId: ARBITRUM_ONE_CHAIN_ID,
      implementationAddress: this.config.implementationAddress,
      implementationCodeHash: this.config.implementationCodeHash,
      nonce: '0',
      transactionTarget: this.config.ownerAddress,
      data: '0x',
      valueWei: '0',
      expiresAt: new Date(now.getTime() + 300_000).toISOString(),
      bindingDigest: digestUnknown({ owner: this.config.ownerAddress, nonce: 0 }),
    });
  }

  async prepareOperation(templateInput: BoundOperationTemplate) {
    const template = BoundOperationTemplateSchema.parse(templateInput);
    if (!sameEvmAddress(template.ownerAddress, this.config.ownerAddress)) {
      throw new AppError('WALLET_ADDRESS_MISMATCH', 'Deterministic operation owner mismatch.');
    }
    const now = this.config.now?.() ?? new Date();
    const rootHash = digestUnknown({ kind: 'deterministic-operation', template });
    const prepared = UntrustedPreparedOperationSchema.parse({
      kind: template.kind,
      rawSchemaVersion: 'deterministic-v1',
      rootHash,
      providerOperationId: `det_${rootHash.slice(2, 34)}`,
      quotedAt: now.toISOString(),
      expiresAt: template.expiresAt,
      redactedPayloadDigest: digestUnknown(template),
    });
    this.#prepared.set(rootHash, { template, prepared });
    return prepared;
  }

  async validateOperation(input: {
    template: BoundOperationTemplate;
    prepared: UntrustedPreparedOperation;
  }) {
    const template = BoundOperationTemplateSchema.parse(input.template);
    const prepared = UntrustedPreparedOperationSchema.parse(input.prepared);
    const cached = this.#prepared.get(prepared.rootHash);
    if (cached === undefined || digestUnknown(cached.template) !== digestUnknown(template)) {
      throw new AppError('OPERATION_PLAN_INVALID', 'Deterministic operation binding mismatch.');
    }
    const now = this.config.now?.() ?? new Date();
    return ValidatedOperationPlanSchema.parse({
      planId: digestUnknown({ rootHash: prepared.rootHash, binding: template.bindingDigest }),
      template,
      rootHash: prepared.rootHash,
      quote: QuotePreviewSchema.parse({
        amountBaseUnits: BaseUnitAmountSchema.parse('0'),
        estimatedFeeUsd: '0',
        totalUsd: '0',
        slippageBps: '0',
        sources: [{ chainId: '8453', symbol: 'USDC', amount: '0', amountUsd: '0' }],
        quotedAt: now.toISOString(),
        expiresAt: prepared.expiresAt,
      }),
      validatedAt: now.toISOString(),
      expiresAt: prepared.expiresAt,
    });
  }

  async submitValidated(input: { plan: ValidatedOperationPlan; rootSignature: string }) {
    const plan = ValidatedOperationPlanSchema.parse(input.plan);
    if (!/^0x[0-9a-fA-F]+$/.test(input.rootSignature)) {
      throw new AppError('UA_SIGNATURE_REJECTED', 'Deterministic signature is invalid.');
    }
    const id = ProviderOperationIdSchema.parse(`det_${plan.planId.slice(2, 34)}`);
    const operation = ProviderOperationSchema.parse({
      id,
      status: 'executing',
      submissionPossible: true,
      updatedAt: (this.config.now?.() ?? new Date()).toISOString(),
      evidence: evidence(this.config.environment, { id, planId: plan.planId }),
    });
    this.#operations.set(id, operation);
    return operation;
  }

  async getOperation(idInput: ProviderOperationId) {
    const id = ProviderOperationIdSchema.parse(idInput);
    const operation = this.#operations.get(id);
    if (operation === undefined) {
      throw new AppError('UA_STATUS_UNKNOWN', 'Deterministic operation was not found.');
    }
    return operation;
  }

  confirm(idInput: ProviderOperationId, destinationTransactionHash: `0x${string}`): void {
    const id = ProviderOperationIdSchema.parse(idInput);
    const current = this.#operations.get(id);
    if (current === undefined) throw new AppError('UA_STATUS_UNKNOWN', 'Operation was not found.');
    this.#operations.set(
      id,
      ProviderOperationSchema.parse({
        ...current,
        status: 'succeeded',
        destinationTransactionHash,
        updatedAt: (this.config.now?.() ?? new Date()).toISOString(),
      }),
    );
  }
}

export function assertProviderMode(input: {
  providerMode: 'deterministic' | 'live';
  environment: string;
  deterministicDemoEnabled: boolean;
}): void {
  if (input.providerMode === 'deterministic') {
    assertDeterministicEnvironment(input.environment);
    if (!input.deterministicDemoEnabled) {
      throw new AppError(
        'CONFIGURATION_INVALID',
        'Deterministic provider mode requires its explicit flag.',
      );
    }
  } else if (input.deterministicDemoEnabled && input.environment === 'production') {
    throw new AppError(
      'CONFIGURATION_INVALID',
      'Production cannot enable deterministic demo mode.',
    );
  }
}
