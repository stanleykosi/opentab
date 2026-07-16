import type { UniversalOperationPort } from '@opentab/application';
import {
  AppError,
  ARBITRUM_ONE_CHAIN_ID,
  BaseUnitAmountSchema,
  type BoundOperationTemplate,
  BoundOperationTemplateSchema,
  type Bytes32,
  Bytes32Schema,
  ChainIdSchema,
  type CheckoutBinding,
  CheckoutBindingSchema,
  type DelegationStatus,
  DelegationStatusSchema,
  EvidenceDigestSchema,
  type EvmAddress,
  EvmAddressSchema,
  type ProviderOperation,
  type ProviderOperationId,
  ProviderOperationIdSchema,
  ProviderOperationSchema,
  QuotePreviewSchema,
  sameEvmAddress,
  type UnifiedBalance,
  type UntrustedPreparedOperation,
  UntrustedPreparedOperationSchema,
  type ValidatedOperationPlan,
  ValidatedOperationPlanSchema,
  type VerifiedDelegationPlan,
  VerifiedDelegationPlanSchema,
} from '@opentab/shared';
import {
  CHAIN_ID,
  PREFER_TOKEN_TYPE,
  SUPPORTED_TOKEN_TYPE,
  UA_TRANSACTION_STATUS,
  UNIVERSAL_ACCOUNT_VERSION,
  UniversalAccount,
} from '@particle-network/universal-account-sdk';
import { getBytes, verifyMessage } from 'ethers';
import {
  decodeFunctionData,
  encodeFunctionData,
  formatUnits,
  getAddress,
  type Hex,
  isAddressEqual,
  parseAbi,
  toHex,
} from 'viem';
import { z } from 'zod';
import { adapterEvidence, digestUnknown } from './evidence.js';
import { mapParticleError } from './vendor-errors.js';

const PARTICLE_PACKAGE_VERSION = '2.0.3';
const ARBITRUM_CHAIN_NUMBER = Number(ARBITRUM_ONE_CHAIN_ID);
const ONE_USD_18 = 1_000_000_000_000_000_000n;
const ONE_USD_MICROS = 1_000_000n;
const PARTICLE_SUPPORTED_CHAIN_IDS = new Set(
  Object.values(CHAIN_ID)
    .filter(
      (value): value is number =>
        typeof value === 'number' && Number.isSafeInteger(value) && value > 0,
    )
    .map((value) => value.toString()),
);

const erc20ApproveAbi = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
]);
const checkoutPayAbi = parseAbi([
  'function pay((bytes32 orderKey,address payer,address recipient,uint256 merchantId,uint256 productId,uint64 productVersion,address token,uint256 amount,uint16 platformFeeBps,uint256 platformFee,uint64 quantity,uint64 validAfter,uint64 validUntil,uint64 refundDeadline,bytes32 metadataHash) intent, bytes signature)',
]);

const SmartAccountOptionsSchema = z.object({
  name: z.literal('UNIVERSAL'),
  version: z.literal(UNIVERSAL_ACCOUNT_VERSION),
  ownerAddress: EvmAddressSchema,
  smartAccountAddress: EvmAddressSchema,
  solanaSmartAccountAddress: z.string().min(1).max(128).optional(),
  useEIP7702: z.literal(true),
});

const ParticleTokenSchema = z.object({
  type: z.enum(['eth', 'usdt', 'usdc', 'bnb', 'sol']).optional(),
  chainId: z.number().int().positive().safe(),
  address: z.string().min(1).max(128),
  symbol: z.string().min(1).max(20).optional(),
  decimals: z.number().int().min(0).max(255),
  realDecimals: z.number().int().min(0).max(255),
});

const ParticleTokenAmountSchema = z.object({
  token: ParticleTokenSchema,
  amount: z.string().min(1).max(100),
  amountInUSD: z.string().min(1).max(100),
  senderAddress: z.string().min(1).max(128),
});

const PrimaryAssetsSchema = z.object({
  assets: z.array(
    z.object({
      tokenType: z.enum(['eth', 'usdt', 'usdc', 'bnb', 'sol']),
      price: z.number().finite().nonnegative(),
      amount: z.number().finite().nonnegative(),
      amountInUSD: z.number().finite().nonnegative(),
      chainAggregation: z.array(
        z.object({
          token: ParticleTokenSchema,
          amount: z.number().finite().nonnegative(),
          amountInUSD: z.number().finite().nonnegative(),
          rawAmount: z.number().int().nonnegative().safe(),
        }),
      ),
    }),
  ),
  totalAmountInUSD: z.number().finite().nonnegative(),
});

const DeploymentRecordSchema = z
  .object({
    chainId: z.number().int().positive().safe(),
    isDelegated: z.boolean(),
    address: EvmAddressSchema.optional(),
  })
  .passthrough();
const DeploymentResponseSchema = z.array(DeploymentRecordSchema).min(1);

const DelegationAuthRecordSchema = z
  .object({
    chainId: z.number().int().positive().safe().optional(),
    address: EvmAddressSchema,
    nonce: z.number().int().nonnegative().safe(),
  })
  .passthrough();
const DelegationAuthResponseSchema = z.array(DelegationAuthRecordSchema).length(1);

const PreparedCallSchema = z.object({
  uaType: z.string().min(1).max(80),
  to: EvmAddressSchema,
  data: z.string().regex(/^0x[0-9a-fA-F]*$/),
  value: z
    .string()
    .regex(/^0x[0-9a-fA-F]+$/)
    .optional(),
});

const PreparedUserOpSchema = z.object({
  chainId: z.number().int().positive().safe(),
  userOpHash: Bytes32Schema,
  expiredAt: z.number().int().positive().safe(),
  txs: z.array(PreparedCallSchema),
  eip7702Delegated: z.boolean().optional(),
  eip7702Auth: z
    .object({
      chainId: z.number().int().positive().safe(),
      nonce: z.number().int().nonnegative().safe(),
      address: EvmAddressSchema,
    })
    .optional(),
});

const FeeQuoteSchema = z.object({
  fees: z.object({
    totals: z.object({ feeTokenAmountInUSD: z.string().regex(/^(0|[1-9][0-9]*)$/) }),
  }),
  userOps: z.array(PreparedUserOpSchema),
});

const PreparedTransactionSchema = z
  .object({
    type: z.string().min(1).max(80),
    mode: z.string().min(1).max(80),
    sender: EvmAddressSchema,
    receiver: EvmAddressSchema,
    transactionId: z.string().min(1).max(256),
    smartAccountOptions: z.object({
      name: z.literal('UNIVERSAL'),
      version: z.literal(UNIVERSAL_ACCOUNT_VERSION),
      ownerAddress: EvmAddressSchema,
      senderAddress: EvmAddressSchema,
      senderSolanaAddress: z.string().max(128),
    }),
    depositTokens: z.array(ParticleTokenAmountSchema),
    feeQuotes: z.array(FeeQuoteSchema),
    gasless: FeeQuoteSchema.nullable().optional(),
    tokenChanges: z.object({
      decr: z.array(ParticleTokenAmountSchema),
      totalFeeInUSD: z.string().min(1).max(100),
      slippage: z.number().int().nonnegative().safe(),
    }),
    rootHash: Bytes32Schema,
    userOps: z.array(PreparedUserOpSchema).min(1),
    quotedAt: z.string().datetime(),
  })
  .passthrough();

const SubmissionResponseSchema = z
  .object({
    transactionId: z.string().min(1).max(256),
    status: z.number().int().nonnegative().safe().optional(),
    updated_at: z.string().datetime().optional(),
  })
  .passthrough();

const TransactionStatusResponseSchema = z
  .object({
    transactionId: z.string().min(1).max(256),
    status: z.number().int().nonnegative().safe(),
    updated_at: z.string().datetime(),
    transactionHash: z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/)
      .optional(),
    destinationTransactionHash: z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/)
      .optional(),
  })
  .passthrough();

interface ParticleSdkLike {
  getSmartAccountOptions(): Promise<unknown>;
  getPrimaryAssets(): Promise<unknown>;
  getEIP7702Deployments(): Promise<unknown>;
  getEIP7702Auth(chainIds: number[]): Promise<unknown>;
  createUniversalTransaction(input: {
    chainId: number;
    expectTokens: readonly { type: SUPPORTED_TOKEN_TYPE; amount: string }[];
    transactions: readonly { to: string; data: string; value?: string }[];
  }): Promise<unknown>;
  sendTransaction(transaction: unknown, signature: string): Promise<unknown>;
  getTransaction(transactionId: string): Promise<unknown>;
}

export interface ParticleRecordedResponseProfile {
  readonly profileId: string;
  readonly provenance: 'deterministic' | 'recorded_live';
  readonly deploymentsFixtureDigest: `0x${string}`;
  readonly authFixtureDigest: `0x${string}`;
  readonly submissionFixtureDigest: `0x${string}`;
  readonly statusFixtureDigest: `0x${string}`;
  /** Explicitly fixed from a sanitized live Magic/Particle capture. */
  readonly magicAuthorizationNonceOffset: 0 | 1;
  readonly delegationPlanTtlSeconds: number;
}

export interface ParticleSourceTokenPolicy {
  readonly chainId: string;
  readonly asset: 'USDC' | 'USDT' | 'ETH';
  readonly address: EvmAddress;
}

/**
 * An exact, recorded source-chain call bundle. Particle's root signature covers
 * every user operation, so source calls must be reviewed just as strictly as
 * the Arbitrum destination template. Profiles are alternatives; every
 * non-Arbitrum user operation must match exactly one complete profile.
 */
export interface ParticleSourceCallProfile {
  readonly profileId: string;
  readonly chainId: string;
  readonly asset: 'USDC' | 'USDT' | 'ETH';
  readonly tokenAddress: EvmAddress;
  /** Exact provider-represented debit captured with this call bundle. */
  readonly sourceAmount: string;
  readonly fixtureDigest: Bytes32;
  readonly calls: readonly {
    readonly uaType: string;
    readonly to: EvmAddress;
    readonly data: string;
    readonly valueWei: string;
  }[];
}

export interface ParticleAdapterConfig {
  readonly projectId: string;
  readonly projectClientKey: string;
  readonly projectAppUuid: string;
  readonly ownerAddress: EvmAddress;
  readonly expectedImplementationAddress: EvmAddress;
  readonly expectedImplementationCodeHash: `0x${string}`;
  readonly environment: string;
  readonly slippageBps: number;
  readonly maxFeeUsdMicros: bigint;
  readonly allowedSourceChainIds: readonly string[];
  readonly allowedSourceAssets: readonly ('USDC' | 'USDT' | 'ETH')[];
  /** Exact source-token contracts. Required for every production-like route. */
  readonly allowedSourceTokens?: readonly ParticleSourceTokenPolicy[];
  /** Exact source-call alternatives captured from reviewed, sanitized fixtures. */
  readonly sourceCallProfiles?: readonly ParticleSourceCallProfile[];
  readonly responseProfile: ParticleRecordedResponseProfile;
  readonly rpcUrl?: string;
  readonly now?: () => Date;
}

interface CachedPrepared {
  readonly raw: z.infer<typeof PreparedTransactionSchema>;
  readonly template: BoundOperationTemplate;
  readonly amountBaseUnits?: bigint;
}

function ensureLiveProfile(config: ParticleAdapterConfig): void {
  const productionLike = ['preview', 'staging', 'demo-mainnet', 'production'].includes(
    config.environment,
  );
  if (productionLike && config.responseProfile.provenance !== 'recorded_live') {
    throw new AppError(
      'UA_CONFIGURATION_INVALID',
      'Live Particle mode requires sanitized response-profile evidence.',
    );
  }
  for (const digest of [
    config.responseProfile.deploymentsFixtureDigest,
    config.responseProfile.authFixtureDigest,
    config.responseProfile.submissionFixtureDigest,
    config.responseProfile.statusFixtureDigest,
    config.expectedImplementationCodeHash,
  ]) {
    EvidenceDigestSchema.parse(digest);
  }
  if (
    !Number.isInteger(config.responseProfile.delegationPlanTtlSeconds) ||
    config.responseProfile.delegationPlanTtlSeconds < 30 ||
    config.responseProfile.delegationPlanTtlSeconds > 600
  ) {
    throw new AppError('UA_CONFIGURATION_INVALID', 'Delegation plan TTL is invalid.');
  }
}

function allowedTokenTypes(config: ParticleAdapterConfig): SUPPORTED_TOKEN_TYPE[] {
  const mapping = {
    USDC: SUPPORTED_TOKEN_TYPE.USDC,
    USDT: SUPPORTED_TOKEN_TYPE.USDT,
    ETH: SUPPORTED_TOKEN_TYPE.ETH,
  } as const;
  return config.allowedSourceAssets.map((asset) => mapping[asset]);
}

function validateParticleAdapterPolicy(config: ParticleAdapterConfig): void {
  ensureLiveProfile(config);
  if (
    config.slippageBps < 0 ||
    config.slippageBps > 500 ||
    !Number.isInteger(config.slippageBps) ||
    config.maxFeeUsdMicros <= 0n
  ) {
    throw new AppError('UA_CONFIGURATION_INVALID', 'Particle trade policy is invalid.');
  }
  const allowedAssetNames = new Set(['USDC', 'USDT', 'ETH']);
  if (
    config.allowedSourceAssets.length === 0 ||
    new Set(config.allowedSourceAssets).size !== config.allowedSourceAssets.length ||
    config.allowedSourceAssets.some((asset) => !allowedAssetNames.has(asset))
  ) {
    throw new AppError('UA_CONFIGURATION_INVALID', 'Particle source-asset policy is invalid.');
  }
  const normalizedChainIds = new Set<string>();
  for (const rawChainId of config.allowedSourceChainIds) {
    const parsed = ChainIdSchema.safeParse(rawChainId);
    const numeric = parsed.success ? Number(parsed.data) : Number.NaN;
    if (
      !parsed.success ||
      !Number.isSafeInteger(numeric) ||
      numeric <= 0 ||
      numeric.toString() !== parsed.data ||
      !PARTICLE_SUPPORTED_CHAIN_IDS.has(parsed.data) ||
      normalizedChainIds.has(parsed.data)
    ) {
      throw new AppError(
        'UA_CONFIGURATION_INVALID',
        'Particle source-chain policy exceeds the installed SDK support.',
      );
    }
    normalizedChainIds.add(parsed.data);
  }
  if (!normalizedChainIds.has(ARBITRUM_ONE_CHAIN_ID)) {
    throw new AppError('UA_CONFIGURATION_INVALID', 'Particle source policy must include Arbitrum.');
  }
  const productionLike = ['preview', 'staging', 'demo-mainnet', 'production'].includes(
    config.environment,
  );
  if (productionLike && (config.allowedSourceTokens?.length ?? 0) === 0) {
    throw new AppError(
      'UA_CONFIGURATION_INVALID',
      'Live Particle source-token contracts are not configured.',
    );
  }
  const sourceTokenKeys = new Set<string>();
  for (const policy of config.allowedSourceTokens ?? []) {
    const chainId = ChainIdSchema.parse(policy.chainId);
    const address = EvmAddressSchema.parse(policy.address);
    if (!normalizedChainIds.has(chainId) || !config.allowedSourceAssets.includes(policy.asset)) {
      throw new AppError(
        'UA_CONFIGURATION_INVALID',
        'Particle source-token policy exceeds its chain or asset allowlist.',
      );
    }
    const key = `${chainId}:${policy.asset}:${address.toLowerCase()}`;
    if (sourceTokenKeys.has(key)) {
      throw new AppError('UA_CONFIGURATION_INVALID', 'Particle source-token policy is duplicated.');
    }
    sourceTokenKeys.add(key);
  }
  const sourceProfileIds = new Set<string>();
  const sourceProfileDigests = new Set<string>();
  for (const profile of config.sourceCallProfiles ?? []) {
    const chainId = ChainIdSchema.parse(profile.chainId);
    const tokenAddress = EvmAddressSchema.parse(profile.tokenAddress);
    EvidenceDigestSchema.parse(profile.fixtureDigest);
    if (
      chainId === ARBITRUM_ONE_CHAIN_ID ||
      !normalizedChainIds.has(chainId) ||
      !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(profile.profileId) ||
      sourceProfileIds.has(profile.profileId) ||
      sourceProfileDigests.has(profile.fixtureDigest.toLowerCase()) ||
      profile.calls.length === 0 ||
      profile.calls.length > 16
    ) {
      throw new AppError(
        'UA_CONFIGURATION_INVALID',
        'Particle source-call profile is invalid or duplicated.',
      );
    }
    sourceProfileIds.add(profile.profileId);
    sourceProfileDigests.add(profile.fixtureDigest.toLowerCase());
    if (
      !/^(0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(profile.sourceAmount) ||
      !config.allowedSourceAssets.includes(profile.asset) ||
      !config.allowedSourceTokens?.some(
        (token) =>
          token.chainId === chainId &&
          token.asset === profile.asset &&
          sameEvmAddress(token.address, tokenAddress),
      )
    ) {
      throw new AppError(
        'UA_CONFIGURATION_INVALID',
        'Particle source-call profile is not bound to an approved source debit.',
      );
    }
    for (const call of profile.calls) {
      EvmAddressSchema.parse(call.to);
      if (
        !/^[A-Za-z0-9._:-]{1,80}$/.test(call.uaType) ||
        !/^0x(?:[0-9a-fA-F]{2})*$/.test(call.data) ||
        !/^(0|[1-9][0-9]*)$/.test(call.valueWei)
      ) {
        throw new AppError(
          'UA_CONFIGURATION_INVALID',
          'Particle source-call profile contains an unsafe call.',
        );
      }
    }
  }
  if (
    productionLike &&
    config.allowedSourceChainIds.some((chainId) => chainId !== ARBITRUM_ONE_CHAIN_ID) &&
    (config.sourceCallProfiles?.length ?? 0) === 0
  ) {
    throw new AppError(
      'UA_CONFIGURATION_INVALID',
      'Live cross-chain Particle calls require a reviewed source-call profile.',
    );
  }
}

function decimalFromNumber(value: number): string {
  if (!Number.isFinite(value) || value < 0) {
    throw new AppError('UA_PROVIDER_SCHEMA_INVALID', 'Particle returned an invalid decimal.');
  }
  const rendered = value.toLocaleString('en-US', {
    useGrouping: false,
    maximumFractionDigits: 20,
    maximumSignificantDigits: 21,
  });
  if (!/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(rendered)) {
    throw new AppError('UA_PROVIDER_SCHEMA_INVALID', 'Particle returned an unsafe decimal.');
  }
  return rendered;
}

function usd18ToMicros(value: string): bigint {
  const base = BigInt(value);
  return (base * ONE_USD_MICROS + ONE_USD_18 - 1n) / ONE_USD_18;
}

function formatUsdMicros(value: bigint): string {
  const whole = value / ONE_USD_MICROS;
  const fraction = (value % ONE_USD_MICROS).toString().padStart(6, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function expectedPaymentAmount(template: BoundOperationTemplate): bigint | undefined {
  if (template.kind !== 'checkout' && template.kind !== 'split_reimbursement') return undefined;
  if (template.calls.length !== 2) {
    throw new AppError('OPERATION_PLAN_INVALID', 'A payment operation requires exactly two calls.');
  }
  const approval = template.calls[0];
  const destination = template.calls[1];
  if (approval === undefined || destination === undefined) {
    throw new AppError('OPERATION_PLAN_INVALID', 'The payment call template is incomplete.');
  }
  if (approval.valueWei !== '0' || destination.valueWei !== '0') {
    throw new AppError('OPERATION_PLAN_INVALID', 'Payment calls cannot transfer native value.');
  }
  try {
    const decoded = decodeFunctionData({ abi: erc20ApproveAbi, data: approval.data as Hex });
    if (decoded.functionName !== 'approve') throw new Error('Approval selector mismatch');
    const [spender, amount] = decoded.args;
    if (!isAddressEqual(spender, getAddress(destination.to)) || amount <= 0n) {
      throw new Error('Approval does not bind the payment destination');
    }
    return amount;
  } catch (error) {
    throw new AppError('OPERATION_PLAN_INVALID', 'The token approval call is invalid.', {
      cause: error,
    });
  }
}

function expirationFromUserOps(userOps: readonly z.infer<typeof PreparedUserOpSchema>[]): Date {
  const expirySeconds = Math.min(...userOps.map((entry) => entry.expiredAt));
  const expiry = new Date(expirySeconds * 1_000);
  if (!Number.isFinite(expiry.getTime())) {
    throw new AppError('UA_PROVIDER_SCHEMA_INVALID', 'Particle returned an invalid expiry.');
  }
  return expiry;
}

function assertExactDestinationCalls(
  prepared: z.infer<typeof PreparedTransactionSchema>,
  template: BoundOperationTemplate,
): void {
  const destinationCalls = prepared.userOps
    .filter((entry) => entry.chainId === ARBITRUM_CHAIN_NUMBER)
    .flatMap((entry) => entry.txs);
  if (destinationCalls.length !== template.calls.length) {
    throw new AppError(
      'UA_PROVIDER_SCHEMA_INVALID',
      'Particle added or removed destination calls.',
    );
  }
  for (const [index, expected] of template.calls.entries()) {
    const actual = destinationCalls[index];
    if (
      actual === undefined ||
      !sameEvmAddress(actual.to, expected.to) ||
      actual.data.toLowerCase() !== expected.data.toLowerCase() ||
      BigInt(actual.value ?? '0x0') !== BigInt(expected.valueWei)
    ) {
      throw new AppError('UA_PROVIDER_SCHEMA_INVALID', 'Particle changed the bound call template.');
    }
  }
}

function sourceCallMatches(
  actual: z.infer<typeof PreparedCallSchema>,
  expected: ParticleSourceCallProfile['calls'][number],
): boolean {
  return (
    actual.uaType === expected.uaType &&
    sameEvmAddress(actual.to, expected.to) &&
    actual.data.toLowerCase() === expected.data.toLowerCase() &&
    BigInt(actual.value ?? '0x0') === BigInt(expected.valueWei)
  );
}

function assertReviewedSourceCalls(
  prepared: z.infer<typeof PreparedTransactionSchema>,
  sourceValues: readonly z.infer<typeof ParticleTokenAmountSchema>[],
  profiles: readonly ParticleSourceCallProfile[],
): void {
  const sourceOps = prepared.userOps.filter((entry) => entry.chainId !== ARBITRUM_CHAIN_NUMBER);
  const sourceChains = new Set(
    sourceValues
      .map((entry) => entry.token.chainId)
      .filter((chainId) => chainId !== ARBITRUM_CHAIN_NUMBER),
  );
  for (const chainId of sourceChains) {
    if (!sourceOps.some((entry) => entry.chainId === chainId)) {
      throw new AppError(
        'UA_PROVIDER_SCHEMA_INVALID',
        'Particle omitted the reviewed source-chain operation.',
      );
    }
  }
  const consumedProfiles = new Set<string>();
  const consumedSourceEntries = new Set<number>();
  for (const userOp of sourceOps) {
    if (!sourceChains.has(userOp.chainId)) {
      throw new AppError(
        'UA_PROVIDER_SCHEMA_INVALID',
        'Particle added a source-chain operation without a selected source asset.',
      );
    }
    const matches = profiles.flatMap((profile) => {
      if (
        Number(profile.chainId) !== userOp.chainId ||
        profile.calls.length !== userOp.txs.length ||
        !profile.calls.every((expected, index) => {
          const actual = userOp.txs[index];
          return actual !== undefined && sourceCallMatches(actual, expected);
        })
      ) {
        return [];
      }
      const sourceIndexes = sourceValues.flatMap((entry, index) => {
        const sourceAddress = EvmAddressSchema.safeParse(entry.token.address);
        const providerAsset =
          entry.token.type === 'usdc'
            ? 'USDC'
            : entry.token.type === 'usdt'
              ? 'USDT'
              : entry.token.type === 'eth'
                ? 'ETH'
                : undefined;
        return entry.token.chainId === userOp.chainId &&
          providerAsset === profile.asset &&
          sourceAddress.success &&
          sameEvmAddress(sourceAddress.data, profile.tokenAddress) &&
          entry.amount === profile.sourceAmount
          ? [index]
          : [];
      });
      return sourceIndexes.length === 1
        ? [{ profile, sourceIndex: sourceIndexes[0] as number }]
        : [];
    });
    const matched = matches[0];
    if (
      matches.length !== 1 ||
      matched === undefined ||
      consumedProfiles.has(matched.profile.profileId) ||
      consumedSourceEntries.has(matched.sourceIndex)
    ) {
      throw new AppError(
        'UA_PROVIDER_SCHEMA_INVALID',
        'Particle source-chain calls do not match one reviewed profile.',
      );
    }
    consumedProfiles.add(matched.profile.profileId);
    consumedSourceEntries.add(matched.sourceIndex);
  }
  const nonArbitrumSourceCount = sourceValues.filter(
    (entry) => entry.token.chainId !== ARBITRUM_CHAIN_NUMBER,
  ).length;
  if (consumedSourceEntries.size !== nonArbitrumSourceCount) {
    throw new AppError(
      'UA_PROVIDER_SCHEMA_INVALID',
      'Particle source assets are not bound one-to-one to reviewed source calls.',
    );
  }
}

function statusName(status: number): ProviderOperation['status'] {
  switch (status) {
    case UA_TRANSACTION_STATUS.INITIALIZING:
      return 'preparing';
    case UA_TRANSACTION_STATUS.DEPOSIT_LOCAL:
    case UA_TRANSACTION_STATUS.DEPOSIT_PENDING:
      return 'moving_funds';
    case UA_TRANSACTION_STATUS.EXECUTION_LOCAL:
    case UA_TRANSACTION_STATUS.EXECUTION_PENDING:
    case UA_TRANSACTION_STATUS.PENNY_LOCAL:
    case UA_TRANSACTION_STATUS.PENNY_PENDING:
      return 'executing';
    case UA_TRANSACTION_STATUS.FINISHED:
      return 'succeeded';
    case UA_TRANSACTION_STATUS.EXECUTION_FAILED:
    case UA_TRANSACTION_STATUS.REFUND_FAILED:
    case UA_TRANSACTION_STATUS.PENNY_FAILED:
      return 'failed';
    case UA_TRANSACTION_STATUS.WAIT_TO_REFUND:
    case UA_TRANSACTION_STATUS.REFUND_LOCAL:
    case UA_TRANSACTION_STATUS.REFUND_PENDING:
      return 'refunding';
    case UA_TRANSACTION_STATUS.REFUND_FINISHED:
      return 'refunded';
    default:
      return 'unknown';
  }
}

function universalXActivityUrl(id: string): string {
  return `https://universalx.app/activity/details?id=${encodeURIComponent(id)}`;
}

export function createCheckoutOperationTemplate(
  bindingInput: CheckoutBinding,
): BoundOperationTemplate {
  const binding = CheckoutBindingSchema.parse(bindingInput);
  if (binding.chainId !== ARBITRUM_ONE_CHAIN_ID) {
    throw new AppError('OPERATION_PLAN_INVALID', 'Checkout must settle on Arbitrum One.');
  }
  const intent = binding.orderIntent;
  const approval = encodeFunctionData({
    abi: erc20ApproveAbi,
    functionName: 'approve',
    args: [getAddress(binding.checkoutAddress), BigInt(intent.amountBaseUnits)],
  });
  const pay = encodeFunctionData({
    abi: checkoutPayAbi,
    functionName: 'pay',
    args: [
      {
        orderKey: intent.orderKey as Hex,
        payer: getAddress(intent.payer),
        recipient: getAddress(intent.recipient),
        merchantId: BigInt(intent.merchantOnchainId),
        productId: BigInt(intent.productOnchainId),
        productVersion: BigInt(intent.productVersion),
        token: getAddress(intent.token),
        amount: BigInt(intent.amountBaseUnits),
        platformFeeBps: Number(intent.platformFeeBps),
        platformFee: BigInt(intent.platformFeeBaseUnits),
        quantity: BigInt(intent.quantity),
        validAfter: BigInt(intent.validAfter),
        validUntil: BigInt(intent.validUntil),
        refundDeadline: BigInt(intent.refundDeadline),
        metadataHash: intent.metadataHash as Hex,
      },
      binding.orderIntentSignature as Hex,
    ],
  });
  return BoundOperationTemplateSchema.parse({
    kind: 'checkout',
    ownerAddress: intent.payer,
    chainId: binding.chainId,
    calls: [
      { to: binding.usdcAddress, data: approval, valueWei: '0' },
      { to: binding.checkoutAddress, data: pay, valueWei: '0' },
    ],
    bindingDigest: binding.bindingDigest,
    expiresAt: binding.expiresAt,
  });
}

export class ParticleUniversalAccountAdapter implements UniversalOperationPort {
  readonly #prepared = new Map<string, CachedPrepared>();

  constructor(
    private readonly sdk: ParticleSdkLike,
    private readonly config: ParticleAdapterConfig,
  ) {
    validateParticleAdapterPolicy(config);
  }

  async getAccount() {
    try {
      const raw = await this.sdk.getSmartAccountOptions();
      const account = SmartAccountOptionsSchema.parse(raw);
      if (
        !sameEvmAddress(account.ownerAddress, this.config.ownerAddress) ||
        !sameEvmAddress(account.smartAccountAddress, this.config.ownerAddress)
      ) {
        throw new AppError('WALLET_ADDRESS_MISMATCH', 'Particle did not preserve the Magic EOA.');
      }
      return {
        ownerAddress: account.ownerAddress,
        evmAddress: account.smartAccountAddress,
        ...(account.solanaSmartAccountAddress === undefined
          ? {}
          : { solanaAddress: account.solanaSmartAccountAddress }),
        protocolVersion: UNIVERSAL_ACCOUNT_VERSION,
        eip7702: true as const,
      };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw mapParticleError(error, 'UA_PROVIDER_SCHEMA_INVALID');
    }
  }

  async getUnifiedBalance(): Promise<UnifiedBalance> {
    try {
      await this.getAccount();
      const raw = await this.sdk.getPrimaryAssets();
      const parsed = PrimaryAssetsSchema.parse(raw);
      const now = this.config.now?.() ?? new Date();
      const evidence = adapterEvidence({
        adapter: 'particle-primary-assets',
        packageVersion: PARTICLE_PACKAGE_VERSION,
        schemaVersion: 1,
        environment: this.config.environment,
        observedAt: now,
        payload: raw,
        provenance: this.config.responseProfile.provenance,
      });
      return {
        totalUsd: decimalFromNumber(parsed.totalAmountInUSD),
        assets: parsed.assets.map((asset) => ({
          tokenType: asset.tokenType,
          amount: decimalFromNumber(asset.amount),
          amountUsd: decimalFromNumber(asset.amountInUSD),
          chains: asset.chainAggregation.map((chain) => ({
            chainId: ChainIdSchema.parse(chain.token.chainId.toString()),
            tokenAddress: chain.token.address,
            symbol: chain.token.symbol ?? asset.tokenType.toUpperCase(),
            amount: decimalFromNumber(chain.amount),
            amountUsd: decimalFromNumber(chain.amountInUSD),
            rawAmount: BaseUnitAmountSchema.parse(chain.rawAmount.toString()),
          })),
        })),
        fetchedAt: now.toISOString(),
        evidence,
      };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw mapParticleError(error, 'UA_PROVIDER_SCHEMA_INVALID');
    }
  }

  async getDelegation(): Promise<DelegationStatus> {
    try {
      const raw = await this.sdk.getEIP7702Deployments();
      const records = DeploymentResponseSchema.parse(raw);
      const record = records.find((entry) => entry.chainId === ARBITRUM_CHAIN_NUMBER);
      if (record === undefined) {
        throw new AppError(
          'UA_PROVIDER_SCHEMA_INVALID',
          'Particle omitted Arbitrum delegation state.',
        );
      }
      if (
        record.address !== undefined &&
        !sameEvmAddress(record.address, this.config.expectedImplementationAddress)
      ) {
        throw new AppError(
          'UA_PROVIDER_SCHEMA_INVALID',
          'Particle returned an unexpected delegate.',
        );
      }
      const now = this.config.now?.() ?? new Date();
      return DelegationStatusSchema.parse({
        ownerAddress: this.config.ownerAddress,
        chainId: ARBITRUM_ONE_CHAIN_ID,
        delegated: record.isDelegated,
        ...(record.isDelegated
          ? {
              implementationAddress: this.config.expectedImplementationAddress,
              implementationCodeHash: this.config.expectedImplementationCodeHash,
            }
          : {}),
        evidence: adapterEvidence({
          adapter: 'particle-eip7702-deployments',
          packageVersion: PARTICLE_PACKAGE_VERSION,
          schemaVersion: 1,
          environment: this.config.environment,
          observedAt: now,
          payload: raw,
          provenance: this.config.responseProfile.provenance,
        }),
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw mapParticleError(error, 'UA_PROVIDER_SCHEMA_INVALID');
    }
  }

  async prepareDelegation(): Promise<VerifiedDelegationPlan> {
    try {
      const current = await this.getDelegation();
      if (current.delegated) {
        throw new AppError('UA_DELEGATION_REQUIRED', 'The account is already delegated.');
      }
      const raw = await this.sdk.getEIP7702Auth([ARBITRUM_CHAIN_NUMBER]);
      const [auth] = DelegationAuthResponseSchema.parse(raw);
      if (
        auth === undefined ||
        (auth.chainId !== undefined && auth.chainId !== ARBITRUM_CHAIN_NUMBER)
      ) {
        throw new AppError(
          'UA_PROVIDER_SCHEMA_INVALID',
          'Particle returned a wrong-chain delegation.',
        );
      }
      if (!sameEvmAddress(auth.address, this.config.expectedImplementationAddress)) {
        throw new AppError(
          'UA_PROVIDER_SCHEMA_INVALID',
          'Particle returned an unexpected delegate.',
        );
      }
      const nonce = auth.nonce + this.config.responseProfile.magicAuthorizationNonceOffset;
      if (!Number.isSafeInteger(nonce)) {
        throw new AppError(
          'UA_PROVIDER_SCHEMA_INVALID',
          'Particle returned an unsafe delegation nonce.',
        );
      }
      const now = this.config.now?.() ?? new Date();
      const expiresAt = new Date(
        now.getTime() + this.config.responseProfile.delegationPlanTtlSeconds * 1_000,
      );
      return VerifiedDelegationPlanSchema.parse({
        ownerAddress: this.config.ownerAddress,
        chainId: ARBITRUM_ONE_CHAIN_ID,
        implementationAddress: this.config.expectedImplementationAddress,
        implementationCodeHash: this.config.expectedImplementationCodeHash,
        nonce: nonce.toString(),
        transactionTarget: this.config.ownerAddress,
        data: '0x',
        valueWei: '0',
        expiresAt: expiresAt.toISOString(),
        bindingDigest: digestUnknown({
          owner: this.config.ownerAddress,
          chainId: ARBITRUM_ONE_CHAIN_ID,
          implementation: this.config.expectedImplementationAddress,
          nonce,
          expiresAt: expiresAt.toISOString(),
          rawDigest: digestUnknown(raw),
          profile: this.config.responseProfile.profileId,
        }),
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw mapParticleError(error, 'UA_PROVIDER_SCHEMA_INVALID');
    }
  }

  async prepareOperation(
    templateInput: BoundOperationTemplate,
  ): Promise<UntrustedPreparedOperation> {
    const template = BoundOperationTemplateSchema.parse(templateInput);
    if (
      template.chainId !== ARBITRUM_ONE_CHAIN_ID ||
      !sameEvmAddress(template.ownerAddress, this.config.ownerAddress)
    ) {
      throw new AppError('OPERATION_PLAN_INVALID', 'The operation owner or chain is invalid.');
    }
    if (new Date(template.expiresAt).getTime() <= (this.config.now?.() ?? new Date()).getTime()) {
      throw new AppError('UA_QUOTE_EXPIRED', 'The operation binding has expired.');
    }
    const amountBaseUnits = expectedPaymentAmount(template);
    try {
      const rawUnknown = await this.sdk.createUniversalTransaction({
        chainId: CHAIN_ID.ARBITRUM_MAINNET_ONE,
        expectTokens:
          amountBaseUnits === undefined
            ? []
            : [{ type: SUPPORTED_TOKEN_TYPE.USDC, amount: formatUnits(amountBaseUnits, 6) }],
        transactions: template.calls.map((call) => ({
          to: call.to,
          data: call.data,
          value: toHex(BigInt(call.valueWei)),
        })),
      });
      const raw = PreparedTransactionSchema.parse(rawUnknown);
      if (
        !sameEvmAddress(raw.smartAccountOptions.ownerAddress, this.config.ownerAddress) ||
        !sameEvmAddress(raw.smartAccountOptions.senderAddress, this.config.ownerAddress) ||
        !sameEvmAddress(raw.sender, this.config.ownerAddress)
      ) {
        throw new AppError('WALLET_ADDRESS_MISMATCH', 'Particle prepared for a different owner.');
      }
      const expiresAt = expirationFromUserOps(raw.userOps);
      const now = this.config.now?.() ?? new Date();
      if (
        expiresAt.getTime() <= now.getTime() ||
        expiresAt.getTime() > new Date(template.expiresAt).getTime()
      ) {
        throw new AppError('UA_QUOTE_EXPIRED', 'Particle returned an invalid route expiry.');
      }
      assertExactDestinationCalls(raw, template);
      this.#remember(raw.rootHash, {
        raw,
        template,
        ...(amountBaseUnits === undefined ? {} : { amountBaseUnits }),
      });
      return UntrustedPreparedOperationSchema.parse({
        kind: template.kind,
        rawSchemaVersion: 'particle-sdk-2.0.3-prepared-v1',
        rootHash: raw.rootHash,
        providerOperationId: raw.transactionId,
        quotedAt: raw.quotedAt,
        expiresAt: expiresAt.toISOString(),
        redactedPayloadDigest: digestUnknown(rawUnknown),
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw mapParticleError(error, 'UA_ROUTE_UNAVAILABLE');
    }
  }

  async validateOperation(input: {
    template: BoundOperationTemplate;
    prepared: UntrustedPreparedOperation;
  }): Promise<ValidatedOperationPlan> {
    const template = BoundOperationTemplateSchema.parse(input.template);
    const prepared = UntrustedPreparedOperationSchema.parse(input.prepared);
    const cached = this.#prepared.get(prepared.rootHash);
    if (
      cached === undefined ||
      cached.template.bindingDigest !== template.bindingDigest ||
      prepared.kind !== template.kind ||
      digestUnknown(cached.template) !== digestUnknown(template)
    ) {
      throw new AppError(
        'OPERATION_PLAN_INVALID',
        'The prepared route does not match its binding.',
      );
    }
    const raw = cached.raw;
    assertExactDestinationCalls(raw, template);
    if (raw.tokenChanges.slippage > this.config.slippageBps) {
      throw new AppError('UA_PROVIDER_SCHEMA_INVALID', 'Particle exceeded the slippage policy.');
    }
    const feeQuote = raw.gasless ?? raw.feeQuotes[0];
    if (feeQuote === undefined) {
      throw new AppError('UA_PROVIDER_SCHEMA_INVALID', 'Particle omitted the route fee.');
    }
    if (digestUnknown(feeQuote.userOps) !== digestUnknown(raw.userOps)) {
      throw new AppError(
        'UA_PROVIDER_SCHEMA_INVALID',
        'Particle changed the user operations selected by the fee quote.',
      );
    }
    const feeMicros = usd18ToMicros(feeQuote.fees.totals.feeTokenAmountInUSD);
    if (feeMicros > this.config.maxFeeUsdMicros) {
      throw new AppError('UA_PROVIDER_SCHEMA_INVALID', 'Particle exceeded the hard fee ceiling.');
    }
    const sourceValues =
      raw.tokenChanges.decr.length > 0 ? raw.tokenChanges.decr : raw.depositTokens;
    if (sourceValues.length === 0) {
      throw new AppError('UA_PROVIDER_SCHEMA_INVALID', 'Particle omitted source assets.');
    }
    assertReviewedSourceCalls(raw, sourceValues, this.config.sourceCallProfiles ?? []);
    const sources = sourceValues.map((entry) => {
      const chainId = ChainIdSchema.parse(entry.token.chainId.toString());
      const providerType = entry.token.type;
      const asset =
        providerType === 'usdc'
          ? 'USDC'
          : providerType === 'usdt'
            ? 'USDT'
            : providerType === 'eth'
              ? 'ETH'
              : undefined;
      const tokenAddress = EvmAddressSchema.safeParse(entry.token.address);
      const exactTokenAllowed =
        tokenAddress.success &&
        this.config.allowedSourceTokens?.some(
          (policy) =>
            policy.chainId === chainId &&
            policy.asset === asset &&
            sameEvmAddress(policy.address, tokenAddress.data),
        );
      if (
        asset === undefined ||
        !this.config.allowedSourceChainIds.includes(chainId) ||
        !this.config.allowedSourceAssets.includes(asset) ||
        (this.config.allowedSourceTokens !== undefined && !exactTokenAllowed)
      ) {
        throw new AppError(
          'UA_PROVIDER_SCHEMA_INVALID',
          'Particle selected a disallowed source asset.',
        );
      }
      return { chainId, symbol: asset, amount: entry.amount, amountUsd: entry.amountInUSD };
    });
    for (const userOp of raw.userOps) {
      const chainId = userOp.chainId.toString();
      if (
        chainId !== ARBITRUM_ONE_CHAIN_ID &&
        !this.config.allowedSourceChainIds.includes(chainId)
      ) {
        throw new AppError(
          'UA_PROVIDER_SCHEMA_INVALID',
          'Particle added a disallowed source chain.',
        );
      }
      if (userOp.eip7702Auth !== undefined && !userOp.eip7702Delegated) {
        throw new AppError(
          'UA_DELEGATION_REQUIRED',
          'Explicit EIP-7702 readiness is required first.',
        );
      }
    }
    const amountMicros = cached.amountBaseUnits ?? 0n;
    const quote = QuotePreviewSchema.parse({
      amountBaseUnits: BaseUnitAmountSchema.parse(amountMicros.toString()),
      estimatedFeeUsd: formatUsdMicros(feeMicros),
      totalUsd: formatUsdMicros(amountMicros + feeMicros),
      slippageBps: raw.tokenChanges.slippage.toString(),
      sources,
      quotedAt: raw.quotedAt,
      expiresAt: prepared.expiresAt,
    });
    const now = this.config.now?.() ?? new Date();
    if (new Date(prepared.expiresAt).getTime() <= now.getTime()) {
      throw new AppError('UA_QUOTE_EXPIRED', 'The Particle route expired before approval.');
    }
    return ValidatedOperationPlanSchema.parse({
      planId: digestUnknown({
        rootHash: prepared.rootHash,
        bindingDigest: template.bindingDigest,
        quote,
      }),
      template,
      rootHash: prepared.rootHash,
      quote,
      validatedAt: now.toISOString(),
      expiresAt: prepared.expiresAt,
    });
  }

  async submitValidated(input: {
    plan: ValidatedOperationPlan;
    rootSignature: string;
  }): Promise<ProviderOperation> {
    const plan = ValidatedOperationPlanSchema.parse(input.plan);
    const cached = this.#prepared.get(plan.rootHash);
    if (cached === undefined || cached.template.bindingDigest !== plan.template.bindingDigest) {
      throw new AppError(
        'OPERATION_PLAN_INVALID',
        'The validated Particle route is no longer available.',
      );
    }
    if (!/^0x[0-9a-fA-F]+$/.test(input.rootSignature)) {
      throw new AppError('UA_SIGNATURE_REJECTED', 'The Particle signature is invalid.');
    }
    const recovered = EvmAddressSchema.parse(
      verifyMessage(getBytes(plan.rootHash), input.rootSignature),
    );
    if (!sameEvmAddress(recovered, this.config.ownerAddress)) {
      throw new AppError('UA_SIGNATURE_REJECTED', 'The Particle signature owner is invalid.');
    }
    if (new Date(plan.expiresAt).getTime() <= (this.config.now?.() ?? new Date()).getTime()) {
      throw new AppError('UA_QUOTE_EXPIRED', 'The Particle route expired before submission.');
    }

    try {
      const raw = await this.sdk.sendTransaction(cached.raw, input.rootSignature);
      const result = SubmissionResponseSchema.parse(raw);
      // SDK 2.0.3 sends `cached.raw.transactionId` as the first
      // universal_sendTransaction parameter. A different response ID cannot
      // be correlated safely and must never replace the pre-persisted ID.
      if (result.transactionId !== cached.raw.transactionId) {
        throw new AppError(
          'UA_PROVIDER_SCHEMA_INVALID',
          'Particle returned a different transaction identifier.',
        );
      }
      const now = this.config.now?.() ?? new Date();
      this.#prepared.delete(plan.rootHash);
      return ProviderOperationSchema.parse({
        id: ProviderOperationIdSchema.parse(result.transactionId),
        status: result.status === undefined ? 'preparing' : statusName(result.status),
        submissionPossible: true,
        activityUrl: universalXActivityUrl(result.transactionId),
        updatedAt: result.updated_at ?? now.toISOString(),
        evidence: adapterEvidence({
          adapter: 'particle-send-transaction',
          packageVersion: PARTICLE_PACKAGE_VERSION,
          schemaVersion: 1,
          environment: this.config.environment,
          observedAt: now,
          payload: raw,
          provenance: this.config.responseProfile.provenance,
        }),
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw mapParticleError(error, 'UA_SUBMISSION_FAILED', {
        submissionPossible: true,
        retryable: false,
      });
    }
  }

  async getOperation(idInput: ProviderOperationId): Promise<ProviderOperation> {
    const id = ProviderOperationIdSchema.parse(idInput);
    try {
      const raw = await this.sdk.getTransaction(id);
      const result = TransactionStatusResponseSchema.parse(raw);
      if (result.transactionId !== id) {
        throw new AppError('UA_PROVIDER_SCHEMA_INVALID', 'Particle returned another transaction.');
      }
      const now = this.config.now?.() ?? new Date();
      return ProviderOperationSchema.parse({
        id,
        status: statusName(result.status),
        submissionPossible: true,
        ...(result.destinationTransactionHash === undefined && result.transactionHash === undefined
          ? {}
          : {
              destinationTransactionHash:
                result.destinationTransactionHash ?? result.transactionHash,
            }),
        activityUrl: universalXActivityUrl(id),
        updatedAt: result.updated_at,
        evidence: adapterEvidence({
          adapter: 'particle-get-transaction',
          packageVersion: PARTICLE_PACKAGE_VERSION,
          schemaVersion: 1,
          environment: this.config.environment,
          observedAt: now,
          payload: raw,
          provenance: this.config.responseProfile.provenance,
        }),
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw mapParticleError(error, 'UA_STATUS_UNKNOWN', {
        submissionPossible: true,
        retryable: true,
      });
    }
  }

  #remember(rootHash: string, value: CachedPrepared): void {
    if (this.#prepared.size >= 20) {
      const oldest = this.#prepared.keys().next().value;
      if (typeof oldest === 'string') this.#prepared.delete(oldest);
    }
    this.#prepared.set(rootHash, value);
  }
}

export function createParticleUniversalAccountAdapter(
  config: ParticleAdapterConfig,
): ParticleUniversalAccountAdapter {
  validateParticleAdapterPolicy(config);
  for (const [name, value] of [
    ['projectId', config.projectId],
    ['projectClientKey', config.projectClientKey],
    ['projectAppUuid', config.projectAppUuid],
  ] as const) {
    if (!value || /REPLACE|EXAMPLE|CHANGE_ME/i.test(value)) {
      throw new AppError('UA_CONFIGURATION_INVALID', `Particle ${name} is not configured.`);
    }
  }
  if (config.rpcUrl !== undefined) {
    let url: URL;
    try {
      url = new URL(config.rpcUrl);
    } catch (error) {
      throw new AppError('UA_CONFIGURATION_INVALID', 'Particle RPC URL is invalid.', {
        cause: error,
      });
    }
    const local = ['local', 'test'].includes(config.environment);
    if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
      throw new AppError('UA_CONFIGURATION_INVALID', 'Particle RPC URL must use HTTPS.');
    }
    if (url.username || url.password) {
      throw new AppError(
        'UA_CONFIGURATION_INVALID',
        'Particle RPC credentials cannot be embedded in a URL.',
      );
    }
  }
  const sdk = new UniversalAccount({
    projectId: config.projectId,
    projectClientKey: config.projectClientKey,
    projectAppUuid: config.projectAppUuid,
    smartAccountOptions: {
      name: 'UNIVERSAL',
      version: UNIVERSAL_ACCOUNT_VERSION,
      ownerAddress: config.ownerAddress,
      useEIP7702: true,
    },
    tradeConfig: {
      slippageBps: config.slippageBps,
      preferTokenType: PREFER_TOKEN_TYPE.USD,
      usePrimaryTokens: allowedTokenTypes(config),
    },
    ...(config.rpcUrl === undefined ? {} : { rpcUrl: config.rpcUrl }),
  });
  return new ParticleUniversalAccountAdapter(sdk as unknown as ParticleSdkLike, config);
}
