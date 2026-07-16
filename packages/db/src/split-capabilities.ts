import {
  AppError,
  type OrderId,
  SplitIdSchema,
  SplitInvitationIdSchema,
  type UserId,
} from '@opentab/shared';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { hashSplitInvitationCapability, opaqueId, randomSecret, safeHashEquals } from './crypto.js';
import { orders, splitInvitations, splitParticipants, splits } from './schema/index.js';
import type { PostgresUnitOfWork } from './unit-of-work.js';

export interface CreateSecureSplitInput {
  readonly orderId: OrderId;
  readonly creatorUserId: UserId;
  readonly beneficiary: string;
  readonly totalBaseUnits: string;
  readonly expiresAt: Date;
  readonly participants: readonly { label: string; amountBaseUnits: string }[];
}

export interface IssuedSplitInvitation {
  readonly invitationId: string;
  readonly participantLabel: string;
  readonly amountBaseUnits: string;
  readonly capabilityToken: string;
  readonly expiresAt: string;
}

export class PostgresSplitCapabilityStore {
  constructor(
    private readonly uow: PostgresUnitOfWork,
    private readonly capabilityPepper: string,
  ) {}

  async create(input: CreateSecureSplitInput): Promise<{
    splitId: ReturnType<typeof SplitIdSchema.parse>;
    invitations: readonly IssuedSplitInvitation[];
  }> {
    if (input.participants.length < 1 || input.participants.length > 50) {
      throw new AppError(
        'VALIDATION_FAILED',
        'A split must have between one and fifty participants.',
      );
    }
    const allocation = input.participants.reduce(
      (sum, participant) => sum + BigInt(participant.amountBaseUnits),
      0n,
    );
    if (allocation !== BigInt(input.totalBaseUnits) || allocation <= 0n) {
      throw new AppError(
        'VALIDATION_FAILED',
        'Split participant amounts must exactly equal the split total.',
      );
    }
    if (input.expiresAt <= new Date())
      throw new AppError('SPLIT_EXPIRED', 'The split expiry must be in the future.');

    const splitId = SplitIdSchema.parse(opaqueId('spl'));
    const issued = input.participants.map((participant) => {
      const invitationId = SplitInvitationIdSchema.parse(opaqueId('spi'));
      const capabilityToken = randomSecret(32);
      return {
        invitationId,
        participantLabel: participant.label,
        amountBaseUnits: participant.amountBaseUnits,
        capabilityToken,
        capabilityHash: hashSplitInvitationCapability({
          invitationId,
          pepper: this.capabilityPepper,
          capabilityToken,
        }),
      };
    });

    await this.uow.transaction(async () => {
      const [order] = await this.uow
        .current()
        .select({
          id: orders.id,
          userId: orders.userId,
          payer: orders.payer,
          status: orders.status,
          paidAmountBaseUnits: orders.paidAmountBaseUnits,
          refundedAmountBaseUnits: orders.refundedAmountBaseUnits,
          confirmedAt: orders.confirmedAt,
        })
        .from(orders)
        .where(eq(orders.id, input.orderId))
        .for('update')
        .limit(1);
      if (order === undefined || order.userId !== input.creatorUserId) {
        throw new AppError('NOT_FOUND', 'The paid order was not found.');
      }
      if (!['paid', 'partially_refunded'].includes(order.status) || order.confirmedAt === null) {
        throw new AppError(
          'VALIDATION_FAILED',
          'A split can only be created for a confirmed paid order.',
        );
      }
      if (order.payer.toLowerCase() !== input.beneficiary.toLowerCase()) {
        throw new AppError(
          'WALLET_ADDRESS_MISMATCH',
          'The split beneficiary must be the original purchaser.',
        );
      }
      const netPaid = BigInt(order.paidAmountBaseUnits) - BigInt(order.refundedAmountBaseUnits);
      if (BigInt(input.totalBaseUnits) > netPaid) {
        throw new AppError(
          'VALIDATION_FAILED',
          'The split total exceeds the confirmed purchase amount.',
        );
      }
      const [existingSplit] = await this.uow
        .current()
        .select({ id: splits.id })
        .from(splits)
        .where(eq(splits.orderId, input.orderId))
        .limit(1);
      if (existingSplit !== undefined) {
        throw new AppError('IDEMPOTENCY_CONFLICT', 'A split already exists for this order.');
      }

      await this.uow.current().insert(splits).values({
        id: splitId,
        orderId: input.orderId,
        creatorUserId: input.creatorUserId,
        beneficiary: input.beneficiary,
        totalBaseUnits: input.totalBaseUnits,
        status: 'active',
        expiresAt: input.expiresAt,
      });
      for (const invitation of issued) {
        const [participant] = await this.uow
          .current()
          .insert(splitParticipants)
          .values({
            splitId,
            label: invitation.participantLabel,
            amountBaseUnits: invitation.amountBaseUnits,
          })
          .returning({ id: splitParticipants.id });
        if (participant === undefined) throw new Error('Failed to create split participant');
        await this.uow.current().insert(splitInvitations).values({
          id: invitation.invitationId,
          splitId,
          participantId: participant.id,
          capabilityHash: invitation.capabilityHash,
          status: 'unpaid',
          expiresAt: input.expiresAt,
        });
      }
    });

    return {
      splitId,
      invitations: issued.map(({ capabilityHash: _capabilityHash, ...invitation }) => ({
        ...invitation,
        expiresAt: input.expiresAt.toISOString(),
      })),
    };
  }

  async resolve(input: { invitationId: string; capabilityToken: string; now?: Date }) {
    const now = input.now ?? new Date();
    const [invitation] = await this.uow
      .current()
      .select({
        id: splitInvitations.id,
        splitId: splitInvitations.splitId,
        capabilityHash: splitInvitations.capabilityHash,
        status: splitInvitations.status,
        expiresAt: splitInvitations.expiresAt,
        participantLabel: splitParticipants.label,
        amountBaseUnits: splitParticipants.amountBaseUnits,
        beneficiary: splits.beneficiary,
      })
      .from(splitInvitations)
      .innerJoin(splitParticipants, eq(splitParticipants.id, splitInvitations.participantId))
      .innerJoin(splits, eq(splits.id, splitInvitations.splitId))
      .where(
        and(
          eq(splitInvitations.id, input.invitationId),
          isNull(splitInvitations.revokedAt),
          gt(splitInvitations.expiresAt, now),
        ),
      )
      .limit(1);
    const computed = hashSplitInvitationCapability({
      invitationId: input.invitationId,
      pepper: this.capabilityPepper,
      capabilityToken: input.capabilityToken,
    });
    if (invitation === undefined || !safeHashEquals(invitation.capabilityHash, computed)) {
      throw new AppError('NOT_FOUND', 'The split invitation was not found.');
    }
    return {
      id: invitation.id,
      splitId: invitation.splitId,
      participantLabel: invitation.participantLabel,
      amountBaseUnits: invitation.amountBaseUnits,
      beneficiary: invitation.beneficiary,
      status: invitation.status,
      expiresAt: invitation.expiresAt.toISOString(),
    };
  }
}
