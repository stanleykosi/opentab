import { createHash, randomBytes } from 'node:crypto';
import type { ContractOperationRecord } from '@opentab/application';
import type { CurrentUser } from '@opentab/shared';
import {
  AppError,
  ARBITRUM_ONE_CHAIN_ID,
  BoundOperationTemplateSchema,
  EvidenceDigestSchema,
  EvmAddressSchema,
  MerchantIdSchema,
  ProductIdSchema,
  ProductSchema,
  ProviderOperationIdSchema,
  type SplitIdSchema,
  SplitInvitationIdSchema,
  sameEvmAddress,
  TransactionHashSchema,
  UnsignedIntegerStringSchema,
} from '@opentab/shared';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  hashOpaqueSecret,
  hashSplitInvitationCapability,
  opaqueId,
  randomSecret,
} from './crypto.js';
import { DrizzleMerchantRepository, DrizzleProductRepository } from './repositories.js';
import {
  auditLogs,
  checkoutLinks,
  configSnapshots,
  contractOperations,
  delegationRecords,
  loyaltyBalances,
  loyaltyPrograms,
  merchants,
  orders,
  outboxEvents,
  products,
  refunds,
  settlementCredits,
  splitInvitations,
  splitParticipants,
  splitPayments,
  splits,
  walletAccounts,
  withdrawals,
} from './schema/index.js';
import type { PostgresUnitOfWork } from './unit-of-work.js';

function membership(
  actor: CurrentUser,
  merchantId: string,
  roles: readonly ('owner' | 'admin' | 'operator' | 'viewer')[],
): void {
  const found = actor.merchantMemberships.find((entry) => entry.merchantId === merchantId);
  if (found === undefined || !roles.includes(found.role)) {
    throw new AppError('AUTH_FORBIDDEN', 'You are not authorized to manage this merchant.');
  }
}

function capabilityHash(pepper: string, value: string): string {
  return hashOpaqueSecret({ domain: 'checkout-link', pepper, value });
}

export class PostgresBackendApiStore {
  readonly #merchants: DrizzleMerchantRepository;
  readonly #products: DrizzleProductRepository;

  constructor(
    private readonly uow: PostgresUnitOfWork,
    private readonly capabilityPepper: string,
    private readonly now: () => Date = () => new Date(),
    private readonly paymentKey: () => `0x${string}` = () => `0x${randomBytes(32).toString('hex')}`,
  ) {
    if (capabilityPepper.length < 32)
      throw new Error('Capability pepper must be at least 32 bytes');
    this.#merchants = new DrizzleMerchantRepository(uow);
    this.#products = new DrizzleProductRepository(uow);
  }

  async getMerchantProfile(actor: CurrentUser) {
    const member = actor.merchantMemberships[0];
    if (member === undefined) return undefined;
    const [record] = await this.uow
      .current()
      .select({
        id: merchants.id,
        version: merchants.version,
        chainSyncStatus: merchants.chainSyncStatus,
      })
      .from(merchants)
      .where(eq(merchants.id, member.merchantId))
      .limit(1);
    if (record === undefined) return undefined;
    const merchant = await this.#merchants.findById(MerchantIdSchema.parse(record.id));
    if (merchant === undefined) return undefined;
    const [operation] = await this.uow
      .current()
      .select()
      .from(contractOperations)
      .where(
        and(
          eq(contractOperations.aggregateType, 'merchant'),
          eq(contractOperations.aggregateId, merchant.id),
          eq(contractOperations.actorUserId, actor.id),
        ),
      )
      .orderBy(sql`${contractOperations.createdAt} desc`)
      .limit(1);
    return {
      merchant,
      version: record.version.toString(),
      chainSyncStatus: record.chainSyncStatus,
      ...(operation === undefined ? {} : { operation: this.contractOperationRecord(operation) }),
    };
  }

  async recordConfigurationSnapshot(input: {
    environment: 'local' | 'test' | 'preview' | 'staging' | 'demo-mainnet' | 'production';
    applicationVersion: string;
    safeConfig: Record<string, string | boolean>;
    activatedAt: Date;
  }): Promise<string> {
    const configDigest = `0x${createHash('sha256')
      .update(JSON.stringify(Object.fromEntries(Object.entries(input.safeConfig).sort())), 'utf8')
      .digest('hex')}`;
    await this.uow.transaction(async () => {
      await this.uow
        .current()
        .update(configSnapshots)
        .set({
          deactivatedAt: input.activatedAt,
        })
        .where(
          and(
            eq(configSnapshots.environment, input.environment),
            isNull(configSnapshots.deactivatedAt),
          ),
        );
      await this.uow
        .current()
        .insert(configSnapshots)
        .values({
          environment: input.environment,
          configDigest,
          safeConfig: input.safeConfig,
          applicationVersion: input.applicationVersion,
          activatedAt: input.activatedAt,
        })
        .onConflictDoUpdate({
          target: [configSnapshots.environment, configSnapshots.configDigest],
          set: {
            safeConfig: input.safeConfig,
            applicationVersion: input.applicationVersion,
            activatedAt: input.activatedAt,
            deactivatedAt: null,
          },
        });
    });
    return configDigest;
  }

  async recordDelegationEvidence(input: {
    actor: CurrentUser;
    environment: 'local' | 'test' | 'preview' | 'staging' | 'demo-mainnet' | 'production';
    implementationAddress: CurrentUser['walletAddress'];
    implementationCodeHash: `0x${string}`;
    transactionHash: string;
    blockNumber: string;
    blockHash: `0x${string}`;
    evidenceDigest: ReturnType<typeof EvidenceDigestSchema.parse>;
    observedAt: Date;
  }): Promise<void> {
    const transactionHash = TransactionHashSchema.parse(input.transactionHash.toLowerCase());
    const blockNumber = BigInt(input.blockNumber);
    if (blockNumber < 0n)
      throw new AppError('VALIDATION_FAILED', 'The delegation block is invalid.');
    const ownerAddressLower = input.actor.walletAddress.toLowerCase();
    const implementationAddressLower = input.implementationAddress.toLowerCase();
    const implementationCodeHash = EvidenceDigestSchema.parse(
      input.implementationCodeHash.toLowerCase(),
    );
    const blockHash = EvidenceDigestSchema.parse(input.blockHash.toLowerCase());
    const evidenceDigest = EvidenceDigestSchema.parse(input.evidenceDigest.toLowerCase());
    await this.uow.transaction(async () => {
      const [inserted] = await this.uow
        .current()
        .insert(delegationRecords)
        .values({
          userId: input.actor.id,
          environment: input.environment,
          chainId: ARBITRUM_ONE_CHAIN_ID,
          ownerAddressLower,
          implementationAddressLower,
          implementationCodeHash,
          status: 'confirmed',
          transactionHash,
          blockNumber,
          blockHash,
          evidenceDigest,
          checkedAt: input.observedAt,
          createdAt: input.observedAt,
          updatedAt: input.observedAt,
        })
        .onConflictDoNothing()
        .returning({ id: delegationRecords.id });

      const [persisted] = await this.uow
        .current()
        .select({
          userId: delegationRecords.userId,
          environment: delegationRecords.environment,
          chainId: delegationRecords.chainId,
          ownerAddressLower: delegationRecords.ownerAddressLower,
          implementationAddressLower: delegationRecords.implementationAddressLower,
          implementationCodeHash: delegationRecords.implementationCodeHash,
          status: delegationRecords.status,
          blockNumber: delegationRecords.blockNumber,
          blockHash: delegationRecords.blockHash,
          evidenceDigest: delegationRecords.evidenceDigest,
        })
        .from(delegationRecords)
        .where(sql`lower(${delegationRecords.transactionHash}) = ${transactionHash}`)
        .for('update')
        .limit(1);
      if (persisted === undefined) {
        throw new AppError('INTERNAL_ERROR', 'The delegation evidence could not be persisted.');
      }
      const sameBinding =
        persisted.userId === input.actor.id &&
        persisted.environment === input.environment &&
        persisted.chainId === ARBITRUM_ONE_CHAIN_ID.toString() &&
        persisted.ownerAddressLower === ownerAddressLower &&
        persisted.implementationAddressLower === implementationAddressLower &&
        persisted.implementationCodeHash === implementationCodeHash &&
        persisted.status === 'confirmed' &&
        persisted.blockNumber === blockNumber &&
        persisted.blockHash === blockHash &&
        persisted.evidenceDigest === evidenceDigest;
      if (!sameBinding) {
        throw new AppError(
          'IDEMPOTENCY_CONFLICT',
          'The delegation transaction is already bound to different evidence.',
        );
      }
      if (inserted === undefined) return;

      await this.uow
        .current()
        .insert(walletAccounts)
        .values({
          userId: input.actor.id,
          environment: input.environment,
          ownerAddressLower,
          universalAccountAddressLower: ownerAddressLower,
          sdkPackageVersion: 'server-chain-proof-v2',
          protocolVersion: 'particle-eip7702-v1',
          eip7702Enabled: true,
          delegationStatus: 'confirmed',
          arbitrumImplementation: implementationAddressLower,
          delegationTransactionHash: transactionHash,
          checkedAt: input.observedAt,
          evidenceDigest,
          createdAt: input.observedAt,
          updatedAt: input.observedAt,
        })
        .onConflictDoUpdate({
          target: [walletAccounts.userId, walletAccounts.environment],
          set: {
            ownerAddressLower,
            universalAccountAddressLower: ownerAddressLower,
            delegationStatus: 'confirmed',
            arbitrumImplementation: implementationAddressLower,
            delegationTransactionHash: transactionHash,
            checkedAt: input.observedAt,
            evidenceDigest,
            updatedAt: input.observedAt,
          },
        });
    });
  }

  async updateMerchantProfile(input: {
    actor: CurrentUser;
    expectedVersion: string;
    patch: {
      slug?: string;
      displayName?: string;
      supportContact?: string;
    };
  }) {
    const member = input.actor.merchantMemberships[0];
    if (member === undefined) throw new AppError('NOT_FOUND', 'The merchant was not found.');
    membership(input.actor, member.merchantId, ['owner', 'admin']);
    const expected = Number(input.expectedVersion);
    if (Object.keys(input.patch).length === 0) {
      const [current] = await this.uow
        .current()
        .select({ id: merchants.id })
        .from(merchants)
        .where(and(eq(merchants.id, member.merchantId), eq(merchants.version, expected)))
        .limit(1);
      if (current === undefined) {
        throw new AppError(
          'IDEMPOTENCY_CONFLICT',
          'The merchant profile changed. Refresh and retry.',
        );
      }
      const merchant = await this.#merchants.findById(MerchantIdSchema.parse(current.id));
      if (merchant === undefined) throw new Error('Merchant was not found');
      return { merchant, version: expected.toString() };
    }
    const [updated] = await this.uow
      .current()
      .update(merchants)
      .set({
        ...(input.patch.slug === undefined ? {} : { slug: input.patch.slug }),
        ...(input.patch.displayName === undefined ? {} : { displayName: input.patch.displayName }),
        ...(input.patch.supportContact === undefined
          ? {}
          : { supportContact: input.patch.supportContact }),
        version: sql`${merchants.version} + 1`,
        updatedAt: this.now(),
      })
      .where(and(eq(merchants.id, member.merchantId), eq(merchants.version, expected)))
      .returning({ id: merchants.id });
    if (updated === undefined) {
      throw new AppError(
        'IDEMPOTENCY_CONFLICT',
        'The merchant profile changed. Refresh and retry.',
      );
    }
    const merchant = await this.#merchants.findById(MerchantIdSchema.parse(updated.id));
    if (merchant === undefined) throw new Error('Updated merchant was not found');
    return { merchant, version: (expected + 1).toString() };
  }

  async onboardMerchant(actor: CurrentUser) {
    const member = actor.merchantMemberships[0];
    if (member === undefined) throw new AppError('NOT_FOUND', 'The merchant was not found.');
    membership(actor, member.merchantId, ['owner', 'admin']);
    return this.uow.transaction(async () => {
      const [current] = await this.uow
        .current()
        .select({ status: merchants.status })
        .from(merchants)
        .where(eq(merchants.id, member.merchantId))
        .for('update')
        .limit(1);
      if (current === undefined) throw new AppError('NOT_FOUND', 'The merchant was not found.');
      if (current.status === 'active' || current.status === 'pending') {
        return { merchantId: member.merchantId, status: current.status };
      }
      if (current.status !== 'draft' && current.status !== 'paused') {
        throw new AppError(
          'VALIDATION_FAILED',
          'The merchant cannot be onboarded from this state.',
        );
      }
      const now = this.now();
      await this.uow
        .current()
        .update(merchants)
        .set({ status: 'pending', chainSyncStatus: 'pending', updatedAt: now })
        .where(eq(merchants.id, member.merchantId));
      await this.uow
        .current()
        .insert(outboxEvents)
        .values({
          eventKey: `merchant:${member.merchantId}:onboard`,
          eventType: 'merchant_onboarding_requested',
          aggregateType: 'merchant',
          aggregateId: member.merchantId,
          safePayload: { merchantId: member.merchantId },
          createdAt: now,
        })
        .onConflictDoNothing();
      return { merchantId: member.merchantId, status: 'pending' as const };
    });
  }

  async updateProduct(input: {
    actor: CurrentUser;
    productId: ReturnType<typeof ProductIdSchema.parse>;
    expectedVersion: string;
    patch: Readonly<Record<string, unknown>>;
  }) {
    const product = await this.#products.findById(input.productId);
    if (product === undefined) throw new AppError('NOT_FOUND', 'The product was not found.');
    membership(input.actor, product.merchantId, ['owner', 'admin', 'operator']);
    if (BigInt(product.sold) > 0n) {
      throw new AppError(
        'VALIDATION_FAILED',
        'A product revision is immutable after its first sale; archive it and create a new product.',
      );
    }
    const expected = Number(input.expectedVersion);
    if (product.version !== input.expectedVersion) {
      throw new AppError('IDEMPOTENCY_CONFLICT', 'The product changed. Refresh and retry.');
    }
    const next = ProductSchema.parse({
      ...product,
      ...input.patch,
      id: product.id,
      merchantId: product.merchantId,
      version: (expected + 1).toString(),
      sold: product.sold,
      status: product.status,
      updatedAt: this.now().toISOString(),
    });
    await this.#products.save(next);
    const saved = await this.#products.findById(input.productId);
    if (saved === undefined) throw new Error('Updated product was not found');
    return { product: saved };
  }

  async getProductForActor(
    actor: CurrentUser,
    productId: ReturnType<typeof ProductIdSchema.parse>,
  ) {
    const product = await this.#products.findById(productId);
    if (product === undefined) throw new AppError('NOT_FOUND', 'The product was not found.');
    membership(actor, product.merchantId, ['owner', 'admin', 'operator', 'viewer']);
    return product;
  }

  async prepareContractOperation(input: {
    actor: CurrentUser;
    kind: ContractOperationRecord['kind'];
    aggregateType: ContractOperationRecord['aggregateType'];
    aggregateId: string;
    binding: Readonly<Record<string, unknown>>;
    template: ContractOperationRecord['template'];
    requestId: string;
  }): Promise<ContractOperationRecord> {
    const template = BoundOperationTemplateSchema.parse(input.template);
    if (!sameEvmAddress(template.ownerAddress, input.actor.walletAddress)) {
      throw new AppError('WALLET_ADDRESS_MISMATCH', 'The operation owner must match your wallet.');
    }
    const expiresAt = new Date(template.expiresAt);
    if (expiresAt <= this.now()) {
      throw new AppError('UA_QUOTE_EXPIRED', 'The contract operation expired.', {
        retryable: true,
      });
    }
    return this.uow.transaction(async () => {
      const [created] = await this.uow
        .current()
        .insert(contractOperations)
        .values({
          id: opaqueId('cop'),
          kind: input.kind,
          aggregateType: input.aggregateType,
          aggregateId: input.aggregateId,
          actorUserId: input.actor.id,
          ownerAddress: input.actor.walletAddress,
          chainId: ARBITRUM_ONE_CHAIN_ID,
          binding: { ...input.binding },
          template: template as unknown as Record<string, unknown>,
          bindingDigest: template.bindingDigest,
          status: 'prepared',
          expiresAt,
          createdAt: this.now(),
          updatedAt: this.now(),
        })
        .onConflictDoNothing({ target: contractOperations.bindingDigest })
        .returning();
      const record =
        created ??
        (
          await this.uow
            .current()
            .select()
            .from(contractOperations)
            .where(eq(contractOperations.bindingDigest, template.bindingDigest))
            .limit(1)
        )[0];
      if (record === undefined || record.actorUserId !== input.actor.id) {
        throw new AppError('IDEMPOTENCY_CONFLICT', 'The operation binding is already in use.');
      }
      await this.uow
        .current()
        .insert(auditLogs)
        .values({
          actorType: 'user',
          actorId: input.actor.id,
          action: 'contract_operation_prepared',
          resourceType: input.aggregateType,
          resourceId: input.aggregateId,
          result: 'success',
          requestId: input.requestId,
          safeMetadata: { kind: input.kind, operationId: record.id },
          createdAt: this.now(),
        });
      return this.contractOperationRecord(record);
    });
  }

  async prepareManagedSplitRevocationOperation(input: {
    actor: CurrentUser;
    aggregateId: string;
    signerAddress: CurrentUser['walletAddress'];
    binding: Readonly<Record<string, unknown>>;
    template: ContractOperationRecord['template'];
    requestId: string;
  }): Promise<ContractOperationRecord> {
    const template = BoundOperationTemplateSchema.parse(input.template);
    const bindingSigner = EvmAddressSchema.safeParse(input.binding['signerAddress']);
    if (
      template.kind !== 'split_revocation' ||
      !sameEvmAddress(template.ownerAddress, input.signerAddress) ||
      !bindingSigner.success ||
      !sameEvmAddress(bindingSigner.data, input.signerAddress)
    ) {
      throw new AppError(
        'OPERATION_PLAN_INVALID',
        'The managed split revocation signer binding is invalid.',
      );
    }
    const expiresAt = new Date(template.expiresAt);
    if (expiresAt <= this.now()) {
      throw new AppError('UA_QUOTE_EXPIRED', 'The split revocation operation expired.');
    }
    return this.uow.transaction(async () => {
      const [payment] = await this.uow
        .current()
        .select({
          splitId: splitPayments.splitId,
        })
        .from(splitPayments)
        .where(eq(splitPayments.id, input.aggregateId))
        .limit(1);
      if (payment === undefined)
        throw new AppError('NOT_FOUND', 'The split payment was not found.');
      const [split] = await this.uow
        .current()
        .select({
          creatorUserId: splits.creatorUserId,
          status: splits.status,
        })
        .from(splits)
        .where(eq(splits.id, payment.splitId))
        .limit(1);
      if (
        split === undefined ||
        split.creatorUserId !== input.actor.id ||
        split.status !== 'revoking'
      ) {
        throw new AppError('AUTH_FORBIDDEN', 'The split is not authorized for managed revocation.');
      }
      const [created] = await this.uow
        .current()
        .insert(contractOperations)
        .values({
          id: opaqueId('cop'),
          kind: 'split_revocation',
          aggregateType: 'split_payment',
          aggregateId: input.aggregateId,
          actorUserId: input.actor.id,
          ownerAddress: input.signerAddress,
          chainId: ARBITRUM_ONE_CHAIN_ID,
          binding: { ...input.binding },
          template: template as unknown as Record<string, unknown>,
          bindingDigest: template.bindingDigest,
          status: 'prepared',
          expiresAt,
          createdAt: this.now(),
          updatedAt: this.now(),
        })
        .onConflictDoNothing({ target: contractOperations.bindingDigest })
        .returning();
      const record =
        created ??
        (
          await this.uow
            .current()
            .select()
            .from(contractOperations)
            .where(eq(contractOperations.bindingDigest, template.bindingDigest))
            .limit(1)
        )[0];
      if (
        record === undefined ||
        record.actorUserId !== input.actor.id ||
        record.kind !== 'split_revocation' ||
        record.aggregateId !== input.aggregateId
      ) {
        throw new AppError('IDEMPOTENCY_CONFLICT', 'The revocation binding is already in use.');
      }
      await this.uow
        .current()
        .insert(auditLogs)
        .values({
          actorType: 'user',
          actorId: input.actor.id,
          action: 'managed_split_revocation_prepared',
          resourceType: 'split_payment',
          resourceId: input.aggregateId,
          result: 'success',
          requestId: input.requestId,
          safeMetadata: { operationId: record.id },
          createdAt: this.now(),
        });
      return this.contractOperationRecord(record);
    });
  }

  async startManagedSplitRevocationSubmission(input: {
    actor: CurrentUser;
    operationId: string;
  }): Promise<ContractOperationRecord> {
    return this.uow.transaction(async () => {
      const [current] = await this.uow
        .current()
        .select()
        .from(contractOperations)
        .where(eq(contractOperations.id, input.operationId))
        .for('update')
        .limit(1);
      if (
        current === undefined ||
        current.actorUserId !== input.actor.id ||
        current.kind !== 'split_revocation'
      ) {
        throw new AppError('NOT_FOUND', 'The split revocation operation was not found.');
      }
      if (current.status !== 'prepared') return this.contractOperationRecord(current);
      if (current.expiresAt <= this.now()) {
        throw new AppError('UA_QUOTE_EXPIRED', 'The split revocation operation expired.');
      }
      const now = this.now();
      const [updated] = await this.uow
        .current()
        .update(contractOperations)
        .set({
          status: 'submission_started',
          submissionStartedAt: now,
          version: sql`${contractOperations.version} + 1`,
          updatedAt: now,
        })
        .where(
          and(eq(contractOperations.id, current.id), eq(contractOperations.status, 'prepared')),
        )
        .returning();
      if (updated === undefined) {
        throw new AppError(
          'PAYMENT_SUBMITTED_UNKNOWN',
          'Revocation submission is already in progress.',
          {
            retryable: true,
            submissionPossible: true,
          },
        );
      }
      return this.contractOperationRecord(updated);
    });
  }

  async recordManagedSplitRevocationSubmission(input: {
    actor: CurrentUser;
    operationId: string;
    status: 'submitted' | 'submitted_unknown';
    signerNonce: string;
    transactionHash?: string;
  }): Promise<ContractOperationRecord> {
    const signerNonce = UnsignedIntegerStringSchema.parse(input.signerNonce);
    const transactionHash =
      input.transactionHash === undefined
        ? undefined
        : TransactionHashSchema.parse(input.transactionHash);
    if (input.status === 'submitted' && transactionHash === undefined) {
      throw new AppError(
        'VALIDATION_FAILED',
        'A submitted revocation requires a transaction hash.',
      );
    }
    return this.uow.transaction(async () => {
      const [current] = await this.uow
        .current()
        .select()
        .from(contractOperations)
        .where(eq(contractOperations.id, input.operationId))
        .for('update')
        .limit(1);
      if (
        current === undefined ||
        current.actorUserId !== input.actor.id ||
        current.kind !== 'split_revocation'
      ) {
        throw new AppError('NOT_FOUND', 'The split revocation operation was not found.');
      }
      if (current.managedSignerNonce !== null && current.managedSignerNonce !== signerNonce) {
        throw new AppError('IDEMPOTENCY_CONFLICT', 'The managed signer nonce cannot change.');
      }
      if (
        current.status === input.status &&
        current.managedSignerNonce === signerNonce &&
        current.transactionHash === (transactionHash ?? null)
      ) {
        return this.contractOperationRecord(current);
      }
      if (current.status !== 'submission_started') {
        throw new AppError('PAYMENT_ALREADY_SUBMITTED', 'The revocation is already in progress.', {
          submissionPossible: true,
        });
      }
      const now = this.now();
      const [updated] = await this.uow
        .current()
        .update(contractOperations)
        .set({
          status: input.status,
          managedSignerNonce: signerNonce,
          ...(transactionHash === undefined ? {} : { transactionHash }),
          submittedAt: now,
          version: sql`${contractOperations.version} + 1`,
          updatedAt: now,
        })
        .where(eq(contractOperations.id, current.id))
        .returning();
      if (updated === undefined) throw new Error('Failed to persist split revocation submission');
      return this.contractOperationRecord(updated);
    });
  }

  async failManagedSplitRevocationSubmission(input: {
    actor: CurrentUser;
    operationId: string;
  }): Promise<ContractOperationRecord> {
    return this.uow.transaction(async () => {
      const [current] = await this.uow
        .current()
        .select()
        .from(contractOperations)
        .where(eq(contractOperations.id, input.operationId))
        .for('update')
        .limit(1);
      if (
        current === undefined ||
        current.actorUserId !== input.actor.id ||
        current.kind !== 'split_revocation'
      ) {
        throw new AppError('NOT_FOUND', 'The split revocation operation was not found.');
      }
      if (current.status === 'failed') return this.contractOperationRecord(current);
      if (!['prepared', 'submission_started'].includes(current.status)) {
        throw new AppError(
          'PAYMENT_ALREADY_SUBMITTED',
          'The revocation outcome requires reconciliation.',
          {
            submissionPossible: true,
          },
        );
      }
      const [updated] = await this.uow
        .current()
        .update(contractOperations)
        .set({
          status: 'failed',
          version: sql`${contractOperations.version} + 1`,
          updatedAt: this.now(),
        })
        .where(eq(contractOperations.id, current.id))
        .returning();
      if (updated === undefined) throw new Error('Failed to mark split revocation failed');
      return this.contractOperationRecord(updated);
    });
  }

  async registerContractOperationSubmission(input: {
    actor: CurrentUser;
    operationId: string;
    status: 'submission_started' | 'submitted' | 'submitted_unknown';
    providerOperationId: string;
  }): Promise<ContractOperationRecord> {
    const providerOperationId = ProviderOperationIdSchema.parse(input.providerOperationId);
    return this.uow.transaction(async () => {
      const [current] = await this.uow
        .current()
        .select()
        .from(contractOperations)
        .where(eq(contractOperations.id, input.operationId))
        .for('update')
        .limit(1);
      if (current === undefined || current.actorUserId !== input.actor.id) {
        throw new AppError('NOT_FOUND', 'The contract operation was not found.');
      }
      if (current.expiresAt <= this.now() && current.status === 'prepared') {
        throw new AppError('UA_QUOTE_EXPIRED', 'The contract operation expired.', {
          retryable: true,
        });
      }
      if (
        current.providerOperationId !== null &&
        current.providerOperationId !== providerOperationId
      ) {
        throw new AppError('IDEMPOTENCY_CONFLICT', 'The provider operation ID cannot change.');
      }
      if (current.status === input.status && current.providerOperationId === providerOperationId) {
        return this.contractOperationRecord(current);
      }
      const allowed =
        (input.status === 'submission_started' && current.status === 'prepared') ||
        (input.status === 'submitted_unknown' && current.status === 'submission_started') ||
        (input.status === 'submitted' &&
          ['submission_started', 'submitted_unknown'].includes(current.status));
      if (!allowed) {
        throw new AppError(
          'PAYMENT_ALREADY_SUBMITTED',
          'The contract operation is already in progress.',
          {
            submissionPossible: true,
          },
        );
      }
      const now = this.now();
      const [updated] = await this.uow
        .current()
        .update(contractOperations)
        .set({
          status: input.status,
          providerOperationId,
          ...(current.submissionStartedAt === null ? { submissionStartedAt: now } : {}),
          ...(input.status === 'submitted' ? { submittedAt: now } : {}),
          version: sql`${contractOperations.version} + 1`,
          updatedAt: now,
        })
        .where(eq(contractOperations.id, current.id))
        .returning();
      if (updated === undefined)
        throw new Error('Failed to register contract operation submission');
      const workflowStatus =
        input.status === 'submission_started' ? 'submission_started' : input.status;
      if (current.aggregateType === 'refund') {
        await this.uow
          .current()
          .update(refunds)
          .set({
            status: workflowStatus,
            providerOperationId,
            updatedAt: now,
          })
          .where(eq(refunds.id, current.aggregateId));
      } else if (current.aggregateType === 'withdrawal') {
        await this.uow
          .current()
          .update(withdrawals)
          .set({
            status: workflowStatus,
            providerOperationId,
            updatedAt: now,
          })
          .where(eq(withdrawals.id, current.aggregateId));
      } else if (current.aggregateType === 'split_payment') {
        const splitStatus: 'submission_started' | 'confirming' | 'submitted_unknown' =
          input.status === 'submitted' ? 'confirming' : input.status;
        const [payment] = await this.uow
          .current()
          .update(splitPayments)
          .set({
            status: splitStatus,
            providerOperationId,
            updatedAt: now,
          })
          .where(eq(splitPayments.id, current.aggregateId))
          .returning({
            invitationId: splitPayments.invitationId,
          });
        if (payment !== undefined) {
          await this.uow
            .current()
            .update(splitInvitations)
            .set({
              status: splitStatus,
              updatedAt: now,
            })
            .where(eq(splitInvitations.id, payment.invitationId));
        }
      } else if (current.aggregateType === 'merchant') {
        await this.uow
          .current()
          .update(merchants)
          .set({
            chainSyncStatus: input.status === 'submission_started' ? 'pending' : 'submitted',
            updatedAt: now,
          })
          .where(eq(merchants.id, current.aggregateId));
      } else if (current.aggregateType === 'product') {
        await this.uow
          .current()
          .update(products)
          .set({
            chainSyncStatus: input.status === 'submission_started' ? 'pending' : 'submitted',
            updatedAt: now,
          })
          .where(eq(products.id, current.aggregateId));
      }
      return this.contractOperationRecord(updated);
    });
  }

  async getContractOperation(operationId: string, actor: CurrentUser) {
    const [record] = await this.uow
      .current()
      .select()
      .from(contractOperations)
      .where(
        and(eq(contractOperations.id, operationId), eq(contractOperations.actorUserId, actor.id)),
      )
      .limit(1);
    return record === undefined ? undefined : this.contractOperationRecord(record);
  }

  private contractOperationRecord(
    record: typeof contractOperations.$inferSelect,
  ): ContractOperationRecord {
    return {
      id: record.id,
      kind: record.kind as ContractOperationRecord['kind'],
      aggregateType: record.aggregateType as ContractOperationRecord['aggregateType'],
      aggregateId: record.aggregateId,
      binding: record.binding,
      template: BoundOperationTemplateSchema.parse(record.template),
      bindingDigest: record.bindingDigest,
      status: record.status as ContractOperationRecord['status'],
      ...(record.providerOperationId === null
        ? {}
        : { providerOperationId: record.providerOperationId }),
      ...(record.transactionHash === null ? {} : { transactionHash: record.transactionHash }),
      ...(record.canonicalEventName === null
        ? {}
        : { canonicalEventName: record.canonicalEventName }),
      expiresAt: record.expiresAt.toISOString(),
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    };
  }

  async getMerchantChainContext(actor: CurrentUser, merchantId?: string) {
    const member =
      merchantId === undefined
        ? actor.merchantMemberships[0]
        : actor.merchantMemberships.find((entry) => entry.merchantId === merchantId);
    if (member === undefined)
      throw new AppError('AUTH_FORBIDDEN', 'You are not authorized to manage this merchant.');
    membership(actor, member.merchantId, ['owner']);
    const [record] = await this.uow
      .current()
      .select()
      .from(merchants)
      .where(eq(merchants.id, member.merchantId))
      .limit(1);
    if (record === undefined) throw new AppError('NOT_FOUND', 'The merchant was not found.');
    if (record.ownerUserId !== actor.id) {
      throw new AppError(
        'AUTH_FORBIDDEN',
        'Only the contract merchant owner can authorize this onchain operation.',
      );
    }
    return {
      merchantId: MerchantIdSchema.parse(record.id),
      ...(record.onchainMerchantId === null ? {} : { merchantOnchainId: record.onchainMerchantId }),
      payoutAddress: EvmAddressSchema.parse(record.payoutAddress),
      status: record.status,
      profile: record.profile,
    };
  }

  async getProductChainContext(
    actor: CurrentUser,
    productId: ReturnType<typeof ProductIdSchema.parse>,
  ) {
    const product = await this.getProductForActor(actor, productId);
    const merchant = await this.getMerchantChainContext(actor, product.merchantId);
    return { product, merchant };
  }

  async getRefundChainContext(actor: CurrentUser, refundId: string) {
    const [record] = await this.uow
      .current()
      .select({
        refund: refunds,
        orderKey: orders.orderKey,
        tokenAddress: orders.tokenAddress,
        productOnchainId: products.onchainProductId,
        merchantOnchainId: merchants.onchainMerchantId,
        merchantOwnerUserId: merchants.ownerUserId,
      })
      .from(refunds)
      .innerJoin(orders, eq(orders.id, refunds.orderId))
      .innerJoin(products, eq(products.id, orders.productId))
      .innerJoin(merchants, eq(merchants.id, orders.merchantId))
      .where(eq(refunds.id, refundId))
      .limit(1);
    if (record === undefined) throw new AppError('NOT_FOUND', 'The refund was not found.');
    membership(actor, record.refund.merchantId, ['owner']);
    if (record.merchantOwnerUserId !== actor.id) {
      throw new AppError(
        'AUTH_FORBIDDEN',
        'Only the contract merchant owner can authorize this refund.',
      );
    }
    if (record.productOnchainId === null || record.merchantOnchainId === null) {
      throw new AppError(
        'OPERATION_PLAN_INVALID',
        'The canonical merchant/product mapping is unavailable.',
      );
    }
    return {
      refund: this.refundRecord(record.refund),
      orderKey: record.orderKey,
      tokenAddress: EvmAddressSchema.parse(record.tokenAddress),
      productOnchainId: record.productOnchainId,
      merchantOnchainId: record.merchantOnchainId,
    };
  }

  async getWithdrawalChainContext(actor: CurrentUser, withdrawalId: string) {
    const [record] = await this.uow
      .current()
      .select({
        withdrawal: withdrawals,
        merchantOnchainId: merchants.onchainMerchantId,
        merchantOwnerUserId: merchants.ownerUserId,
      })
      .from(withdrawals)
      .innerJoin(merchants, eq(merchants.id, withdrawals.merchantId))
      .where(eq(withdrawals.id, withdrawalId))
      .limit(1);
    if (record === undefined) throw new AppError('NOT_FOUND', 'The withdrawal was not found.');
    membership(actor, record.withdrawal.merchantId, ['owner']);
    if (record.merchantOwnerUserId !== actor.id) {
      throw new AppError(
        'AUTH_FORBIDDEN',
        'Only the contract merchant owner can authorize this withdrawal.',
      );
    }
    if (record.merchantOnchainId === null) {
      throw new AppError(
        'OPERATION_PLAN_INVALID',
        'The canonical merchant mapping is unavailable.',
      );
    }
    return {
      withdrawal: this.withdrawalRecord(record.withdrawal),
      merchantOnchainId: record.merchantOnchainId,
    };
  }

  async changeProductStatus(input: {
    actor: CurrentUser;
    productId: ReturnType<typeof ProductIdSchema.parse>;
    status: 'publishing' | 'paused' | 'archived';
  }) {
    const product = await this.#products.findById(input.productId);
    if (product === undefined) throw new AppError('NOT_FOUND', 'The product was not found.');
    membership(input.actor, product.merchantId, ['owner', 'admin', 'operator']);
    const allowed =
      input.status === 'publishing'
        ? ['draft', 'paused', 'scheduled']
        : input.status === 'paused'
          ? ['publishing', 'scheduled', 'active']
          : ['draft', 'paused', 'ended', 'sold_out'];
    if (!allowed.includes(product.status)) {
      throw new AppError('VALIDATION_FAILED', 'The product cannot enter that state.');
    }
    const now = this.now();
    return this.uow.transaction(async () => {
      const [updated] = await this.uow
        .current()
        .update(products)
        .set({
          status: input.status,
          chainSyncStatus: input.status === 'archived' ? 'not_required' : 'pending',
          ...(input.status === 'archived' ? { archivedAt: now } : {}),
          updatedAt: now,
        })
        .where(eq(products.id, product.id))
        .returning({ id: products.id, status: products.status });
      if (updated === undefined) throw new Error('Failed to change product status');
      if (input.status !== 'archived') {
        await this.uow
          .current()
          .insert(outboxEvents)
          .values({
            eventKey: `product:${product.id}:${input.status}:${product.version}`,
            eventType: 'product_chain_sync_requested',
            aggregateType: 'product',
            aggregateId: product.id,
            safePayload: { productId: product.id, status: input.status },
            createdAt: now,
          })
          .onConflictDoNothing();
      }
      return updated;
    });
  }

  async createCheckoutLink(input: {
    actor: CurrentUser;
    productId: ReturnType<typeof ProductIdSchema.parse>;
    campaign?: string;
    expiresAt?: string;
  }) {
    const product = await this.#products.findById(input.productId);
    if (product === undefined) throw new AppError('NOT_FOUND', 'The product was not found.');
    membership(input.actor, product.merchantId, ['owner', 'admin', 'operator']);
    const reference = randomSecret(32);
    const expiresAt = input.expiresAt === undefined ? undefined : new Date(input.expiresAt);
    if (expiresAt !== undefined && expiresAt <= this.now()) {
      throw new AppError('VALIDATION_FAILED', 'Checkout link expiry must be in the future.');
    }
    const [created] = await this.uow
      .current()
      .insert(checkoutLinks)
      .values({
        productId: product.id,
        capabilityHash: capabilityHash(this.capabilityPepper, reference),
        ...(input.campaign === undefined ? {} : { campaign: input.campaign }),
        ...(expiresAt === undefined ? {} : { expiresAt }),
        createdByUserId: input.actor.id,
        createdAt: this.now(),
      })
      .returning({ id: checkoutLinks.id });
    if (created === undefined) throw new Error('Failed to create checkout link');
    return {
      id: created.id,
      reference,
      productId: product.id,
      ...(input.campaign === undefined ? {} : { campaign: input.campaign }),
      ...(expiresAt === undefined ? {} : { expiresAt: expiresAt.toISOString() }),
    };
  }

  async getCheckoutLink(reference: string) {
    if (!/^[A-Za-z0-9_-]{16,256}$/.test(reference)) return undefined;
    const [record] = await this.uow
      .current()
      .select()
      .from(checkoutLinks)
      .where(
        and(
          eq(checkoutLinks.capabilityHash, capabilityHash(this.capabilityPepper, reference)),
          isNull(checkoutLinks.revokedAt),
          sql`(${checkoutLinks.expiresAt} is null or ${checkoutLinks.expiresAt} > ${this.now()})`,
        ),
      )
      .limit(1);
    if (record === undefined) return undefined;
    return {
      id: record.id,
      productId: ProductIdSchema.parse(record.productId),
      ...(record.campaign === null ? {} : { campaign: record.campaign }),
      ...(record.expiresAt === null ? {} : { expiresAt: record.expiresAt.toISOString() }),
    };
  }

  async registerRefundSubmission(input: {
    actor: CurrentUser;
    refundId: string;
    status: 'submitted' | 'submitted_unknown';
    providerOperationId?: string;
  }) {
    return this.uow.transaction(async () => {
      const [current] = await this.uow
        .current()
        .select()
        .from(refunds)
        .where(eq(refunds.id, input.refundId))
        .for('update')
        .limit(1);
      if (current === undefined) throw new AppError('NOT_FOUND', 'The refund was not found.');
      membership(input.actor, current.merchantId, ['owner', 'admin', 'operator']);
      if (!['created', 'prepared', 'submission_started'].includes(current.status)) {
        if (
          current.status === input.status &&
          current.providerOperationId === (input.providerOperationId ?? null)
        ) {
          return this.refundRecord(current);
        }
        throw new AppError('PAYMENT_ALREADY_SUBMITTED', 'The refund was already submitted.', {
          submissionPossible: true,
        });
      }
      const [updated] = await this.uow
        .current()
        .update(refunds)
        .set({
          status: input.status,
          ...(input.providerOperationId === undefined
            ? {}
            : { providerOperationId: ProviderOperationIdSchema.parse(input.providerOperationId) }),
          updatedAt: this.now(),
        })
        .where(eq(refunds.id, current.id))
        .returning();
      if (updated === undefined) throw new Error('Failed to register refund submission');
      return this.refundRecord(updated);
    });
  }

  async getRefund(refundId: string, actor: CurrentUser) {
    const [record] = await this.uow
      .current()
      .select()
      .from(refunds)
      .where(eq(refunds.id, refundId))
      .limit(1);
    if (record === undefined) return undefined;
    membership(actor, record.merchantId, ['owner', 'admin', 'operator', 'viewer']);
    return this.refundRecord(record);
  }

  private refundRecord(record: typeof refunds.$inferSelect) {
    return {
      id: record.id,
      orderId: record.orderId,
      merchantId: record.merchantId,
      amountBaseUnits: record.amountBaseUnits,
      status: record.status,
      ...(record.providerOperationId === null
        ? {}
        : { providerOperationId: record.providerOperationId }),
      ...(record.transactionHash === null ? {} : { transactionHash: record.transactionHash }),
      ...(record.confirmedAt === null ? {} : { confirmedAt: record.confirmedAt.toISOString() }),
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    };
  }

  async registerWithdrawalSubmission(input: {
    actor: CurrentUser;
    withdrawalId: string;
    status: 'submitted' | 'submitted_unknown';
    providerOperationId?: string;
  }) {
    return this.uow.transaction(async () => {
      const [current] = await this.uow
        .current()
        .select()
        .from(withdrawals)
        .where(eq(withdrawals.id, input.withdrawalId))
        .for('update')
        .limit(1);
      if (current === undefined) throw new AppError('NOT_FOUND', 'The withdrawal was not found.');
      membership(input.actor, current.merchantId, ['owner', 'admin']);
      if (!['created', 'prepared', 'submission_started'].includes(current.status)) {
        throw new AppError('PAYMENT_ALREADY_SUBMITTED', 'The withdrawal was already submitted.', {
          submissionPossible: true,
        });
      }
      const [updated] = await this.uow
        .current()
        .update(withdrawals)
        .set({
          status: input.status,
          ...(input.providerOperationId === undefined
            ? {}
            : { providerOperationId: ProviderOperationIdSchema.parse(input.providerOperationId) }),
          updatedAt: this.now(),
        })
        .where(eq(withdrawals.id, current.id))
        .returning();
      if (updated === undefined) throw new Error('Failed to register withdrawal submission');
      return this.withdrawalRecord(updated);
    });
  }

  async getWithdrawal(withdrawalId: string, actor: CurrentUser) {
    const [record] = await this.uow
      .current()
      .select()
      .from(withdrawals)
      .where(eq(withdrawals.id, withdrawalId))
      .limit(1);
    if (record === undefined) return undefined;
    membership(actor, record.merchantId, ['owner', 'admin', 'operator', 'viewer']);
    return this.withdrawalRecord(record);
  }

  private withdrawalRecord(record: typeof withdrawals.$inferSelect) {
    return {
      id: record.id,
      merchantId: record.merchantId,
      recipient: record.recipient,
      amountBaseUnits: record.amountBaseUnits,
      status: record.status,
      ...(record.providerOperationId === null
        ? {}
        : { providerOperationId: record.providerOperationId }),
      ...(record.transactionHash === null ? {} : { transactionHash: record.transactionHash }),
      ...(record.confirmedAt === null ? {} : { confirmedAt: record.confirmedAt.toISOString() }),
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    };
  }

  async getSettlement(actor: CurrentUser) {
    const member = actor.merchantMemberships[0];
    if (member === undefined) throw new AppError('NOT_FOUND', 'The merchant was not found.');
    membership(actor, member.merchantId, ['owner', 'admin', 'operator', 'viewer']);
    const [summary] = await this.uow
      .current()
      .select({
        gross: sql<string>`coalesce(sum(${settlementCredits.amountBaseUnits}), 0)::text`,
        withdrawn: sql<string>`coalesce(sum(${settlementCredits.withdrawnBaseUnits}), 0)::text`,
        available: sql<string>`coalesce(sum(case when ${settlementCredits.status} = 'matured' then ${settlementCredits.amountBaseUnits} - ${settlementCredits.withdrawnBaseUnits} else 0 end), 0)::text`,
      })
      .from(settlementCredits)
      .where(eq(settlementCredits.merchantId, member.merchantId));
    const [pendingWithdrawal] = await this.uow
      .current()
      .select()
      .from(withdrawals)
      .where(
        and(
          eq(withdrawals.merchantId, member.merchantId),
          inArray(withdrawals.status, [
            'created',
            'prepared',
            'submission_started',
            'submitted',
            'submitted_unknown',
            'confirming',
          ]),
        ),
      )
      .orderBy(sql`${withdrawals.createdAt} desc`)
      .limit(1);
    const [withdrawalOperation] =
      pendingWithdrawal === undefined
        ? [undefined]
        : await this.uow
            .current()
            .select()
            .from(contractOperations)
            .where(
              and(
                eq(contractOperations.aggregateType, 'withdrawal'),
                eq(contractOperations.aggregateId, pendingWithdrawal.id),
                eq(contractOperations.actorUserId, actor.id),
              ),
            )
            .orderBy(sql`${contractOperations.createdAt} desc`)
            .limit(1);
    return {
      merchantId: member.merchantId,
      grossBaseUnits: summary?.gross ?? '0',
      withdrawnBaseUnits: summary?.withdrawn ?? '0',
      availableBaseUnits: summary?.available ?? '0',
      observedAt: this.now().toISOString(),
      ...(pendingWithdrawal === undefined
        ? {}
        : { pendingWithdrawal: this.withdrawalRecord(pendingWithdrawal) }),
      ...(withdrawalOperation === undefined
        ? {}
        : { withdrawalOperation: this.contractOperationRecord(withdrawalOperation) }),
    };
  }

  async updateLoyalty(input: {
    actor: CurrentUser;
    merchantId: ReturnType<typeof MerchantIdSchema.parse>;
    name: string;
    thresholdPoints: string;
    enabled: boolean;
  }) {
    membership(input.actor, input.merchantId, ['owner', 'admin']);
    const [program] = await this.uow
      .current()
      .insert(loyaltyPrograms)
      .values({
        merchantId: input.merchantId,
        name: input.name,
        pointsPerBaseUnitNumerator: '0',
        pointsPerBaseUnitDenominator: '1',
        rewardThresholdPoints: input.thresholdPoints,
        active: input.enabled,
        updatedAt: this.now(),
      })
      .onConflictDoUpdate({
        target: loyaltyPrograms.merchantId,
        set: {
          name: input.name,
          pointsPerBaseUnitNumerator: '0',
          pointsPerBaseUnitDenominator: '1',
          rewardThresholdPoints: input.thresholdPoints,
          active: input.enabled,
          version: sql`${loyaltyPrograms.version} + 1`,
          updatedAt: this.now(),
        },
      })
      .returning();
    if (program === undefined) throw new Error('Failed to update loyalty program');
    return this.loyaltyProgramRecord(program);
  }

  async getLoyaltyStatus(actor: CurrentUser) {
    const memberships = actor.merchantMemberships.map((entry) => entry.merchantId);
    const programs =
      memberships.length === 0
        ? []
        : await this.uow
            .current()
            .select()
            .from(loyaltyPrograms)
            .where(inArray(loyaltyPrograms.merchantId, memberships));
    const balances = await this.uow
      .current()
      .select({
        programId: loyaltyBalances.programId,
        points: loyaltyBalances.points,
      })
      .from(loyaltyBalances)
      .where(eq(loyaltyBalances.userId, actor.id));
    return {
      programs: programs.map((record) => this.loyaltyProgramRecord(record)),
      balances,
      observedAt: this.now().toISOString(),
    };
  }

  private loyaltyProgramRecord(record: typeof loyaltyPrograms.$inferSelect) {
    return {
      id: record.id,
      merchantId: record.merchantId,
      name: record.name,
      thresholdPoints: record.rewardThresholdPoints,
      enabled: record.active,
      version: record.version.toString(),
      updatedAt: record.updatedAt.toISOString(),
    };
  }

  async inviteSplitParticipants(input: {
    actor: CurrentUser;
    splitId: ReturnType<typeof SplitIdSchema.parse>;
    participants: readonly { label: string; amountBaseUnits: string }[];
  }) {
    return this.uow.transaction(async () => {
      const [split] = await this.uow
        .current()
        .select()
        .from(splits)
        .where(eq(splits.id, input.splitId))
        .for('update')
        .limit(1);
      if (split === undefined || split.creatorUserId !== input.actor.id) {
        throw new AppError('NOT_FOUND', 'The split was not found.');
      }
      if (split.status !== 'active' || split.expiresAt <= this.now()) {
        throw new AppError('SPLIT_EXPIRED', 'The split is not accepting invitations.');
      }
      const [allocated] = await this.uow
        .current()
        .select({
          amount: sql<string>`coalesce(sum(${splitParticipants.amountBaseUnits}), 0)::text`,
        })
        .from(splitParticipants)
        .where(eq(splitParticipants.splitId, split.id));
      const additional = input.participants.reduce(
        (sum, participant) => sum + BigInt(participant.amountBaseUnits),
        0n,
      );
      if (BigInt(allocated?.amount ?? '0') + additional > BigInt(split.totalBaseUnits)) {
        throw new AppError('VALIDATION_FAILED', 'Split invitations exceed the immutable total.');
      }
      const invitations = [];
      for (const participant of input.participants) {
        const invitationId = SplitInvitationIdSchema.parse(opaqueId('spi'));
        const capabilityToken = randomSecret(32);
        const [created] = await this.uow
          .current()
          .insert(splitParticipants)
          .values({
            splitId: split.id,
            label: participant.label,
            amountBaseUnits: participant.amountBaseUnits,
          })
          .returning({ id: splitParticipants.id });
        if (created === undefined) throw new Error('Failed to create split participant');
        await this.uow
          .current()
          .insert(splitInvitations)
          .values({
            id: invitationId,
            splitId: split.id,
            participantId: created.id,
            capabilityHash: hashSplitInvitationCapability({
              invitationId,
              pepper: this.capabilityPepper,
              capabilityToken,
            }),
            expiresAt: split.expiresAt,
          });
        invitations.push({
          invitationId,
          participantLabel: participant.label,
          amountBaseUnits: participant.amountBaseUnits,
          capabilityReference: `${invitationId}.${capabilityToken}`,
          expiresAt: split.expiresAt.toISOString(),
        });
      }
      return { splitId: split.id, invitations };
    });
  }

  async prepareSplitRevocation(input: {
    actor: CurrentUser;
    splitId: string;
    reason: string;
    requestId: string;
  }) {
    return this.uow.transaction(async () => {
      const [split] = await this.uow
        .current()
        .select()
        .from(splits)
        .where(eq(splits.id, input.splitId))
        .for('update')
        .limit(1);
      if (split === undefined || split.creatorUserId !== input.actor.id) {
        throw new AppError('NOT_FOUND', 'The split was not found.');
      }
      if (split.status === 'revoked') {
        return {
          splitId: split.id,
          status: 'revoked' as const,
          reason: input.reason,
          paymentRevocations: [],
        };
      }
      if (split.confirmedBaseUnits !== '0' || split.status === 'complete') {
        throw new AppError(
          'VALIDATION_FAILED',
          'A split with confirmed payments cannot be revoked.',
        );
      }
      const issuedPayments = await this.uow
        .current()
        .select()
        .from(splitPayments)
        .where(
          and(
            eq(splitPayments.splitId, split.id),
            inArray(splitPayments.status, [
              'unpaid',
              'submission_started',
              'submitted_unknown',
              'confirming',
              'failed',
              'orphaned',
              'revoked',
            ]),
          ),
        );
      const now = this.now();
      if (issuedPayments.length > 0) {
        const paymentIds = issuedPayments.map((payment) => payment.id);
        const existingOperations = await this.uow
          .current()
          .select()
          .from(contractOperations)
          .where(
            and(
              eq(contractOperations.actorUserId, input.actor.id),
              eq(contractOperations.kind, 'split_revocation'),
              eq(contractOperations.aggregateType, 'split_payment'),
              inArray(contractOperations.aggregateId, paymentIds),
              inArray(contractOperations.status, [
                'prepared',
                'submission_started',
                'submitted',
                'submitted_unknown',
                'confirming',
                'confirmed',
                'orphaned',
              ]),
            ),
          )
          .orderBy(desc(contractOperations.createdAt));
        const latestByPayment = new Map<string, (typeof existingOperations)[number]>();
        for (const operation of existingOperations) {
          if (!latestByPayment.has(operation.aggregateId)) {
            latestByPayment.set(operation.aggregateId, operation);
          }
        }
        await this.uow
          .current()
          .update(splits)
          .set({
            status: 'revoking',
            updatedAt: now,
            version: sql`${splits.version} + 1`,
          })
          .where(eq(splits.id, split.id));
        await this.uow
          .current()
          .insert(auditLogs)
          .values({
            actorType: 'user',
            actorId: input.actor.id,
            action: 'split_revocation_requested',
            resourceType: 'split',
            resourceId: split.id,
            result: 'success',
            requestId: input.requestId,
            safeMetadata: { issuedPaymentCount: issuedPayments.length.toString() },
            createdAt: now,
          });
        return {
          splitId: split.id,
          status: 'revoking' as const,
          reason: input.reason,
          paymentRevocations: issuedPayments.map((payment) => {
            if (payment.splitDigest === null) {
              throw new AppError(
                'OPERATION_PLAN_INVALID',
                'The issued split payment is missing its immutable digest.',
              );
            }
            const operation = latestByPayment.get(payment.id);
            return {
              paymentId: payment.id,
              invitationId: SplitInvitationIdSchema.parse(payment.invitationId),
              paymentKey: EvidenceDigestSchema.parse(payment.paymentKey),
              splitDigest: EvidenceDigestSchema.parse(payment.splitDigest),
              ...(operation === undefined
                ? {}
                : { existingOperation: this.contractOperationRecord(operation) }),
            };
          }),
        };
      }
      await this.uow
        .current()
        .update(splits)
        .set({
          status: 'revoked',
          revokedAt: now,
          updatedAt: now,
        })
        .where(eq(splits.id, split.id));
      await this.uow
        .current()
        .update(splitInvitations)
        .set({
          status: 'revoked',
          revokedAt: now,
          updatedAt: now,
        })
        .where(and(eq(splitInvitations.splitId, split.id), eq(splitInvitations.status, 'unpaid')));
      await this.uow.current().insert(auditLogs).values({
        actorType: 'user',
        actorId: input.actor.id,
        action: 'split_revoked_without_issued_keys',
        resourceType: 'split',
        resourceId: split.id,
        result: 'success',
        requestId: input.requestId,
        safeMetadata: {},
        createdAt: now,
      });
      return {
        splitId: split.id,
        status: 'revoked' as const,
        reason: input.reason,
        paymentRevocations: [],
      };
    });
  }

  async prepareSplitPayment(input: {
    actor: CurrentUser;
    splitId: string;
    invitationId: string;
    capabilityReference: string;
    amountBaseUnits: string;
  }) {
    return this.uow.transaction(async () => {
      const separator = input.capabilityReference.indexOf('.');
      if (
        separator < 1 ||
        separator !== input.capabilityReference.lastIndexOf('.') ||
        input.capabilityReference.slice(0, separator) !== input.invitationId
      ) {
        throw new AppError('NOT_FOUND', 'The split invitation was not found.');
      }
      const capabilityToken = input.capabilityReference.slice(separator + 1);
      const capabilityDigest = hashSplitInvitationCapability({
        invitationId: input.invitationId,
        pepper: this.capabilityPepper,
        capabilityToken,
      });
      const [record] = await this.uow
        .current()
        .select({
          invitation: splitInvitations,
          participant: splitParticipants,
          split: splits,
          order: orders,
        })
        .from(splitInvitations)
        .innerJoin(splitParticipants, eq(splitParticipants.id, splitInvitations.participantId))
        .innerJoin(splits, eq(splits.id, splitInvitations.splitId))
        .innerJoin(orders, eq(orders.id, splits.orderId))
        .where(
          and(
            eq(splitInvitations.id, input.invitationId),
            eq(splitInvitations.capabilityHash, capabilityDigest),
            eq(splits.id, input.splitId),
          ),
        )
        .for('update')
        .limit(1);
      if (record === undefined)
        throw new AppError('NOT_FOUND', 'The split invitation was not found.');
      if (
        record.invitation.status !== 'unpaid' ||
        record.invitation.revokedAt !== null ||
        record.invitation.expiresAt <= this.now() ||
        record.split.status !== 'active'
      ) {
        throw new AppError('SPLIT_EXPIRED', 'The split invitation is no longer payable.');
      }
      if (
        record.participant.amountBaseUnits !== input.amountBaseUnits ||
        record.participant.confirmedBaseUnits !== '0'
      ) {
        throw new AppError(
          'VALIDATION_FAILED',
          'The split payment amount must match the invitation.',
        );
      }
      if (
        record.participant.participantUserId !== null &&
        record.participant.participantUserId !== input.actor.id
      ) {
        throw new AppError('NOT_FOUND', 'The split invitation was not found.');
      }
      if (
        BigInt(record.split.confirmedBaseUnits) + BigInt(input.amountBaseUnits) >
        BigInt(record.split.totalBaseUnits)
      ) {
        throw new AppError('VALIDATION_FAILED', 'The split payment exceeds the immutable total.');
      }
      const [existing] = await this.uow
        .current()
        .select({ id: splitPayments.id })
        .from(splitPayments)
        .where(eq(splitPayments.invitationId, record.invitation.id))
        .limit(1);
      if (existing !== undefined) {
        throw new AppError('PAYMENT_ALREADY_SUBMITTED', 'A payment attempt already exists.', {
          submissionPossible: true,
        });
      }
      const paymentKey = EvidenceDigestSchema.parse(this.paymentKey());
      const splitDigest = EvidenceDigestSchema.parse(
        `0x${hashOpaqueSecret({ domain: 'split-payment', pepper: this.capabilityPepper, value: `${record.split.id}:${record.split.totalBaseUnits}:${record.order.orderKey}` })}`,
      );
      const [payment] = await this.uow
        .current()
        .insert(splitPayments)
        .values({
          splitId: record.split.id,
          invitationId: record.invitation.id,
          payerUserId: input.actor.id,
          paymentKey,
          splitDigest,
          originalOrderKey: record.order.orderKey,
          tokenAddress: record.order.tokenAddress,
          amountBaseUnits: input.amountBaseUnits,
          status: 'unpaid',
        })
        .returning();
      if (payment === undefined) throw new Error('Failed to create split payment');
      const now = this.now();
      await this.uow
        .current()
        .update(splitParticipants)
        .set({
          participantUserId: input.actor.id,
          updatedAt: now,
        })
        .where(eq(splitParticipants.id, record.participant.id));
      return {
        payment: this.splitPaymentRecord(payment),
        binding: {
          paymentKey,
          splitDigest,
          originalOrderKey: record.order.orderKey,
          beneficiary: record.split.beneficiary,
          token: record.order.tokenAddress,
          amountBaseUnits: input.amountBaseUnits,
          invitationId: record.invitation.id,
          expiresAt: record.invitation.expiresAt.toISOString(),
        },
      };
    });
  }

  async registerSplitPaymentSubmission(input: {
    actor: CurrentUser;
    splitPaymentAttemptId: string;
    status: 'submitted' | 'submitted_unknown';
    providerOperationId?: string;
  }) {
    return this.uow.transaction(async () => {
      const [current] = await this.uow
        .current()
        .select()
        .from(splitPayments)
        .where(eq(splitPayments.id, input.splitPaymentAttemptId))
        .for('update')
        .limit(1);
      if (current === undefined || current.payerUserId !== input.actor.id) {
        throw new AppError('NOT_FOUND', 'The split payment was not found.');
      }
      if (current.status !== 'unpaid' && current.status !== 'submission_started') {
        throw new AppError(
          'PAYMENT_ALREADY_SUBMITTED',
          'The split payment was already submitted.',
          {
            submissionPossible: true,
          },
        );
      }
      const [updated] = await this.uow
        .current()
        .update(splitPayments)
        .set({
          status: input.status === 'submitted' ? 'confirming' : 'submitted_unknown',
          ...(input.providerOperationId === undefined
            ? {}
            : { providerOperationId: ProviderOperationIdSchema.parse(input.providerOperationId) }),
          updatedAt: this.now(),
        })
        .where(eq(splitPayments.id, current.id))
        .returning();
      if (updated === undefined) throw new Error('Failed to register split payment');
      return this.splitPaymentRecord(updated);
    });
  }

  async recordSplitIntent(input: {
    actor: CurrentUser;
    splitPaymentId: string;
    intentDigest: string;
  }): Promise<void> {
    const intentDigest = EvidenceDigestSchema.parse(input.intentDigest);
    const [updated] = await this.uow
      .current()
      .update(splitPayments)
      .set({
        intentDigest,
        updatedAt: this.now(),
      })
      .where(
        and(
          eq(splitPayments.id, input.splitPaymentId),
          eq(splitPayments.payerUserId, input.actor.id),
          isNull(splitPayments.intentDigest),
        ),
      )
      .returning({ id: splitPayments.id });
    if (updated === undefined) {
      const [existing] = await this.uow
        .current()
        .select({
          payerUserId: splitPayments.payerUserId,
          intentDigest: splitPayments.intentDigest,
        })
        .from(splitPayments)
        .where(eq(splitPayments.id, input.splitPaymentId))
        .limit(1);
      if (
        existing === undefined ||
        existing.payerUserId !== input.actor.id ||
        existing.intentDigest !== intentDigest
      ) {
        throw new AppError('IDEMPOTENCY_CONFLICT', 'The split intent cannot be replaced.');
      }
    }
  }

  async getSplitPayment(id: string, actor: CurrentUser) {
    const [record] = await this.uow
      .current()
      .select()
      .from(splitPayments)
      .where(eq(splitPayments.id, id))
      .limit(1);
    if (record === undefined || record.payerUserId !== actor.id) return undefined;
    return this.splitPaymentRecord(record);
  }

  private splitPaymentRecord(record: typeof splitPayments.$inferSelect) {
    return {
      id: record.id,
      splitId: record.splitId,
      invitationId: record.invitationId,
      amountBaseUnits: record.amountBaseUnits,
      status: record.status,
      ...(record.providerOperationId === null
        ? {}
        : { providerOperationId: record.providerOperationId }),
      ...(record.transactionHash === null ? {} : { transactionHash: record.transactionHash }),
      ...(record.confirmedAt === null ? {} : { confirmedAt: record.confirmedAt.toISOString() }),
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    };
  }
}
