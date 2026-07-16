import {
  BaseUnitAmountSchema,
  EvidenceDigestSchema,
  EvmAddressSchema,
  MerchantIdSchema,
  ProductIdSchema,
  ProviderOperationIdSchema,
  QuantitySchema,
  TransactionHashSchema,
} from '@opentab/shared';
import { z } from 'zod';

export const EmptyBodySchema = z.object({}).strict();
export const SlugSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .min(2)
  .max(80);
export const OpaqueReferenceSchema = z
  .string()
  .min(16)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/);
const SplitCapabilitySegmentSchema = z
  .string()
  .min(16)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/);
export const SplitCapabilityReferenceSchema = z
  .string()
  .min(33)
  .max(401)
  .refine((value) => value.split('.').length === 2, 'Split capability reference is invalid')
  .superRefine((value, context) => {
    const [invitationId, capabilityToken] = value.split('.');
    if (
      !SplitCapabilitySegmentSchema.safeParse(invitationId).success ||
      !SplitCapabilitySegmentSchema.safeParse(capabilityToken).success
    ) {
      context.addIssue({ code: 'custom', message: 'Split capability reference is invalid' });
    }
  });

export const SessionExchangeBodySchema = z
  .object({
    didToken: z.string().min(16).max(16_384),
    continuationId: OpaqueReferenceSchema,
  })
  .strict();
export const AuthContinuationBodySchema = z
  .object({ returnPath: z.string().min(1).max(512) })
  .strict();

export const MerchantBodySchema = z
  .object({
    slug: SlugSchema,
    displayName: z.string().trim().min(1).max(100),
    supportContact: z.string().trim().min(3).max(200).optional(),
    payoutAddress: EvmAddressSchema,
  })
  .strict();

export const MerchantPatchBodySchema = MerchantBodySchema.partial()
  .extend({ expectedVersion: z.string().regex(/^[1-9][0-9]{0,9}$/) })
  .strict()
  .refine((value) => Object.keys(value).length > 1, 'At least one profile field is required')
  .superRefine((value, context) => {
    if (
      value.payoutAddress !== undefined &&
      (value.slug !== undefined ||
        value.displayName !== undefined ||
        value.supportContact !== undefined)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['payoutAddress'],
        message: 'A payout change must be approved separately from profile edits',
      });
    }
  });

export const ProductBodySchema = z
  .object({
    merchantId: MerchantIdSchema,
    slug: SlugSchema,
    title: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(4_000),
    imageUrl: z.string().url().max(2_048).optional(),
    unitPriceBaseUnits: BaseUnitAmountSchema,
    maxSupply: z
      .string()
      .regex(/^[1-9][0-9]{0,77}$/)
      .optional(),
    maxPerOrder: z.string().regex(/^[1-9][0-9]{0,77}$/),
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime().optional(),
    refundWindowSeconds: z.string().regex(/^(0|[1-9][0-9]{0,9})$/),
    loyaltyPoints: BaseUnitAmountSchema,
  })
  .strict();

export const ProductPatchBodySchema = ProductBodySchema.omit({ merchantId: true })
  .partial()
  .extend({ expectedVersion: z.string().regex(/^[1-9][0-9]{0,9}$/) })
  .strict()
  .refine((value) => Object.keys(value).length > 1, 'At least one product field is required');

export const CheckoutLinkBodySchema = z
  .object({
    productId: ProductIdSchema,
    campaign: z.string().trim().min(1).max(100).optional(),
    expiresAt: z.string().datetime().optional(),
  })
  .strict();

export const CheckoutSessionBodySchema = z
  .object({
    productId: ProductIdSchema,
    quantity: QuantitySchema,
    receiptRecipient: EvmAddressSchema.optional(),
    clientContext: z
      .object({ campaign: z.string().trim().min(1).max(100).optional() })
      .strict()
      .optional(),
  })
  .strict();

export const BindCheckoutBodySchema = z
  .object({ receiptRecipient: EvmAddressSchema.optional() })
  .strict();

export const QuoteRefreshBodySchema = z
  .object({ reason: z.enum(['expired', 'balance_changed', 'user_requested']) })
  .strict();

export const PreparedPaymentBodySchema = z
  .object({
    providerOperationId: ProviderOperationIdSchema,
    rootHashDigest: EvidenceDigestSchema,
    previewDigest: EvidenceDigestSchema,
    expiresAt: z.string().datetime(),
    quoteSummary: z
      .object({
        sourceAmountBaseUnits: BaseUnitAmountSchema,
        destinationAmountBaseUnits: BaseUnitAmountSchema,
        feeBaseUnits: BaseUnitAmountSchema,
        routeLabel: z.string().min(1).max(80),
      })
      .strict(),
  })
  .strict();

export const StartSubmissionBodySchema = z.object({ bindingDigest: EvidenceDigestSchema }).strict();
export const RegisterSubmissionBodySchema = z.discriminatedUnion('status', [
  z
    .object({ status: z.literal('submitted'), providerOperationId: ProviderOperationIdSchema })
    .strict(),
  z.object({ status: z.literal('submitted_unknown') }).strict(),
]);
export const RecoveryBodySchema = z.object({ acknowledgeUnknown: z.literal(true) }).strict();

export const DelegationEvidenceBodySchema = z
  .object({ transactionHash: TransactionHashSchema, evidenceDigest: EvidenceDigestSchema })
  .strict();
export const ChallengeBodySchema = z
  .object({ challengeToken: z.string().min(16).max(4_096) })
  .strict();

const SponsorSubjectHashSchema = z.string().regex(/^[0-9a-f]{64}$/i);
export const SponsorEligibilityCommandBodySchema = ChallengeBodySchema.extend({
  identitySubjectHash: SponsorSubjectHashSchema,
  addressSubjectHash: SponsorSubjectHashSchema,
  networkSubjectHash: SponsorSubjectHashSchema,
  deviceSubjectHash: SponsorSubjectHashSchema,
}).strict();
export const SponsorGrantCommandBodySchema = SponsorEligibilityCommandBodySchema.extend({
  recipient: EvmAddressSchema,
}).strict();

export const RefundBodySchema = z.object({ amountBaseUnits: BaseUnitAmountSchema }).strict();
export const WithdrawalBodySchema = z
  .object({ merchantId: MerchantIdSchema, amountBaseUnits: BaseUnitAmountSchema })
  .strict();
export const FinancialSubmissionBodySchema = z.discriminatedUnion('status', [
  z
    .object({ status: z.literal('submitted'), providerOperationId: ProviderOperationIdSchema })
    .strict(),
  z.object({ status: z.literal('submitted_unknown') }).strict(),
]);
export const ContractOperationSubmissionBodySchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('submission_started'),
      providerOperationId: ProviderOperationIdSchema,
    })
    .strict(),
  z
    .object({ status: z.literal('submitted'), providerOperationId: ProviderOperationIdSchema })
    .strict(),
  z
    .object({
      status: z.literal('submitted_unknown'),
      providerOperationId: ProviderOperationIdSchema,
    })
    .strict(),
]);
export const JudgeEvidencePublishBodySchema = z
  .object({
    protected: z.boolean(),
    expiresAt: z.string().datetime().optional(),
  })
  .strict();

export const LoyaltyBodySchema = z
  .object({
    merchantId: MerchantIdSchema,
    name: z.string().trim().min(1).max(100),
    thresholdPoints: BaseUnitAmountSchema,
    enabled: z.boolean(),
  })
  .strict();

export const SplitParticipantSchema = z
  .object({ label: z.string().trim().min(1).max(80), amountBaseUnits: BaseUnitAmountSchema })
  .strict();
export const SplitBodySchema = z
  .object({
    beneficiary: EvmAddressSchema,
    totalBaseUnits: BaseUnitAmountSchema,
    expiresAt: z.string().datetime(),
    participants: z.array(SplitParticipantSchema).min(1).max(50),
  })
  .strict();
export const SplitInvitationBodySchema = z
  .object({ participants: z.array(SplitParticipantSchema).min(1).max(50) })
  .strict();
export const SplitRevokeBodySchema = z
  .object({ reason: z.string().trim().min(3).max(200) })
  .strict();
export const SplitPrepareBodySchema = z
  .object({ capabilityReference: SplitCapabilityReferenceSchema })
  .strict();
export const SplitSubmissionBodySchema = z.discriminatedUnion('status', [
  z
    .object({ status: z.literal('submitted'), providerOperationId: ProviderOperationIdSchema })
    .strict(),
  z.object({ status: z.literal('submitted_unknown') }).strict(),
]);

const PublicDigestSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
export const PublicBrowserConfigSchema = z
  .object({
    applicationReleaseId: z.string().min(3).max(80),
    liveAcceptanceConfigDigest: PublicDigestSchema.optional(),
    magic: z
      .object({ publishableKey: z.string().min(8).max(256), rpcUrl: z.string().url().max(2_048) })
      .strict(),
    particle: z
      .object({
        projectId: z.string().min(1).max(256),
        projectClientKey: z.string().min(1).max(512),
        projectAppUuid: z.string().min(1).max(256),
        expectedImplementationAddress: EvmAddressSchema,
        expectedImplementationCodeHash: PublicDigestSchema,
        slippageBps: z.number().int().min(0).max(500),
        maxFeeUsdMicros: BaseUnitAmountSchema,
        allowedSourceChainIds: z
          .array(z.string().regex(/^[1-9][0-9]{0,77}$/))
          .min(1)
          .max(32),
        allowedSourceAssets: z
          .array(z.enum(['USDC', 'USDT', 'ETH']))
          .min(1)
          .max(3),
        allowedSourceTokens: z
          .array(
            z
              .object({
                chainId: z.string().regex(/^[1-9][0-9]{0,77}$/),
                asset: z.enum(['USDC', 'USDT', 'ETH']),
                address: EvmAddressSchema,
              })
              .strict(),
          )
          .max(32),
        sourceCallProfiles: z
          .array(
            z
              .object({
                profileId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
                chainId: z.string().regex(/^[1-9][0-9]{0,77}$/),
                asset: z.enum(['USDC', 'USDT', 'ETH']),
                tokenAddress: EvmAddressSchema,
                sourceAmount: z
                  .string()
                  .regex(/^(0|[1-9][0-9]*)(?:\.[0-9]+)?$/)
                  .max(100),
                fixtureDigest: PublicDigestSchema,
                calls: z
                  .array(
                    z
                      .object({
                        uaType: z.string().regex(/^[A-Za-z0-9._:-]{1,80}$/),
                        to: EvmAddressSchema,
                        data: z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/),
                        valueWei: BaseUnitAmountSchema,
                      })
                      .strict(),
                  )
                  .min(1)
                  .max(16),
              })
              .strict(),
          )
          .max(32),
        rpcUrl: z.string().url().max(2_048).optional(),
        responseProfile: z
          .object({
            profileId: z.string().min(1).max(128),
            provenance: z.enum(['deterministic', 'recorded_live']),
            deploymentsFixtureDigest: PublicDigestSchema,
            authFixtureDigest: PublicDigestSchema,
            submissionFixtureDigest: PublicDigestSchema,
            statusFixtureDigest: PublicDigestSchema,
            magicAuthorizationNonceOffset: z.union([z.literal(0), z.literal(1)]),
            delegationPlanTtlSeconds: z.number().int().min(30).max(600),
          })
          .strict(),
      })
      .strict(),
    environment: z.string().min(1).max(40),
    media: z.object({ allowedOrigins: z.array(z.string().url()).max(21) }).strict(),
    features: z
      .object({
        checkout: z.boolean(),
        bootstrapGas: z.boolean(),
        splits: z.boolean(),
        loyalty: z.boolean(),
        judgeMode: z.boolean(),
      })
      .strict(),
  })
  .strict();
