import type {
  CheckoutRepositoryPort,
  JudgeEvidenceRepositoryPort,
  MerchantRepositoryPort,
  ProductRepositoryPort,
  SplitRepositoryPort,
  UserRepositoryPort,
} from '@opentab/application';
import {
  AppError,
  acceptanceTimingPhaseMs,
  type CheckoutSessionId,
  CurrentUserSchema,
  EvmAddressSchema,
  type Merchant,
  type MerchantId,
  MerchantSchema,
  type OrderId,
  type OrderKey,
  type PaymentAttemptId,
  type PaymentAttemptStatus,
  type Product,
  type ProductId,
  ProductSchema,
  type ProviderOperationId,
  type PublicJudgeProof,
  PublicJudgeProofSchema,
  type Split,
  type SplitId,
  SplitSchema,
  sameEvmAddress,
  sumAcceptanceTimingMs,
} from '@opentab/shared';
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  sql,
} from 'drizzle-orm';
import { hashOpaqueSecret, safeHashEquals } from './crypto.js';
import {
  createLiveAcceptancePayloadDigest,
  verifyLiveAcceptanceAttestation,
} from './live-acceptance-evidence.js';
import {
  bootstrapGrants,
  canonicalLogs,
  checkoutSessions,
  delegationRecords,
  judgeEvidence,
  liveAcceptanceEvidence,
  merchantMembers,
  merchants,
  orders,
  paymentAttempts,
  products,
  providerOperations,
  receipts,
  serverSessions,
  splitInvitations,
  splitParticipants,
  splits,
  userIdentities,
  users,
  walletAccounts,
} from './schema/index.js';
import type { PostgresUnitOfWork } from './unit-of-work.js';

function dateTime(value: Date): string {
  return value.toISOString();
}

export class DrizzleUserRepository implements UserRepositoryPort {
  constructor(private readonly uow: PostgresUnitOfWork) {}

  async findCurrentUserById(id: string) {
    const [record] = await this.uow
      .current()
      .select({
        id: users.id,
        walletAddress: users.walletAddressChecksum,
        status: users.status,
        authMethod: userIdentities.authMethod,
      })
      .from(users)
      .leftJoin(userIdentities, eq(userIdentities.userId, users.id))
      .where(eq(users.id, id))
      .orderBy(asc(userIdentities.createdAt))
      .limit(1);
    if (record === undefined || record.authMethod === null) return undefined;

    const memberships = await this.uow
      .current()
      .select({ merchantId: merchantMembers.merchantId, role: merchantMembers.role })
      .from(merchantMembers)
      .where(and(eq(merchantMembers.userId, id), isNull(merchantMembers.revokedAt)));

    return CurrentUserSchema.parse({ ...record, merchantMemberships: memberships });
  }
}

export class DrizzleMerchantRepository implements MerchantRepositoryPort {
  constructor(private readonly uow: PostgresUnitOfWork) {}

  async findById(id: MerchantId): Promise<Merchant | undefined> {
    const [record] = await this.uow
      .current()
      .select()
      .from(merchants)
      .where(eq(merchants.id, id))
      .limit(1);
    return record === undefined
      ? undefined
      : MerchantSchema.parse({
          id: record.id,
          ownerUserId: record.ownerUserId,
          slug: record.slug,
          displayName: record.displayName,
          ...(record.supportContact === null ? {} : { supportContact: record.supportContact }),
          payoutAddress: record.payoutAddress,
          status: record.status,
          createdAt: dateTime(record.createdAt),
          updatedAt: dateTime(record.updatedAt),
        });
  }

  async save(merchant: Merchant): Promise<void> {
    await this.uow.transaction(async () => {
      await this.uow
        .current()
        .insert(merchants)
        .values({
          id: merchant.id,
          ownerUserId: merchant.ownerUserId,
          slug: merchant.slug,
          displayName: merchant.displayName,
          ...(merchant.supportContact === undefined
            ? {}
            : { supportContact: merchant.supportContact }),
          payoutAddress: merchant.payoutAddress,
          payoutAddressLower: merchant.payoutAddress.toLowerCase(),
          status: merchant.status,
          createdAt: new Date(merchant.createdAt),
          updatedAt: new Date(merchant.updatedAt),
        })
        .onConflictDoUpdate({
          target: merchants.id,
          set: {
            slug: merchant.slug,
            displayName: merchant.displayName,
            supportContact: merchant.supportContact ?? null,
            payoutAddress: merchant.payoutAddress,
            payoutAddressLower: merchant.payoutAddress.toLowerCase(),
            status: merchant.status,
            updatedAt: new Date(merchant.updatedAt),
            version: sql`${merchants.version} + 1`,
          },
        });
      await this.uow
        .current()
        .insert(merchantMembers)
        .values({ merchantId: merchant.id, userId: merchant.ownerUserId, role: 'owner' })
        .onConflictDoNothing();
    });
  }
}

export class DrizzleProductRepository implements ProductRepositoryPort {
  constructor(private readonly uow: PostgresUnitOfWork) {}

  async findById(id: ProductId): Promise<Product | undefined> {
    const [record] = await this.uow
      .current()
      .select()
      .from(products)
      .where(eq(products.id, id))
      .limit(1);
    return record === undefined
      ? undefined
      : ProductSchema.parse({
          id: record.id,
          merchantId: record.merchantId,
          ...(record.onchainProductId === null
            ? {}
            : { onchainProductId: record.onchainProductId }),
          version: record.version.toString(),
          slug: record.slug,
          title: record.title,
          description: record.description,
          ...(record.imageUrl === null ? {} : { imageUrl: record.imageUrl }),
          unitPriceBaseUnits: record.unitPriceBaseUnits,
          ...(record.maxSupply === null ? {} : { maxSupply: record.maxSupply }),
          sold: record.sold,
          maxPerOrder: record.maxPerOrder,
          startsAt: dateTime(record.startsAt),
          ...(record.endsAt === null ? {} : { endsAt: dateTime(record.endsAt) }),
          refundWindowSeconds: record.refundWindowSeconds,
          loyaltyPoints: record.loyaltyPoints,
          metadataHash: record.metadataHash,
          status: record.status,
          createdAt: dateTime(record.createdAt),
          updatedAt: dateTime(record.updatedAt),
        });
  }

  async save(product: Product): Promise<void> {
    await this.uow
      .current()
      .insert(products)
      .values({
        id: product.id,
        merchantId: product.merchantId,
        ...(product.onchainProductId === undefined
          ? {}
          : { onchainProductId: product.onchainProductId }),
        version: Number(product.version),
        slug: product.slug,
        title: product.title,
        description: product.description,
        ...(product.imageUrl === undefined ? {} : { imageUrl: product.imageUrl }),
        unitPriceBaseUnits: product.unitPriceBaseUnits,
        ...(product.maxSupply === undefined ? {} : { maxSupply: product.maxSupply }),
        sold: product.sold,
        maxPerOrder: product.maxPerOrder,
        startsAt: new Date(product.startsAt),
        ...(product.endsAt === undefined ? {} : { endsAt: new Date(product.endsAt) }),
        refundWindowSeconds: product.refundWindowSeconds,
        loyaltyPoints: product.loyaltyPoints,
        metadataHash: product.metadataHash,
        status: product.status,
        createdAt: new Date(product.createdAt),
        updatedAt: new Date(product.updatedAt),
      })
      .onConflictDoUpdate({
        target: products.id,
        set: {
          onchainProductId: product.onchainProductId ?? null,
          version: Number(product.version),
          slug: product.slug,
          title: product.title,
          description: product.description,
          imageUrl: product.imageUrl ?? null,
          unitPriceBaseUnits: product.unitPriceBaseUnits,
          maxSupply: product.maxSupply ?? null,
          sold: product.sold,
          maxPerOrder: product.maxPerOrder,
          startsAt: new Date(product.startsAt),
          endsAt: product.endsAt === undefined ? null : new Date(product.endsAt),
          refundWindowSeconds: product.refundWindowSeconds,
          loyaltyPoints: product.loyaltyPoints,
          metadataHash: product.metadataHash,
          status: product.status,
          updatedAt: new Date(product.updatedAt),
        },
      });
  }
}

export class DrizzleCheckoutRepository implements CheckoutRepositoryPort {
  constructor(private readonly uow: PostgresUnitOfWork) {}

  async findSession(id: CheckoutSessionId): Promise<unknown | undefined> {
    const [record] = await this.uow
      .current()
      .select()
      .from(checkoutSessions)
      .where(eq(checkoutSessions.id, id))
      .limit(1);
    return record;
  }

  async findOrderById(id: OrderId): Promise<unknown | undefined> {
    const [record] = await this.uow
      .current()
      .select()
      .from(orders)
      .where(eq(orders.id, id))
      .limit(1);
    return record;
  }

  async findOrderByKey(key: OrderKey): Promise<unknown | undefined> {
    const [record] = await this.uow
      .current()
      .select()
      .from(orders)
      .where(eq(orders.orderKey, key))
      .limit(1);
    return record;
  }

  async transitionAttempt(input: {
    attemptId: PaymentAttemptId;
    expected: readonly PaymentAttemptStatus[];
    next: PaymentAttemptStatus;
    providerOperationId?: ProviderOperationId;
  }): Promise<boolean> {
    const [changed] = await this.uow
      .current()
      .update(paymentAttempts)
      .set({
        status: input.next,
        ...(input.providerOperationId === undefined
          ? {}
          : { providerOperationId: input.providerOperationId }),
        ...(input.next === 'submission_started' ? { submissionStartedAt: new Date() } : {}),
        ...(input.next === 'submitted' ? { submittedAt: new Date() } : {}),
        reconciliationRequired: [
          'submitted',
          'submitted_unknown',
          'executing',
          'confirming',
        ].includes(input.next),
        updatedAt: new Date(),
        version: sql`${paymentAttempts.version} + 1`,
      })
      .where(
        and(
          eq(paymentAttempts.id, input.attemptId),
          inArray(paymentAttempts.status, [...input.expected]),
        ),
      )
      .returning({ id: paymentAttempts.id });
    return changed !== undefined;
  }
}

export class DrizzleSplitRepository implements SplitRepositoryPort {
  constructor(private readonly uow: PostgresUnitOfWork) {}

  async findById(id: SplitId): Promise<Split | undefined> {
    const [record] = await this.uow
      .current()
      .select()
      .from(splits)
      .where(eq(splits.id, id))
      .limit(1);
    if (record === undefined) return undefined;

    const invitations = await this.uow
      .current()
      .select({
        id: splitInvitations.id,
        participantLabel: splitParticipants.label,
        amountBaseUnits: splitParticipants.amountBaseUnits,
        status: splitInvitations.status,
        expiresAt: splitInvitations.expiresAt,
      })
      .from(splitInvitations)
      .innerJoin(splitParticipants, eq(splitParticipants.id, splitInvitations.participantId))
      .where(eq(splitInvitations.splitId, id))
      .orderBy(asc(splitInvitations.createdAt));

    return SplitSchema.parse({
      id: record.id,
      orderId: record.orderId,
      creatorUserId: record.creatorUserId,
      beneficiary: record.beneficiary,
      totalBaseUnits: record.totalBaseUnits,
      confirmedBaseUnits: record.confirmedBaseUnits,
      status: record.status,
      invitations: invitations.map((invitation) => ({
        ...invitation,
        expiresAt: dateTime(invitation.expiresAt),
      })),
      expiresAt: dateTime(record.expiresAt),
    });
  }

  async save(split: Split): Promise<void> {
    await this.uow.transaction(async () => {
      await this.uow
        .current()
        .insert(splits)
        .values({
          id: split.id,
          orderId: split.orderId,
          creatorUserId: split.creatorUserId,
          beneficiary: split.beneficiary,
          totalBaseUnits: split.totalBaseUnits,
          confirmedBaseUnits: split.confirmedBaseUnits,
          status: split.status,
          expiresAt: new Date(split.expiresAt),
        })
        .onConflictDoUpdate({
          target: splits.id,
          set: {
            confirmedBaseUnits: split.confirmedBaseUnits,
            status: split.status,
            expiresAt: new Date(split.expiresAt),
            updatedAt: new Date(),
            version: sql`${splits.version} + 1`,
          },
        });

      for (const invitation of split.invitations) {
        const [existing] = await this.uow
          .current()
          .select({ participantId: splitInvitations.participantId })
          .from(splitInvitations)
          .where(eq(splitInvitations.id, invitation.id))
          .limit(1);
        if (existing === undefined) {
          throw new AppError(
            'VALIDATION_FAILED',
            'New split invitations must be created through the capability issuance service.',
          );
        } else {
          await this.uow
            .current()
            .update(splitParticipants)
            .set({
              label: invitation.participantLabel,
              amountBaseUnits: invitation.amountBaseUnits,
              updatedAt: new Date(),
            })
            .where(eq(splitParticipants.id, existing.participantId));
          await this.uow
            .current()
            .update(splitInvitations)
            .set({
              status: invitation.status,
              expiresAt: new Date(invitation.expiresAt),
              updatedAt: new Date(),
            })
            .where(eq(splitInvitations.id, invitation.id));
        }
      }
    });
  }
}

export class DrizzleJudgeEvidenceRepository implements JudgeEvidenceRepositoryPort {
  constructor(
    private readonly uow: PostgresUnitOfWork,
    private readonly shareTokenPepper?: string,
    private readonly acceptanceAttestationSecret?: string,
    private readonly deploymentConfigDigest?: string,
  ) {
    if (shareTokenPepper !== undefined && shareTokenPepper.length < 32) {
      throw new Error('Judge share token pepper must be at least 32 bytes');
    }
    if (acceptanceAttestationSecret !== undefined && acceptanceAttestationSecret.length < 32) {
      throw new Error('Live acceptance attestation secret must be at least 32 bytes');
    }
    if (
      deploymentConfigDigest !== undefined &&
      !/^0x[0-9a-fA-F]{64}$/.test(deploymentConfigDigest)
    ) {
      throw new Error('Live acceptance deployment digest must be a bytes32 value');
    }
  }

  async #hasCurrentLiveAcceptance(proof: PublicJudgeProof): Promise<boolean> {
    if (
      this.acceptanceAttestationSecret === undefined ||
      this.deploymentConfigDigest === undefined ||
      !/^[0-9a-fA-F]{40}$/.test(proof.versions.application) ||
      !['live', 'recorded_live'].includes(proof.provenance)
    ) {
      return false;
    }
    const rows = await this.uow
      .current()
      .select({
        acceptance: liveAcceptanceEvidence,
        orderUserId: orders.userId,
        orderPayer: orders.payer,
        orderConfirmedAt: orders.confirmedAt,
        attempt: paymentAttempts,
        provider: providerOperations,
        wallet: walletAccounts,
        delegation: delegationRecords,
        receipt: receipts,
      })
      .from(liveAcceptanceEvidence)
      .innerJoin(orders, eq(orders.id, liveAcceptanceEvidence.orderId))
      .innerJoin(
        paymentAttempts,
        and(
          eq(paymentAttempts.id, liveAcceptanceEvidence.paymentAttemptId),
          eq(paymentAttempts.orderId, orders.id),
          eq(paymentAttempts.status, 'paid'),
          eq(paymentAttempts.providerOperationId, liveAcceptanceEvidence.providerOperationId),
          eq(
            paymentAttempts.destinationTransactionHash,
            liveAcceptanceEvidence.settlementTransactionHash,
          ),
          eq(paymentAttempts.previewDigest, liveAcceptanceEvidence.previewDigest),
          isNotNull(paymentAttempts.preparedRootHashDigest),
          isNotNull(paymentAttempts.submissionStartedAt),
        ),
      )
      .innerJoin(
        providerOperations,
        and(
          eq(providerOperations.paymentAttemptId, paymentAttempts.id),
          eq(providerOperations.provider, 'particle'),
          eq(providerOperations.externalId, liveAcceptanceEvidence.providerOperationId),
          eq(providerOperations.kind, 'checkout'),
          eq(providerOperations.status, 'succeeded'),
          eq(providerOperations.submissionPossible, true),
          eq(providerOperations.evidenceDigest, liveAcceptanceEvidence.providerEvidenceDigest),
          eq(
            providerOperations.destinationTransactionHash,
            liveAcceptanceEvidence.settlementTransactionHash,
          ),
          sql`${providerOperations.safeSummary}->>'provenance' = ${liveAcceptanceEvidence.providerProvenance}`,
          sql`${providerOperations.safeSummary}->>'environment' = ${liveAcceptanceEvidence.environment}::text`,
        ),
      )
      .innerJoin(
        walletAccounts,
        and(
          eq(walletAccounts.userId, orders.userId),
          eq(walletAccounts.environment, liveAcceptanceEvidence.environment),
          eq(walletAccounts.ownerAddressLower, orders.payer),
          eq(walletAccounts.universalAccountAddressLower, orders.payer),
          eq(walletAccounts.eip7702Enabled, true),
          eq(walletAccounts.delegationStatus, 'confirmed'),
          eq(
            walletAccounts.delegationTransactionHash,
            liveAcceptanceEvidence.delegationTransactionHash,
          ),
          eq(walletAccounts.evidenceDigest, liveAcceptanceEvidence.delegationEvidenceDigest),
        ),
      )
      .innerJoin(
        delegationRecords,
        and(
          eq(delegationRecords.userId, orders.userId),
          eq(delegationRecords.environment, liveAcceptanceEvidence.environment),
          eq(delegationRecords.chainId, liveAcceptanceEvidence.chainId),
          eq(delegationRecords.status, 'confirmed'),
          eq(delegationRecords.ownerAddressLower, orders.payer),
          eq(delegationRecords.implementationAddressLower, walletAccounts.arbitrumImplementation),
          eq(delegationRecords.transactionHash, liveAcceptanceEvidence.delegationTransactionHash),
          eq(delegationRecords.evidenceDigest, liveAcceptanceEvidence.delegationEvidenceDigest),
          isNotNull(delegationRecords.blockNumber),
          isNotNull(delegationRecords.blockHash),
          lt(delegationRecords.blockNumber, liveAcceptanceEvidence.settlementBlockNumber),
        ),
      )
      .innerJoin(
        receipts,
        and(
          eq(receipts.id, liveAcceptanceEvidence.receiptId),
          eq(receipts.orderId, orders.id),
          eq(receipts.status, 'issued'),
          eq(receipts.tokenId, liveAcceptanceEvidence.passTokenId),
          isNotNull(receipts.chainEventId),
        ),
      )
      .where(
        and(
          eq(liveAcceptanceEvidence.orderId, proof.orderId),
          eq(liveAcceptanceEvidence.environment, proof.environment as 'production'),
          eq(liveAcceptanceEvidence.releaseId, proof.versions.application.toLowerCase()),
          eq(
            liveAcceptanceEvidence.deploymentConfigDigest,
            this.deploymentConfigDigest.toLowerCase(),
          ),
          eq(liveAcceptanceEvidence.providerProvenance, proof.provenance),
          eq(liveAcceptanceEvidence.chainId, proof.settlement.chainId),
          eq(
            liveAcceptanceEvidence.checkoutAddress,
            proof.settlement.checkoutAddress.toLowerCase(),
          ),
          eq(
            liveAcceptanceEvidence.settlementTransactionHash,
            proof.settlement.event.transactionHash.toLowerCase(),
          ),
          eq(
            liveAcceptanceEvidence.settlementBlockNumber,
            BigInt(proof.settlement.event.blockNumber),
          ),
          eq(
            liveAcceptanceEvidence.settlementBlockHash,
            proof.settlement.event.blockHash.toLowerCase(),
          ),
          eq(liveAcceptanceEvidence.settlementLogIndex, Number(proof.settlement.event.logIndex)),
          eq(liveAcceptanceEvidence.receiptId, proof.settlement.receiptId),
          eq(liveAcceptanceEvidence.passTokenId, proof.settlement.passTokenId),
        ),
      )
      .limit(2);
    if (rows.length !== 1) return false;
    const row = rows[0];
    if (
      row === undefined ||
      row.orderConfirmedAt === null ||
      row.wallet.arbitrumImplementation === null ||
      row.wallet.protocolVersion.length === 0 ||
      row.delegation.transactionHash === null ||
      row.delegation.blockNumber === null ||
      row.provider.destinationTransactionHash === null ||
      !verifyLiveAcceptanceAttestation(
        this.acceptanceAttestationSecret,
        row.acceptance,
        row.acceptance.attestationVersion,
        row.acceptance.attestationMac,
      )
    ) {
      return false;
    }

    const [identity] = await this.uow
      .current()
      .select({ authMethod: userIdentities.authMethod })
      .from(userIdentities)
      .where(
        and(
          eq(userIdentities.userId, row.orderUserId),
          eq(userIdentities.provider, 'magic'),
          gte(userIdentities.lastVerifiedAt, row.acceptance.startedAt),
          lte(userIdentities.lastVerifiedAt, row.acceptance.capturedAt),
        ),
      )
      .orderBy(desc(userIdentities.lastVerifiedAt), asc(userIdentities.id))
      .limit(1);
    if (identity === undefined || identity.authMethod !== proof.account.authMethod) return false;

    const activationPath =
      row.acceptance.recovery.sponsorGrantCount === 1
        ? 'bootstrap_sponsor'
        : row.acceptance.recovery.delegationCount === 0
          ? 'already_delegated'
          : row.acceptance.recovery.delegationCount === 1
            ? 'self_funded_type4'
            : undefined;
    if (activationPath === undefined) return false;
    const sponsorRows =
      activationPath === 'bootstrap_sponsor'
        ? await this.uow
            .current()
            .select({ transactionHash: bootstrapGrants.transactionHash })
            .from(bootstrapGrants)
            .where(
              and(
                eq(bootstrapGrants.userId, row.orderUserId),
                eq(bootstrapGrants.environment, row.acceptance.environment),
                eq(bootstrapGrants.status, 'confirmed'),
                eq(bootstrapGrants.recipientAddressLower, row.orderPayer),
                isNotNull(bootstrapGrants.transactionHash),
                isNotNull(bootstrapGrants.confirmedAt),
                gte(bootstrapGrants.createdAt, row.acceptance.startedAt),
                lte(bootstrapGrants.confirmedAt, row.orderConfirmedAt),
              ),
            )
            .limit(2)
        : [];
    if (activationPath === 'bootstrap_sponsor' && sponsorRows.length !== 1) return false;
    const sponsorTransactionHash = sponsorRows[0]?.transactionHash;
    const providerSchemaVersion = Number(row.provider.safeSummary.schemaVersion);
    const reconstructed = {
      schemaVersion: 1 as const,
      environment: row.acceptance.environment,
      releaseId: row.acceptance.releaseId,
      deploymentConfigDigest: row.acceptance.deploymentConfigDigest,
      orderId: row.acceptance.orderId,
      paymentAttemptId: row.acceptance.paymentAttemptId,
      providerOperationId: row.acceptance.providerOperationId,
      providerOperation: {
        id: row.provider.externalId,
        status: row.provider.status,
        submissionPossible: row.provider.submissionPossible,
        destinationTransactionHash: row.provider.destinationTransactionHash,
        ...(row.provider.activityUrl === null ? {} : { activityUrl: row.provider.activityUrl }),
        updatedAt: row.provider.safeSummary.providerUpdatedAt,
        evidence: {
          adapter: row.provider.safeSummary.adapter,
          packageVersion: row.provider.safeSummary.packageVersion,
          schemaVersion: providerSchemaVersion,
          environment: row.provider.safeSummary.environment,
          observedAt: row.provider.safeSummary.finalObservedAt,
          evidenceDigest: row.provider.evidenceDigest,
          provenance: row.provider.safeSummary.provenance,
        },
      },
      context: {
        ownerAddress: row.orderPayer,
        authMethod: identity.authMethod,
        activationPath,
        delegationTransactionHash: row.delegation.transactionHash,
        ...(sponsorTransactionHash === null || sponsorTransactionHash === undefined
          ? {}
          : { sponsorGrantTransactionHash: sponsorTransactionHash }),
        particleProtocolVersion: row.wallet.protocolVersion,
        useEIP7702: true as const,
        safeAccountIdentifiers: [row.wallet.universalAccountAddressLower],
      },
      startedAt: row.acceptance.startedAt.toISOString(),
      route: row.acceptance.route,
      settlement: {
        event: row.acceptance.settlementEvent,
        receiptId: row.acceptance.receiptId,
        passTokenId: row.acceptance.passTokenId,
      },
      recovery: row.acceptance.recovery,
      timingMs: row.acceptance.timingMs,
      capturedAt: row.acceptance.capturedAt.toISOString(),
    };
    const expectedPayloadDigest = createLiveAcceptancePayloadDigest({
      input: reconstructed,
      providerEvidenceDigest: row.provider.evidenceDigest.toLowerCase(),
      providerProvenance: row.acceptance.providerProvenance,
      delegationEvidenceDigest: row.delegation.evidenceDigest.toLowerCase(),
      delegationTransactionHash: row.delegation.transactionHash.toLowerCase(),
    });
    const expectedTiming = {
      authenticationMs: acceptanceTimingPhaseMs(row.acceptance.timingMs, [
        'magicAuthentication',
        'magicChallenge',
      ]),
      delegationMs: acceptanceTimingPhaseMs(row.acceptance.timingMs, [
        'readiness',
        'delegationActivation',
        'delegationVerification',
      ]),
      routePreparationMs: acceptanceTimingPhaseMs(row.acceptance.timingMs, [
        'particleInitialization',
        'balancePreflight',
        'passReceiverCompatibility',
        'checkoutBinding',
        'particlePreview',
        'magicRootSignature',
        'operationPersistence',
      ]),
      submissionToCanonicalMs: acceptanceTimingPhaseMs(row.acceptance.timingMs, [
        'particleSubmission',
        'canonicalArbitrumPayment',
      ]),
      recoveryVerificationMs: acceptanceTimingPhaseMs(row.acceptance.timingMs, ['restartRecovery']),
      totalDurationMs: sumAcceptanceTimingMs(row.acceptance.timingMs),
    };
    const compactTiming = Object.fromEntries(
      Object.entries(expectedTiming).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    const parsedOrderPayer = EvmAddressSchema.safeParse(row.orderPayer);
    const parsedDelegationImplementation = EvmAddressSchema.safeParse(
      row.delegation.implementationAddressLower,
    );
    if (!parsedOrderPayer.success || !parsedDelegationImplementation.success) return false;
    return (
      safeHashEquals(row.acceptance.payloadDigest, expectedPayloadDigest) &&
      sameEvmAddress(proof.account.magicEoaBefore, parsedOrderPayer.data) &&
      sameEvmAddress(proof.account.magicEoaAfter, parsedOrderPayer.data) &&
      proof.account.addressContinuous &&
      proof.account.continuityEvidence === 'evidenced' &&
      proof.account.delegationTarget !== undefined &&
      sameEvmAddress(proof.account.delegationTarget, parsedDelegationImplementation.data) &&
      proof.account.delegationTransactionHash?.toLowerCase() ===
        row.delegation.transactionHash.toLowerCase() &&
      proof.particle.eip7702Enabled &&
      proof.particle.eip7702Evidence === 'evidenced' &&
      sameEvmAddress(proof.particle.universalAccountAddress, parsedOrderPayer.data) &&
      proof.particle.routeEvidence === 'evidenced' &&
      proof.particle.operationId === row.provider.externalId &&
      proof.particle.activityUrl === (row.provider.activityUrl ?? undefined) &&
      proof.particle.totalUsd === row.acceptance.route.totalUsd &&
      proof.particle.estimatedFeeUsd === row.acceptance.route.estimatedFeeUsd &&
      proof.particle.slippageBps === row.acceptance.route.slippageBps &&
      proof.particle.quoteObservedAt === row.acceptance.route.quotedAt &&
      proof.particle.previewDigest?.toLowerCase() === row.acceptance.previewDigest.toLowerCase() &&
      createLiveAcceptancePayloadDigest(proof.particle.sourceSummary) ===
        createLiveAcceptancePayloadDigest(row.acceptance.route.sources) &&
      proof.recovery.submissionPersistedBeforeWait &&
      proof.recovery.submissionPersistenceEvidence === 'evidenced' &&
      proof.recovery.reloadRecovered &&
      proof.recovery.reloadRecoveryEvidence === 'evidenced' &&
      proof.recovery.duplicatePrevented &&
      proof.recovery.duplicatePreventionEvidence === 'evidenced' &&
      createLiveAcceptancePayloadDigest(proof.recovery.timing) ===
        createLiveAcceptancePayloadDigest(compactTiming)
    );
  }

  async getPublicProof(
    orderId: OrderId,
    shareToken?: string,
  ): Promise<PublicJudgeProof | undefined> {
    const [record] = await this.uow
      .current()
      .select({
        publicProof: judgeEvidence.publicProof,
        publicProofDigest: judgeEvidence.publicProofDigest,
        shareTokenHash: judgeEvidence.shareTokenHash,
      })
      .from(judgeEvidence)
      .where(
        and(
          eq(judgeEvidence.orderId, orderId),
          eq(judgeEvidence.published, true),
          isNull(judgeEvidence.revokedAt),
          or(isNull(judgeEvidence.expiresAt), gt(judgeEvidence.expiresAt, new Date())),
          sql`exists (
            select 1
            from ${orders} proof_order
            join ${canonicalLogs} payment_log
              on payment_log.chain_id = proof_order.chain_id
              and payment_log.contract_address = ${judgeEvidence.publicProof}->'settlement'->>'checkoutAddress'
              and payment_log.event_name = 'OrderPaid'
              and payment_log.transaction_hash = proof_order.transaction_hash
              and payment_log.block_number = proof_order.block_number
              and payment_log.block_hash = proof_order.block_hash
              and payment_log.log_index = proof_order.log_index
              and payment_log.canonical = true
              and payment_log.projection_status = 'applied'
            join ${receipts} proof_receipt
              on proof_receipt.order_id = proof_order.id
              and proof_receipt.status = 'issued'
              and proof_receipt.token_id::text = ${judgeEvidence.publicProof}->'settlement'->>'passTokenId'
            join ${canonicalLogs} pass_log
              on pass_log.id = proof_receipt.chain_event_id
              and pass_log.chain_id = proof_order.chain_id
              and pass_log.contract_address = ${judgeEvidence.publicProof}->'settlement'->>'passAddress'
              and pass_log.event_name = 'TransferSingle'
              and pass_log.transaction_hash = proof_order.transaction_hash
              and pass_log.block_number = proof_order.block_number
              and pass_log.block_hash = proof_order.block_hash
              and pass_log.canonical = true
              and pass_log.projection_status = 'applied'
            where proof_order.id = ${judgeEvidence.orderId}
              and proof_order.status in ('paid', 'partially_refunded', 'refunded')
              and lower(coalesce(
                payment_log.decoded_payload->'fields'->>'orderKey',
                payment_log.decoded_payload->>'orderKey'
              )) = lower(proof_order.order_key)
              and lower(coalesce(
                payment_log.decoded_payload->'fields'->>'payer',
                payment_log.decoded_payload->>'payer'
              )) = lower(proof_order.payer)
              and lower(coalesce(
                payment_log.decoded_payload->'fields'->>'token',
                payment_log.decoded_payload->>'token'
              )) = lower(proof_order.token_address)
              and coalesce(
                payment_log.decoded_payload->'fields'->>'amountBaseUnits',
                payment_log.decoded_payload->'fields'->>'amount',
                payment_log.decoded_payload->>'amountBaseUnits',
                payment_log.decoded_payload->>'amount'
              ) = proof_order.paid_amount_base_units::text
              and lower(coalesce(
                pass_log.decoded_payload->'fields'->>'operator',
                pass_log.decoded_payload->>'operator'
              )) = lower(${judgeEvidence.publicProof}->'settlement'->>'checkoutAddress')
              and coalesce(
                pass_log.decoded_payload->'fields'->>'from',
                pass_log.decoded_payload->>'from'
              ) ~* '^0x0{40}$'
              and lower(coalesce(
                pass_log.decoded_payload->'fields'->>'to',
                pass_log.decoded_payload->>'to'
              )) = lower(proof_order.recipient)
              and coalesce(
                pass_log.decoded_payload->'fields'->>'id',
                pass_log.decoded_payload->>'id'
              ) = proof_receipt.token_id::text
          )`,
        ),
      )
      .limit(1);
    if (record === undefined) return undefined;
    const parsedProof = PublicJudgeProofSchema.safeParse(record.publicProof);
    if (
      !parsedProof.success ||
      !safeHashEquals(
        record.publicProofDigest.toLowerCase(),
        createLiveAcceptancePayloadDigest(parsedProof.data).toLowerCase(),
      )
    ) {
      return undefined;
    }
    if (record.shareTokenHash !== null) {
      if (
        this.shareTokenPepper === undefined ||
        shareToken === undefined ||
        !/^[A-Za-z0-9_-]{32,256}$/.test(shareToken)
      ) {
        return undefined;
      }
      const candidate = hashOpaqueSecret({
        domain: 'judge-share-token',
        pepper: this.shareTokenPepper,
        value: shareToken,
      });
      if (!safeHashEquals(record.shareTokenHash, candidate)) return undefined;
    }
    if (
      (parsedProof.data.environment === 'demo-mainnet' ||
        parsedProof.data.environment === 'production') &&
      !(await this.#hasCurrentLiveAcceptance(parsedProof.data))
    ) {
      return undefined;
    }
    return parsedProof.data;
  }
}

export class SessionLookupRepository {
  constructor(private readonly uow: PostgresUnitOfWork) {}

  async findActiveByTokenHash(tokenHash: string, now: Date) {
    const [record] = await this.uow
      .current()
      .select()
      .from(serverSessions)
      .where(
        and(
          eq(serverSessions.tokenHash, tokenHash),
          isNull(serverSessions.revokedAt),
          gt(serverSessions.expiresAt, now),
        ),
      )
      .limit(1);
    return record;
  }

  async revokeByTokenHash(tokenHash: string, now: Date): Promise<boolean> {
    const [record] = await this.uow
      .current()
      .update(serverSessions)
      .set({ revokedAt: now })
      .where(and(eq(serverSessions.tokenHash, tokenHash), isNull(serverSessions.revokedAt)))
      .returning({ id: serverSessions.id });
    return record !== undefined;
  }

  async rotateTokenHash(input: {
    id: string;
    expectedHash: string;
    nextHash: string;
    nextVersion: number;
  }): Promise<boolean> {
    const [record] = await this.uow
      .current()
      .update(serverSessions)
      .set({ tokenHash: input.nextHash, tokenHashVersion: input.nextVersion })
      .where(
        and(
          eq(serverSessions.id, input.id),
          eq(serverSessions.tokenHash, input.expectedHash),
          isNull(serverSessions.revokedAt),
        ),
      )
      .returning({ id: serverSessions.id });
    return record !== undefined;
  }

  async rotateCsrfHash(input: {
    id: string;
    expectedHash: string;
    nextHash: string;
  }): Promise<boolean> {
    const [record] = await this.uow
      .current()
      .update(serverSessions)
      .set({ csrfTokenHash: input.nextHash })
      .where(
        and(
          eq(serverSessions.id, input.id),
          eq(serverSessions.csrfTokenHash, input.expectedHash),
          isNull(serverSessions.revokedAt),
        ),
      )
      .returning({ id: serverSessions.id });
    return record !== undefined;
  }

  async rotateCredentials(input: {
    id: string;
    expectedTokenHash: string;
    nextTokenHash: string;
    nextTokenHashVersion: number;
    nextCsrfTokenHash: string;
    now: Date;
  }) {
    const [record] = await this.uow
      .current()
      .update(serverSessions)
      .set({
        tokenHash: input.nextTokenHash,
        tokenHashVersion: input.nextTokenHashVersion,
        csrfTokenHash: input.nextCsrfTokenHash,
        lastSeenAt: input.now,
      })
      .where(
        and(
          eq(serverSessions.id, input.id),
          eq(serverSessions.tokenHash, input.expectedTokenHash),
          isNull(serverSessions.revokedAt),
          gt(serverSessions.expiresAt, input.now),
        ),
      )
      .returning({ userId: serverSessions.userId, expiresAt: serverSessions.expiresAt });
    return record;
  }

  async expireStale(now: Date): Promise<number> {
    const records = await this.uow
      .current()
      .update(serverSessions)
      .set({ revokedAt: now })
      .where(and(lt(serverSessions.expiresAt, now), isNull(serverSessions.revokedAt)))
      .returning({ id: serverSessions.id });
    return records.length;
  }
}

export function assertMerchantAuthorization(
  user: { id: string; merchantMemberships: readonly { merchantId: MerchantId; role: string }[] },
  merchantId: MerchantId,
  allowedRoles: readonly string[],
): void {
  const membership = user.merchantMemberships.find((entry) => entry.merchantId === merchantId);
  if (membership === undefined || !allowedRoles.includes(membership.role)) {
    throw new AppError(
      'AUTH_FORBIDDEN',
      'You are not authorized to access this merchant resource.',
    );
  }
}
