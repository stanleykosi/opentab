import type { LiveAcceptanceEvidenceInput } from '@opentab/shared';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

const createdAt = timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();
const amount = (name: string) => numeric(name, { precision: 78, scale: 0, mode: 'string' });
const evmAddress = (name: string) => varchar(name, { length: 42 });
const digest = (name: string) => varchar(name, { length: 66 });
const opaqueId = (name: string) => varchar(name, { length: 40 });

export const userStatusEnum = pgEnum('user_status', ['active', 'suspended', 'closed']);
export const authProviderEnum = pgEnum('auth_provider', ['magic']);
export const authMethodEnum = pgEnum('auth_method', ['google', 'email_otp']);
export const merchantStatusEnum = pgEnum('merchant_status', [
  'draft',
  'pending',
  'active',
  'paused',
  'archived',
]);
export const merchantRoleEnum = pgEnum('merchant_role', ['owner', 'admin', 'operator', 'viewer']);
export const productStatusEnum = pgEnum('product_status', [
  'draft',
  'publishing',
  'scheduled',
  'active',
  'paused',
  'sold_out',
  'ended',
  'archived',
]);
export const chainSyncStatusEnum = pgEnum('chain_sync_status', [
  'not_required',
  'pending',
  'submitted',
  'confirmed',
  'mismatch',
  'failed',
]);
export const checkoutSessionStatusEnum = pgEnum('checkout_session_status', [
  'active',
  'bound',
  'consumed',
  'expired',
  'cancelled',
]);
export const orderStatusEnum = pgEnum('order_status', [
  'created',
  'submitted',
  'executing',
  'paid',
  'partially_refunded',
  'refunded',
  'failed_confirmed',
  'mismatch',
  'orphaned',
]);
export const paymentAttemptStatusEnum = pgEnum('payment_attempt_status', [
  'created',
  'prepared',
  'submission_started',
  'submitted',
  'submitted_unknown',
  'executing',
  'confirming',
  'paid',
  'failed_pre_submission',
  'failed_confirmed',
  'expired',
]);
export const providerOperationStatusEnum = pgEnum('provider_operation_status', [
  'preparing',
  'moving_funds',
  'executing',
  'succeeded',
  'failed',
  'refunding',
  'refunded',
  'unknown',
]);
export const delegationStatusEnum = pgEnum('delegation_status', [
  'unknown',
  'required',
  'submitted',
  'confirmed',
  'mismatch',
  'revoked',
]);
export const sponsorGrantStatusEnum = pgEnum('sponsor_grant_status', [
  'created',
  'submission_started',
  'submitted',
  'submitted_unknown',
  'confirmed',
  'failed',
  'replaced',
  'orphaned',
]);
export const receiptStatusEnum = pgEnum('receipt_status', [
  'expected',
  'issued',
  'revoked',
  'orphaned',
]);
export const refundStatusEnum = pgEnum('refund_status', [
  'created',
  'prepared',
  'submission_started',
  'submitted',
  'submitted_unknown',
  'confirming',
  'confirmed',
  'failed',
  'mismatch',
  'orphaned',
]);
export const creditStatusEnum = pgEnum('settlement_credit_status', [
  'refundable',
  'matured',
  'withdrawn',
  'orphaned',
]);
export const withdrawalStatusEnum = pgEnum('withdrawal_status', [
  'created',
  'prepared',
  'submission_started',
  'submitted',
  'submitted_unknown',
  'confirming',
  'confirmed',
  'failed',
  'mismatch',
  'orphaned',
]);
export const splitStatusEnum = pgEnum('split_status', [
  'active',
  'partially_paid',
  'revoking',
  'complete',
  'expired',
  'revoked',
]);
export const splitInvitationStatusEnum = pgEnum('split_invitation_status', [
  'unpaid',
  'submission_started',
  'submitted_unknown',
  'confirming',
  'paid',
  'expired',
  'revoked',
]);
export const splitPaymentStatusEnum = pgEnum('split_payment_status', [
  'unpaid',
  'submission_started',
  'submitted_unknown',
  'confirming',
  'paid',
  'failed',
  'orphaned',
  'revoked',
]);
export const idempotencyStatusEnum = pgEnum('idempotency_status', [
  'in_progress',
  'completed',
  'failed_retryable',
  'failed_terminal',
]);
export const jobStatusEnum = pgEnum('job_status', [
  'scheduled',
  'running',
  'completed',
  'retrying',
  'dead',
  'cancelled',
]);
export const featureFlagEnvironmentEnum = pgEnum('feature_flag_environment', [
  'local',
  'test',
  'preview',
  'staging',
  'demo-mainnet',
  'production',
]);

export const users = pgTable(
  'users',
  {
    id: opaqueId('id').primaryKey(),
    magicIssuerHash: digest('magic_issuer_hash').notNull(),
    walletAddressChecksum: evmAddress('wallet_address_checksum').notNull(),
    walletAddressLower: evmAddress('wallet_address_lower').notNull(),
    emailCiphertext: text('email_ciphertext'),
    emailHash: digest('email_hash'),
    status: userStatusEnum('status').notNull().default('active'),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex('users_magic_issuer_hash_unique').on(table.magicIssuerHash),
    uniqueIndex('users_wallet_address_lower_unique').on(table.walletAddressLower),
    check(
      'users_wallet_lowercase_check',
      sql`${table.walletAddressLower} = lower(${table.walletAddressLower})`,
    ),
  ],
);

export const userIdentities = pgTable(
  'user_identities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: opaqueId('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    provider: authProviderEnum('provider').notNull(),
    providerSubjectHash: digest('provider_subject_hash').notNull(),
    authMethod: authMethodEnum('auth_method').notNull(),
    evidenceDigest: digest('evidence_digest').notNull(),
    lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }).notNull(),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex('user_identities_provider_subject_unique').on(
      table.provider,
      table.providerSubjectHash,
    ),
    index('user_identities_user_idx').on(table.userId),
  ],
);

export const serverSessions = pgTable(
  'server_sessions',
  {
    id: opaqueId('id').primaryKey(),
    userId: opaqueId('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    tokenHash: digest('token_hash').notNull(),
    tokenHashVersion: integer('token_hash_version').notNull().default(1),
    csrfTokenHash: digest('csrf_token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    userAgentHash: digest('user_agent_hash'),
    ipPrefixHash: digest('ip_prefix_hash'),
    createdAt,
  },
  (table) => [
    uniqueIndex('server_sessions_token_hash_unique').on(table.tokenHash),
    index('server_sessions_user_expiry_idx').on(table.userId, table.expiresAt),
  ],
);

export const walletAccounts = pgTable(
  'wallet_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: opaqueId('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    environment: featureFlagEnvironmentEnum('environment').notNull(),
    ownerAddressLower: evmAddress('owner_address_lower').notNull(),
    universalAccountAddressLower: evmAddress('universal_account_address_lower').notNull(),
    solanaAddress: varchar('solana_address', { length: 80 }),
    sdkPackageVersion: varchar('sdk_package_version', { length: 40 }).notNull(),
    protocolVersion: varchar('protocol_version', { length: 40 }).notNull(),
    eip7702Enabled: boolean('eip7702_enabled').notNull(),
    delegationStatus: delegationStatusEnum('delegation_status').notNull().default('unknown'),
    arbitrumImplementation: evmAddress('arbitrum_implementation'),
    delegationTransactionHash: digest('delegation_transaction_hash'),
    checkedAt: timestamp('checked_at', { withTimezone: true }).notNull(),
    evidenceDigest: digest('evidence_digest').notNull(),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex('wallet_accounts_user_environment_unique').on(table.userId, table.environment),
    check('wallet_accounts_eip7702_required_check', sql`${table.eip7702Enabled} = true`),
  ],
);

export const merchants = pgTable(
  'merchants',
  {
    id: opaqueId('id').primaryKey(),
    onchainMerchantId: numeric('onchain_merchant_id', { precision: 78, scale: 0, mode: 'string' }),
    ownerUserId: opaqueId('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    slug: varchar('slug', { length: 80 }).notNull(),
    displayName: varchar('display_name', { length: 100 }).notNull(),
    supportContact: varchar('support_contact', { length: 200 }),
    payoutAddress: evmAddress('payout_address').notNull(),
    payoutAddressLower: evmAddress('payout_address_lower').notNull(),
    profile: jsonb('profile').$type<Record<string, string>>().notNull().default({}),
    status: merchantStatusEnum('status').notNull().default('draft'),
    chainSyncStatus: chainSyncStatusEnum('chain_sync_status').notNull().default('pending'),
    version: integer('version').notNull().default(1),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex('merchants_slug_unique').on(table.slug),
    uniqueIndex('merchants_onchain_id_unique').on(table.onchainMerchantId),
    index('merchants_owner_idx').on(table.ownerUserId),
    check('merchants_version_positive_check', sql`${table.version} > 0`),
  ],
);

export const merchantMembers = pgTable(
  'merchant_members',
  {
    merchantId: opaqueId('merchant_id')
      .notNull()
      .references(() => merchants.id, { onDelete: 'restrict' }),
    userId: opaqueId('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    role: merchantRoleEnum('role').notNull(),
    invitedByUserId: opaqueId('invited_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (table) => [
    primaryKey({ columns: [table.merchantId, table.userId] }),
    index('merchant_members_user_idx').on(table.userId),
  ],
);

export const products = pgTable(
  'products',
  {
    id: opaqueId('id').primaryKey(),
    merchantId: opaqueId('merchant_id')
      .notNull()
      .references(() => merchants.id, { onDelete: 'restrict' }),
    onchainProductId: numeric('onchain_product_id', { precision: 78, scale: 0, mode: 'string' }),
    version: integer('version').notNull().default(1),
    slug: varchar('slug', { length: 100 }).notNull(),
    title: varchar('title', { length: 140 }).notNull(),
    description: text('description').notNull(),
    imageUrl: text('image_url'),
    unitPriceBaseUnits: amount('unit_price_base_units').notNull(),
    currencyCode: varchar('currency_code', { length: 12 }).notNull().default('USDC'),
    maxSupply: amount('max_supply'),
    sold: amount('sold').notNull().default('0'),
    maxPerOrder: amount('max_per_order').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    refundWindowSeconds: amount('refund_window_seconds').notNull().default('0'),
    loyaltyPoints: amount('loyalty_points').notNull().default('0'),
    metadataHash: digest('metadata_hash').notNull(),
    metadata: jsonb('metadata').$type<Record<string, string>>().notNull().default({}),
    status: productStatusEnum('status').notNull().default('draft'),
    chainSyncStatus: chainSyncStatusEnum('chain_sync_status').notNull().default('pending'),
    sourceBlockNumber: bigint('source_block_number', { mode: 'bigint' }),
    sourceBlockHash: digest('source_block_hash'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex('products_merchant_slug_unique').on(table.merchantId, table.slug),
    uniqueIndex('products_onchain_id_unique').on(table.onchainProductId),
    index('products_merchant_status_idx').on(table.merchantId, table.status),
    check('products_price_nonnegative_check', sql`${table.unitPriceBaseUnits} >= 0`),
    check(
      'products_supply_nonnegative_check',
      sql`${table.maxSupply} is null or ${table.maxSupply} >= 0`,
    ),
    check('products_sold_nonnegative_check', sql`${table.sold} >= 0`),
    check(
      'products_supply_bounds_check',
      sql`${table.maxSupply} is null or ${table.sold} <= ${table.maxSupply}`,
    ),
    check('products_version_positive_check', sql`${table.version} > 0`),
    check(
      'products_window_check',
      sql`${table.endsAt} is null or ${table.endsAt} > ${table.startsAt}`,
    ),
  ],
);

export const productRevisions = pgTable(
  'product_revisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    productId: opaqueId('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    version: integer('version').notNull(),
    changedByUserId: opaqueId('changed_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    snapshot: jsonb('snapshot').$type<Record<string, unknown>>().notNull(),
    changeDigest: digest('change_digest').notNull(),
    createdAt,
  },
  (table) => [
    uniqueIndex('product_revisions_product_version_unique').on(table.productId, table.version),
  ],
);

export const checkoutLinks = pgTable(
  'checkout_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    productId: opaqueId('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    capabilityHash: digest('capability_hash').notNull(),
    campaign: varchar('campaign', { length: 100 }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdByUserId: opaqueId('created_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt,
  },
  (table) => [
    uniqueIndex('checkout_links_capability_hash_unique').on(table.capabilityHash),
    index('checkout_links_product_idx').on(table.productId),
  ],
);

export const checkoutSessions = pgTable(
  'checkout_sessions',
  {
    id: opaqueId('id').primaryKey(),
    publicCapabilityHash: digest('public_capability_hash'),
    userId: opaqueId('user_id').references(() => users.id, { onDelete: 'restrict' }),
    productId: opaqueId('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    productVersion: integer('product_version').notNull(),
    quantity: amount('quantity').notNull(),
    receiptRecipient: evmAddress('receipt_recipient'),
    amountBaseUnits: amount('amount_base_units').notNull(),
    orderKey: digest('order_key').notNull(),
    status: checkoutSessionStatusEnum('status').notNull().default('active'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    bindingDigest: digest('binding_digest'),
    version: integer('version').notNull().default(1),
    boundAt: timestamp('bound_at', { withTimezone: true }),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex('checkout_sessions_order_key_unique').on(table.orderKey),
    index('checkout_sessions_user_status_idx').on(table.userId, table.status),
    check('checkout_sessions_amount_positive_check', sql`${table.amountBaseUnits} > 0`),
    check('checkout_sessions_quantity_positive_check', sql`${table.quantity} > 0`),
  ],
);

export const signedOrderIntents = pgTable(
  'signed_order_intents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    checkoutSessionId: opaqueId('checkout_session_id')
      .notNull()
      .references(() => checkoutSessions.id, { onDelete: 'restrict' }),
    orderKey: digest('order_key').notNull(),
    digest: digest('digest').notNull(),
    signerAddress: evmAddress('signer_address').notNull(),
    signerKeyId: varchar('signer_key_id', { length: 80 }).notNull(),
    intent: jsonb('intent').$type<Record<string, string>>().notNull(),
    signature: text('signature').notNull(),
    validAfter: timestamp('valid_after', { withTimezone: true }).notNull(),
    validUntil: timestamp('valid_until', { withTimezone: true }).notNull(),
    refundableUntil: timestamp('refundable_until', { withTimezone: true }).notNull(),
    createdAt,
  },
  (table) => [
    uniqueIndex('signed_order_intents_order_key_unique').on(table.orderKey),
    uniqueIndex('signed_order_intents_digest_unique').on(table.digest),
    check(
      'signed_order_intents_valid_window_check',
      sql`${table.validUntil} > ${table.validAfter}`,
    ),
  ],
);

export const orders = pgTable(
  'orders',
  {
    id: opaqueId('id').primaryKey(),
    checkoutSessionId: opaqueId('checkout_session_id')
      .notNull()
      .references(() => checkoutSessions.id, { onDelete: 'restrict' }),
    orderKey: digest('order_key').notNull(),
    userId: opaqueId('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    merchantId: opaqueId('merchant_id')
      .notNull()
      .references(() => merchants.id, { onDelete: 'restrict' }),
    productId: opaqueId('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    payer: evmAddress('payer').notNull(),
    recipient: evmAddress('recipient').notNull(),
    tokenAddress: evmAddress('token_address').notNull(),
    quantity: amount('quantity').notNull(),
    amountBaseUnits: amount('amount_base_units').notNull(),
    paidAmountBaseUnits: amount('paid_amount_base_units').notNull().default('0'),
    refundedAmountBaseUnits: amount('refunded_amount_base_units').notNull().default('0'),
    status: orderStatusEnum('status').notNull().default('created'),
    chainId: amount('chain_id').notNull(),
    transactionHash: digest('transaction_hash'),
    blockNumber: bigint('block_number', { mode: 'bigint' }),
    blockHash: digest('block_hash'),
    logIndex: integer('log_index'),
    providerOperationId: varchar('provider_operation_id', { length: 256 }),
    intentDigest: digest('intent_digest').notNull(),
    refundableUntil: timestamp('refundable_until', { withTimezone: true }).notNull(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    version: integer('version').notNull().default(1),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex('orders_checkout_session_unique').on(table.checkoutSessionId),
    uniqueIndex('orders_order_key_unique').on(table.orderKey),
    uniqueIndex('orders_provider_operation_unique').on(table.providerOperationId),
    uniqueIndex('orders_chain_log_unique').on(table.chainId, table.transactionHash, table.logIndex),
    index('orders_user_created_idx').on(table.userId, table.createdAt),
    index('orders_merchant_created_idx').on(table.merchantId, table.createdAt),
    check('orders_amount_positive_check', sql`${table.amountBaseUnits} > 0`),
    check(
      'orders_paid_bounds_check',
      sql`${table.paidAmountBaseUnits} >= 0 and ${table.paidAmountBaseUnits} <= ${table.amountBaseUnits}`,
    ),
    check(
      'orders_refund_bounds_check',
      sql`${table.refundedAmountBaseUnits} >= 0 and ${table.refundedAmountBaseUnits} <= ${table.paidAmountBaseUnits}`,
    ),
    check(
      'orders_paid_proof_check',
      sql`${table.status} not in ('paid', 'partially_refunded', 'refunded') or (${table.transactionHash} is not null and ${table.blockNumber} is not null and ${table.blockHash} is not null and ${table.logIndex} is not null and ${table.confirmedAt} is not null)`,
    ),
  ],
);

export const paymentAttempts = pgTable(
  'payment_attempts',
  {
    id: opaqueId('id').primaryKey(),
    orderId: opaqueId('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    checkoutSessionId: opaqueId('checkout_session_id')
      .notNull()
      .references(() => checkoutSessions.id, { onDelete: 'restrict' }),
    attemptNumber: integer('attempt_number').notNull(),
    status: paymentAttemptStatusEnum('status').notNull().default('created'),
    bindingDigest: digest('binding_digest').notNull(),
    preparedRootHashDigest: digest('prepared_root_hash_digest'),
    previewDigest: digest('preview_digest'),
    quoteSummary: jsonb('quote_summary').$type<Record<string, unknown>>(),
    preparedExpiresAt: timestamp('prepared_expires_at', { withTimezone: true }),
    providerOperationId: varchar('provider_operation_id', { length: 256 }),
    destinationTransactionHash: digest('destination_transaction_hash'),
    submissionStartedAt: timestamp('submission_started_at', { withTimezone: true }),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    terminalAt: timestamp('terminal_at', { withTimezone: true }),
    errorCode: varchar('error_code', { length: 80 }),
    vendorCode: varchar('vendor_code', { length: 100 }),
    reconciliationRequired: boolean('reconciliation_required').notNull().default(false),
    version: integer('version').notNull().default(1),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex('payment_attempts_order_number_unique').on(table.orderId, table.attemptNumber),
    uniqueIndex('payment_attempts_one_active_per_order_unique')
      .on(table.orderId)
      .where(
        sql`${table.status} in ('created','prepared','submission_started','submitted','submitted_unknown','executing','confirming')`,
      ),
    uniqueIndex('payment_attempts_provider_operation_unique').on(table.providerOperationId),
    index('payment_attempts_reconciliation_idx').on(table.reconciliationRequired, table.updatedAt),
    check('payment_attempts_number_positive_check', sql`${table.attemptNumber} > 0`),
    check(
      'payment_attempts_submission_boundary_check',
      sql`${table.status} not in ('submission_started','submitted','submitted_unknown','executing','confirming','paid') or ${table.submissionStartedAt} is not null`,
    ),
  ],
);

export const providerOperations = pgTable(
  'provider_operations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    provider: varchar('provider', { length: 40 }).notNull(),
    externalId: varchar('external_id', { length: 256 }).notNull(),
    paymentAttemptId: opaqueId('payment_attempt_id').references(() => paymentAttempts.id, {
      onDelete: 'restrict',
    }),
    kind: varchar('kind', { length: 40 }).notNull(),
    status: providerOperationStatusEnum('status').notNull(),
    submissionPossible: boolean('submission_possible').notNull(),
    destinationTransactionHash: digest('destination_transaction_hash'),
    activityUrl: text('activity_url'),
    evidenceDigest: digest('evidence_digest').notNull(),
    safeSummary: jsonb('safe_summary').$type<Record<string, string>>().notNull().default({}),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex('provider_operations_provider_external_unique').on(
      table.provider,
      table.externalId,
    ),
    index('provider_operations_attempt_idx').on(table.paymentAttemptId),
  ],
);

export const delegationRecords = pgTable(
  'delegation_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: opaqueId('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    environment: featureFlagEnvironmentEnum('environment').notNull(),
    chainId: amount('chain_id').notNull(),
    ownerAddressLower: evmAddress('owner_address_lower').notNull(),
    implementationAddressLower: evmAddress('implementation_address_lower').notNull(),
    implementationCodeHash: digest('implementation_code_hash').notNull(),
    status: delegationStatusEnum('status').notNull(),
    transactionHash: digest('transaction_hash'),
    blockNumber: bigint('block_number', { mode: 'bigint' }),
    blockHash: digest('block_hash'),
    evidenceDigest: digest('evidence_digest').notNull(),
    checkedAt: timestamp('checked_at', { withTimezone: true }).notNull(),
    createdAt,
    updatedAt,
  },
  (table) => [
    index('delegation_records_user_chain_idx').on(table.userId, table.chainId),
    uniqueIndex('delegation_records_transaction_unique').on(table.transactionHash),
    uniqueIndex('delegation_records_transaction_lower_unique').on(
      sql`lower(${table.transactionHash})`,
    ),
  ],
);

export const sponsorEligibility = pgTable(
  'sponsor_eligibility',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: opaqueId('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    recipientAddressLower: evmAddress('recipient_address_lower').notNull(),
    eligible: boolean('eligible').notNull(),
    reason: varchar('reason', { length: 80 }).notNull(),
    balanceBucket: varchar('balance_bucket', { length: 40 }).notNull(),
    riskDecisionHash: digest('risk_decision_hash'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt,
  },
  (table) => [
    index('sponsor_eligibility_user_recipient_idx').on(
      table.userId,
      table.recipientAddressLower,
      table.createdAt,
    ),
  ],
);

export const bootstrapGrants = pgTable(
  'bootstrap_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    environment: featureFlagEnvironmentEnum('environment').notNull(),
    userId: opaqueId('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    magicIssuerHash: digest('magic_issuer_hash').notNull(),
    recipientAddressLower: evmAddress('recipient_address_lower').notNull(),
    idempotencyKeyHash: digest('idempotency_key_hash').notNull(),
    eligibilityReason: varchar('eligibility_reason', { length: 80 }).notNull(),
    balanceBeforeWei: amount('balance_before_wei').notNull(),
    targetWei: amount('target_wei').notNull(),
    amountWei: amount('amount_wei').notNull(),
    status: sponsorGrantStatusEnum('status').notNull(),
    sponsorSignerAddressLower: evmAddress('sponsor_signer_address_lower'),
    transactionHash: digest('transaction_hash'),
    transactionHashCandidates: text('transaction_hash_candidates')
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    signerNonce: amount('signer_nonce'),
    blockNumber: bigint('block_number', { mode: 'bigint' }),
    blockHash: digest('block_hash'),
    riskDecisionId: uuid('risk_decision_id'),
    errorCode: varchar('error_code', { length: 80 }),
    submissionStartedAt: timestamp('submission_started_at', { withTimezone: true }),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex('bootstrap_grants_idempotency_unique').on(
      table.environment,
      table.userId,
      table.idempotencyKeyHash,
    ),
    uniqueIndex('bootstrap_grants_one_recipient_unique').on(
      table.environment,
      table.recipientAddressLower,
    ),
    uniqueIndex('bootstrap_grants_transaction_unique').on(table.transactionHash),
    uniqueIndex('bootstrap_grants_signer_nonce_unique')
      .on(table.environment, table.sponsorSignerAddressLower, table.signerNonce)
      .where(
        sql`${table.sponsorSignerAddressLower} is not null and ${table.signerNonce} is not null`,
      ),
    index('bootstrap_grants_recipient_created_idx').on(
      table.recipientAddressLower,
      table.createdAt,
    ),
    check('bootstrap_grants_amount_positive_check', sql`${table.amountWei} > 0`),
    check('bootstrap_grants_amount_target_check', sql`${table.amountWei} <= ${table.targetWei}`),
    check(
      'bootstrap_grants_submission_boundary_check',
      sql`${table.status}::text <> 'submission_started' or (${table.sponsorSignerAddressLower} is not null and ${table.signerNonce} is not null and ${table.submissionStartedAt} is not null)`,
    ),
    check(
      'bootstrap_grants_transaction_candidates_check',
      sql`cardinality(${table.transactionHashCandidates}) <= 4 and (${table.transactionHash} is null or ${table.transactionHash} = any(${table.transactionHashCandidates}))`,
    ),
  ],
);

export const sponsorBudgets = pgTable(
  'sponsor_budgets',
  {
    environment: featureFlagEnvironmentEnum('environment').notNull(),
    budgetDate: varchar('budget_date', { length: 10 }).notNull(),
    scope: varchar('scope', { length: 40 }).notNull(),
    subjectHash: digest('subject_hash').notNull(),
    grantedWei: amount('granted_wei').notNull().default('0'),
    grantCount: integer('grant_count').notNull().default(0),
    version: integer('version').notNull().default(1),
    updatedAt,
  },
  (table) => [
    primaryKey({ columns: [table.environment, table.budgetDate, table.scope, table.subjectHash] }),
    check(
      'sponsor_budgets_nonnegative_check',
      sql`${table.grantedWei} >= 0 and ${table.grantCount} >= 0`,
    ),
  ],
);

export const sponsorAuditEvents = pgTable(
  'sponsor_audit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    grantId: uuid('grant_id').references(() => bootstrapGrants.id, { onDelete: 'restrict' }),
    userId: opaqueId('user_id').references(() => users.id, { onDelete: 'restrict' }),
    action: varchar('action', { length: 80 }).notNull(),
    decision: varchar('decision', { length: 80 }).notNull(),
    requestId: varchar('request_id', { length: 64 }).notNull(),
    safeMetadata: jsonb('safe_metadata').$type<Record<string, string>>().notNull().default({}),
    createdAt,
  },
  (table) => [index('sponsor_audit_events_grant_idx').on(table.grantId, table.createdAt)],
);

export const chainTransactions = pgTable(
  'chain_transactions',
  {
    chainId: amount('chain_id').notNull(),
    transactionHash: digest('transaction_hash').notNull(),
    fromAddress: evmAddress('from_address'),
    toAddress: evmAddress('to_address'),
    status: varchar('status', { length: 24 }).notNull(),
    blockNumber: bigint('block_number', { mode: 'bigint' }),
    blockHash: digest('block_hash'),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    createdAt,
    updatedAt,
  },
  (table) => [primaryKey({ columns: [table.chainId, table.transactionHash] })],
);

export const chainReceipts = pgTable(
  'chain_receipts',
  {
    chainId: amount('chain_id').notNull(),
    transactionHash: digest('transaction_hash').notNull(),
    blockNumber: bigint('block_number', { mode: 'bigint' }).notNull(),
    blockHash: digest('block_hash').notNull(),
    success: boolean('success').notNull(),
    gasUsed: amount('gas_used').notNull(),
    effectiveGasPrice: amount('effective_gas_price').notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.chainId, table.transactionHash] })],
);

export const indexedBlocks = pgTable(
  'indexed_blocks',
  {
    chainId: amount('chain_id').notNull(),
    stream: varchar('stream', { length: 80 }).notNull(),
    blockNumber: bigint('block_number', { mode: 'bigint' }).notNull(),
    blockHash: digest('block_hash').notNull(),
    parentHash: digest('parent_hash').notNull(),
    canonical: boolean('canonical').notNull().default(true),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    orphanedAt: timestamp('orphaned_at', { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.chainId, table.stream, table.blockNumber, table.blockHash] }),
    index('indexed_blocks_canonical_idx').on(
      table.chainId,
      table.stream,
      table.blockNumber,
      table.canonical,
    ),
  ],
);

export const indexerCursors = pgTable(
  'indexer_cursors',
  {
    chainId: amount('chain_id').notNull(),
    stream: varchar('stream', { length: 80 }).notNull(),
    nextBlock: bigint('next_block', { mode: 'bigint' }).notNull(),
    lastProcessedBlock: bigint('last_processed_block', { mode: 'bigint' }),
    lastProcessedBlockHash: digest('last_processed_block_hash'),
    confirmationDepth: integer('confirmation_depth').notNull(),
    leaseOwner: varchar('lease_owner', { length: 100 }),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    version: integer('version').notNull().default(1),
    updatedAt,
  },
  (table) => [
    primaryKey({ columns: [table.chainId, table.stream] }),
    check(
      'indexer_cursors_nonnegative_check',
      sql`${table.nextBlock} >= 0 and ${table.confirmationDepth} > 0`,
    ),
  ],
);

export const canonicalLogs = pgTable(
  'canonical_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    chainId: amount('chain_id').notNull(),
    stream: varchar('stream', { length: 80 }).notNull(),
    contractAddress: evmAddress('contract_address').notNull(),
    eventName: varchar('event_name', { length: 80 }).notNull(),
    transactionHash: digest('transaction_hash').notNull(),
    blockNumber: bigint('block_number', { mode: 'bigint' }).notNull(),
    blockHash: digest('block_hash').notNull(),
    logIndex: integer('log_index').notNull(),
    canonical: boolean('canonical').notNull().default(true),
    decodedPayload: jsonb('decoded_payload').$type<Record<string, unknown>>().notNull(),
    payloadDigest: digest('payload_digest').notNull(),
    projectionStatus: varchar('projection_status', { length: 40 }).notNull().default('pending'),
    mismatchCode: varchar('mismatch_code', { length: 80 }),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    projectedAt: timestamp('projected_at', { withTimezone: true }),
    orphanedAt: timestamp('orphaned_at', { withTimezone: true }),
    createdAt,
  },
  (table) => [
    uniqueIndex('canonical_logs_log_identity_unique').on(
      table.chainId,
      table.transactionHash,
      table.logIndex,
      table.blockHash,
    ),
    uniqueIndex('canonical_logs_one_canonical_identity_unique')
      .on(table.chainId, table.contractAddress, table.transactionHash, table.logIndex)
      .where(sql`${table.canonical} = true`),
    index('canonical_logs_block_idx').on(
      table.chainId,
      table.stream,
      table.blockNumber,
      table.canonical,
    ),
    index('canonical_logs_projection_idx').on(table.projectionStatus, table.observedAt),
  ],
);

export const chainEventQuarantine = pgTable(
  'chain_event_quarantine',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    canonicalLogId: uuid('canonical_log_id')
      .notNull()
      .references(() => canonicalLogs.id, { onDelete: 'restrict' }),
    reasonCode: varchar('reason_code', { length: 80 }).notNull(),
    safeDetails: jsonb('safe_details').$type<Record<string, string>>().notNull().default({}),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolution: varchar('resolution', { length: 80 }),
    createdAt,
  },
  (table) => [uniqueIndex('chain_event_quarantine_log_unique').on(table.canonicalLogId)],
);

export const reorgIncidents = pgTable(
  'reorg_incidents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    chainId: amount('chain_id').notNull(),
    stream: varchar('stream', { length: 80 }).notNull(),
    detectedAtBlock: bigint('detected_at_block', { mode: 'bigint' }).notNull(),
    commonAncestorBlock: bigint('common_ancestor_block', { mode: 'bigint' }).notNull(),
    depth: integer('depth').notNull(),
    oldHeadHash: digest('old_head_hash').notNull(),
    newHeadHash: digest('new_head_hash').notNull(),
    status: varchar('status', { length: 30 }).notNull(),
    detectedAt: timestamp('detected_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (table) => [check('reorg_incidents_depth_positive_check', sql`${table.depth} > 0`)],
);

export const receipts = pgTable(
  'receipts',
  {
    id: opaqueId('id').primaryKey(),
    orderId: opaqueId('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    tokenId: amount('token_id'),
    metadataUri: text('metadata_uri'),
    metadataHash: digest('metadata_hash').notNull(),
    status: receiptStatusEnum('status').notNull().default('expected'),
    chainEventId: uuid('chain_event_id').references(() => canonicalLogs.id, {
      onDelete: 'restrict',
    }),
    issuedAt: timestamp('issued_at', { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex('receipts_order_unique').on(table.orderId),
    index('receipts_token_idx').on(table.tokenId),
  ],
);

export const refunds = pgTable(
  'refunds',
  {
    id: opaqueId('id').primaryKey(),
    orderId: opaqueId('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    merchantId: opaqueId('merchant_id')
      .notNull()
      .references(() => merchants.id, { onDelete: 'restrict' }),
    requestedByUserId: opaqueId('requested_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    amountBaseUnits: amount('amount_base_units').notNull(),
    status: refundStatusEnum('status').notNull().default('created'),
    idempotencyKeyHash: digest('idempotency_key_hash').notNull(),
    providerOperationId: varchar('provider_operation_id', { length: 256 }),
    transactionHash: digest('transaction_hash'),
    blockNumber: bigint('block_number', { mode: 'bigint' }),
    blockHash: digest('block_hash'),
    logIndex: integer('log_index'),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex('refunds_idempotency_unique').on(table.merchantId, table.idempotencyKeyHash),
    uniqueIndex('refunds_chain_log_unique').on(table.transactionHash, table.logIndex),
    check('refunds_amount_positive_check', sql`${table.amountBaseUnits} > 0`),
    check(
      'refunds_confirmed_proof_check',
      sql`${table.status} <> 'confirmed' or (${table.transactionHash} is not null and ${table.blockHash} is not null and ${table.confirmedAt} is not null)`,
    ),
  ],
);

export const settlementCredits = pgTable(
  'settlement_credits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    merchantId: opaqueId('merchant_id')
      .notNull()
      .references(() => merchants.id, { onDelete: 'restrict' }),
    orderId: opaqueId('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    amountBaseUnits: amount('amount_base_units').notNull(),
    withdrawnBaseUnits: amount('withdrawn_base_units').notNull().default('0'),
    status: creditStatusEnum('status').notNull(),
    maturesAt: timestamp('matures_at', { withTimezone: true }).notNull(),
    finalizedEventId: uuid('finalized_event_id').references(() => canonicalLogs.id, {
      onDelete: 'restrict',
    }),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex('settlement_credits_order_unique').on(table.orderId),
    index('settlement_credits_merchant_status_idx').on(table.merchantId, table.status),
    check(
      'settlement_credits_bounds_check',
      sql`${table.amountBaseUnits} >= 0 and ${table.withdrawnBaseUnits} >= 0 and ${table.withdrawnBaseUnits} <= ${table.amountBaseUnits}`,
    ),
  ],
);

export const withdrawals = pgTable(
  'withdrawals',
  {
    id: opaqueId('id').primaryKey(),
    merchantId: opaqueId('merchant_id')
      .notNull()
      .references(() => merchants.id, { onDelete: 'restrict' }),
    requestedByUserId: opaqueId('requested_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    recipient: evmAddress('recipient').notNull(),
    amountBaseUnits: amount('amount_base_units').notNull(),
    status: withdrawalStatusEnum('status').notNull().default('created'),
    idempotencyKeyHash: digest('idempotency_key_hash').notNull(),
    providerOperationId: varchar('provider_operation_id', { length: 256 }),
    transactionHash: digest('transaction_hash'),
    blockNumber: bigint('block_number', { mode: 'bigint' }),
    blockHash: digest('block_hash'),
    logIndex: integer('log_index'),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex('withdrawals_idempotency_unique').on(table.merchantId, table.idempotencyKeyHash),
    uniqueIndex('withdrawals_provider_operation_unique').on(table.providerOperationId),
    uniqueIndex('withdrawals_chain_log_unique').on(table.transactionHash, table.logIndex),
    check('withdrawals_amount_positive_check', sql`${table.amountBaseUnits} > 0`),
    check(
      'withdrawals_confirmed_proof_check',
      sql`${table.status} <> 'confirmed' or (${table.transactionHash} is not null and ${table.blockHash} is not null and ${table.confirmedAt} is not null)`,
    ),
  ],
);

export const loyaltyPrograms = pgTable(
  'loyalty_programs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    merchantId: opaqueId('merchant_id')
      .notNull()
      .references(() => merchants.id, { onDelete: 'restrict' }),
    name: varchar('name', { length: 100 }).notNull(),
    pointsPerBaseUnitNumerator: amount('points_per_base_unit_numerator').notNull().default('0'),
    pointsPerBaseUnitDenominator: amount('points_per_base_unit_denominator').notNull().default('1'),
    rewardThresholdPoints: amount('reward_threshold_points').notNull().default('0'),
    active: boolean('active').notNull().default(true),
    version: integer('version').notNull().default(1),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex('loyalty_programs_merchant_unique').on(table.merchantId),
    check(
      'loyalty_programs_denominator_positive_check',
      sql`${table.pointsPerBaseUnitDenominator} > 0`,
    ),
    check('loyalty_programs_threshold_nonnegative_check', sql`${table.rewardThresholdPoints} >= 0`),
  ],
);

export const loyaltyAwards = pgTable(
  'loyalty_awards',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    programId: uuid('program_id')
      .notNull()
      .references(() => loyaltyPrograms.id, { onDelete: 'restrict' }),
    userId: opaqueId('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    orderId: opaqueId('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    points: amount('points').notNull(),
    canonicalEventId: uuid('canonical_event_id')
      .notNull()
      .references(() => canonicalLogs.id, { onDelete: 'restrict' }),
    canonical: boolean('canonical').notNull().default(true),
    createdAt,
  },
  (table) => [
    uniqueIndex('loyalty_awards_order_unique').on(table.programId, table.orderId),
    check('loyalty_awards_points_nonnegative_check', sql`${table.points} >= 0`),
  ],
);

export const loyaltyBalances = pgTable(
  'loyalty_balances',
  {
    programId: uuid('program_id')
      .notNull()
      .references(() => loyaltyPrograms.id, { onDelete: 'restrict' }),
    userId: opaqueId('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    points: amount('points').notNull().default('0'),
    version: integer('version').notNull().default(1),
    updatedAt,
  },
  (table) => [
    primaryKey({ columns: [table.programId, table.userId] }),
    check('loyalty_balances_nonnegative_check', sql`${table.points} >= 0`),
  ],
);

export const splits = pgTable(
  'splits',
  {
    id: opaqueId('id').primaryKey(),
    orderId: opaqueId('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    creatorUserId: opaqueId('creator_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    beneficiary: evmAddress('beneficiary').notNull(),
    totalBaseUnits: amount('total_base_units').notNull(),
    confirmedBaseUnits: amount('confirmed_base_units').notNull().default('0'),
    status: splitStatusEnum('status').notNull().default('active'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    version: integer('version').notNull().default(1),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex('splits_order_unique').on(table.orderId),
    check('splits_total_positive_check', sql`${table.totalBaseUnits} > 0`),
    check(
      'splits_confirmed_bounds_check',
      sql`${table.confirmedBaseUnits} >= 0 and ${table.confirmedBaseUnits} <= ${table.totalBaseUnits}`,
    ),
  ],
);

export const splitParticipants = pgTable(
  'split_participants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    splitId: opaqueId('split_id')
      .notNull()
      .references(() => splits.id, { onDelete: 'restrict' }),
    label: varchar('label', { length: 60 }).notNull(),
    participantUserId: opaqueId('participant_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    amountBaseUnits: amount('amount_base_units').notNull(),
    confirmedBaseUnits: amount('confirmed_base_units').notNull().default('0'),
    createdAt,
    updatedAt,
  },
  (table) => [
    index('split_participants_split_idx').on(table.splitId),
    check(
      'split_participants_bounds_check',
      sql`${table.amountBaseUnits} > 0 and ${table.confirmedBaseUnits} >= 0 and ${table.confirmedBaseUnits} <= ${table.amountBaseUnits}`,
    ),
  ],
);

export const splitInvitations = pgTable(
  'split_invitations',
  {
    id: opaqueId('id').primaryKey(),
    splitId: opaqueId('split_id')
      .notNull()
      .references(() => splits.id, { onDelete: 'restrict' }),
    participantId: uuid('participant_id')
      .notNull()
      .references(() => splitParticipants.id, { onDelete: 'restrict' }),
    capabilityHash: digest('capability_hash').notNull(),
    status: splitInvitationStatusEnum('status').notNull().default('unpaid'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex('split_invitations_capability_unique').on(table.capabilityHash),
    uniqueIndex('split_invitations_participant_unique').on(table.participantId),
  ],
);

export const splitPayments = pgTable(
  'split_payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    splitId: opaqueId('split_id')
      .notNull()
      .references(() => splits.id, { onDelete: 'restrict' }),
    invitationId: opaqueId('invitation_id')
      .notNull()
      .references(() => splitInvitations.id, { onDelete: 'restrict' }),
    payerUserId: opaqueId('payer_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    paymentKey: digest('payment_key').notNull(),
    splitDigest: digest('split_digest'),
    originalOrderKey: digest('original_order_key'),
    tokenAddress: evmAddress('token_address'),
    intentDigest: digest('intent_digest'),
    amountBaseUnits: amount('amount_base_units').notNull(),
    status: splitPaymentStatusEnum('status').notNull(),
    providerOperationId: varchar('provider_operation_id', { length: 256 }),
    transactionHash: digest('transaction_hash'),
    blockNumber: bigint('block_number', { mode: 'bigint' }),
    blockHash: digest('block_hash'),
    logIndex: integer('log_index'),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex('split_payments_payment_key_unique').on(table.paymentKey),
    uniqueIndex('split_payments_invitation_unique').on(table.invitationId),
    uniqueIndex('split_payments_provider_operation_unique').on(table.providerOperationId),
    check('split_payments_amount_positive_check', sql`${table.amountBaseUnits} > 0`),
    check(
      'split_payments_paid_proof_check',
      sql`${table.status} <> 'paid' or (${table.splitDigest} is not null and ${table.originalOrderKey} is not null and ${table.tokenAddress} is not null and ${table.intentDigest} is not null and ${table.transactionHash} is not null and ${table.blockNumber} is not null and ${table.blockHash} is not null and ${table.logIndex} is not null and ${table.confirmedAt} is not null)`,
    ),
  ],
);

export const contractOperations = pgTable(
  'contract_operations',
  {
    id: opaqueId('id').primaryKey(),
    kind: varchar('kind', { length: 40 }).notNull(),
    aggregateType: varchar('aggregate_type', { length: 40 }).notNull(),
    aggregateId: varchar('aggregate_id', { length: 100 }).notNull(),
    actorUserId: opaqueId('actor_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    ownerAddress: evmAddress('owner_address').notNull(),
    chainId: amount('chain_id').notNull(),
    binding: jsonb('binding').$type<Record<string, unknown>>().notNull(),
    template: jsonb('template').$type<Record<string, unknown>>().notNull(),
    bindingDigest: digest('binding_digest').notNull(),
    status: varchar('status', { length: 32 }).notNull().default('prepared'),
    providerOperationId: varchar('provider_operation_id', { length: 256 }),
    managedSignerNonce: amount('managed_signer_nonce'),
    transactionHash: digest('transaction_hash'),
    canonicalEventName: varchar('canonical_event_name', { length: 80 }),
    blockNumber: bigint('block_number', { mode: 'bigint' }),
    blockHash: digest('block_hash'),
    logIndex: integer('log_index'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    submissionStartedAt: timestamp('submission_started_at', { withTimezone: true }),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    version: integer('version').notNull().default(1),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex('contract_operations_binding_unique').on(table.bindingDigest),
    uniqueIndex('contract_operations_provider_unique').on(table.providerOperationId),
    uniqueIndex('contract_operations_chain_log_unique').on(
      table.chainId,
      table.transactionHash,
      table.logIndex,
    ),
    index('contract_operations_aggregate_idx').on(
      table.aggregateType,
      table.aggregateId,
      table.createdAt,
    ),
    index('contract_operations_reconcile_idx').on(table.status, table.updatedAt),
    check(
      'contract_operations_status_check',
      sql`${table.status} in ('prepared','submission_started','submitted','submitted_unknown','confirming','confirmed','failed','orphaned')`,
    ),
    check(
      'contract_operations_submission_boundary_check',
      sql`${table.status} not in ('submission_started','submitted','submitted_unknown','confirming','confirmed') or ${table.submissionStartedAt} is not null`,
    ),
    check(
      'contract_operations_confirmed_proof_check',
      sql`${table.status} <> 'confirmed' or (${table.transactionHash} is not null and ${table.canonicalEventName} is not null and ${table.blockNumber} is not null and ${table.blockHash} is not null and ${table.logIndex} is not null and ${table.confirmedAt} is not null)`,
    ),
  ],
);

export const idempotencyRecords = pgTable(
  'idempotency_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scope: varchar('scope', { length: 180 }).notNull(),
    keyHash: digest('key_hash').notNull(),
    requestHash: digest('request_hash').notNull(),
    status: idempotencyStatusEnum('status').notNull().default('in_progress'),
    responseBody: jsonb('response_body').$type<unknown>(),
    responseDigest: digest('response_digest'),
    responseStatus: integer('response_status'),
    ownerToken: uuid('owner_token').notNull().defaultRandom(),
    lockedUntil: timestamp('locked_until', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex('idempotency_records_scope_key_unique').on(table.scope, table.keyHash),
    index('idempotency_records_expiry_idx').on(table.expiresAt),
  ],
);

export const backgroundJobs = pgTable(
  'background_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: varchar('kind', { length: 80 }).notNull(),
    businessKey: varchar('business_key', { length: 200 }).notNull(),
    payload: jsonb('payload').$type<Record<string, string>>().notNull(),
    status: jobStatusEnum('status').notNull().default('scheduled'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(10),
    runAt: timestamp('run_at', { withTimezone: true }).notNull().defaultNow(),
    lockedBy: varchar('locked_by', { length: 100 }),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    lastErrorCode: varchar('last_error_code', { length: 80 }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex('background_jobs_kind_business_unique').on(table.kind, table.businessKey),
    index('background_jobs_due_idx').on(table.status, table.runAt),
    check(
      'background_jobs_attempt_bounds_check',
      sql`${table.attempts} >= 0 and ${table.maxAttempts} > 0 and ${table.attempts} <= ${table.maxAttempts}`,
    ),
  ],
);

export const deadLetters = pgTable(
  'dead_letters',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id').references(() => backgroundJobs.id, { onDelete: 'restrict' }),
    kind: varchar('kind', { length: 80 }).notNull(),
    businessKey: varchar('business_key', { length: 200 }).notNull(),
    safePayload: jsonb('safe_payload').$type<Record<string, string>>().notNull(),
    errorCode: varchar('error_code', { length: 80 }).notNull(),
    errorDigest: digest('error_digest').notNull(),
    replayedAt: timestamp('replayed_at', { withTimezone: true }),
    createdAt,
  },
  (table) => [
    index('dead_letters_kind_created_idx').on(table.kind, table.createdAt),
    uniqueIndex('dead_letters_kind_business_unique').on(table.kind, table.businessKey),
  ],
);

export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventKey: varchar('event_key', { length: 220 }).notNull(),
    eventType: varchar('event_type', { length: 100 }).notNull(),
    aggregateType: varchar('aggregate_type', { length: 80 }).notNull(),
    aggregateId: varchar('aggregate_id', { length: 100 }).notNull(),
    safePayload: jsonb('safe_payload').$type<Record<string, string>>().notNull(),
    availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    createdAt,
  },
  (table) => [
    uniqueIndex('outbox_events_event_key_unique').on(table.eventKey),
    index('outbox_events_unpublished_idx').on(table.publishedAt, table.availableAt),
  ],
);

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actorType: varchar('actor_type', { length: 40 }).notNull(),
    actorId: varchar('actor_id', { length: 100 }),
    action: varchar('action', { length: 100 }).notNull(),
    resourceType: varchar('resource_type', { length: 80 }).notNull(),
    resourceId: varchar('resource_id', { length: 100 }),
    result: varchar('result', { length: 40 }).notNull(),
    requestId: varchar('request_id', { length: 64 }).notNull(),
    safeMetadata: jsonb('safe_metadata').$type<Record<string, string>>().notNull().default({}),
    createdAt,
  },
  (table) => [
    index('audit_logs_resource_idx').on(table.resourceType, table.resourceId, table.createdAt),
    index('audit_logs_actor_idx').on(table.actorType, table.actorId, table.createdAt),
  ],
);

export const featureFlags = pgTable(
  'feature_flags',
  {
    environment: featureFlagEnvironmentEnum('environment').notNull(),
    name: varchar('name', { length: 100 }).notNull(),
    enabled: boolean('enabled').notNull().default(false),
    rolloutBps: integer('rollout_bps').notNull().default(0),
    allowlistHashes: jsonb('allowlist_hashes').$type<readonly string[]>().notNull().default([]),
    version: integer('version').notNull().default(1),
    changedBy: varchar('changed_by', { length: 100 }).notNull(),
    reason: varchar('reason', { length: 300 }).notNull(),
    updatedAt,
  },
  (table) => [
    primaryKey({ columns: [table.environment, table.name] }),
    check(
      'feature_flags_rollout_bounds_check',
      sql`${table.rolloutBps} >= 0 and ${table.rolloutBps} <= 10000`,
    ),
  ],
);

export const featureFlagAudits = pgTable(
  'feature_flag_audits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    environment: featureFlagEnvironmentEnum('environment').notNull(),
    flagName: varchar('flag_name', { length: 100 }).notNull(),
    oldEnabled: boolean('old_enabled'),
    newEnabled: boolean('new_enabled').notNull(),
    actor: varchar('actor', { length: 100 }).notNull(),
    reason: varchar('reason', { length: 300 }).notNull(),
    requestId: varchar('request_id', { length: 64 }).notNull(),
    createdAt,
  },
  (table) => [
    index('feature_flag_audits_flag_idx').on(table.environment, table.flagName, table.createdAt),
  ],
);

export const configSnapshots = pgTable(
  'config_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    environment: featureFlagEnvironmentEnum('environment').notNull(),
    configDigest: digest('config_digest').notNull(),
    safeConfig: jsonb('safe_config').$type<Record<string, string | boolean>>().notNull(),
    applicationVersion: varchar('application_version', { length: 80 }).notNull(),
    activatedAt: timestamp('activated_at', { withTimezone: true }).notNull(),
    deactivatedAt: timestamp('deactivated_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('config_snapshots_environment_digest_unique').on(
      table.environment,
      table.configDigest,
    ),
  ],
);

export const judgeEvidence = pgTable(
  'judge_evidence',
  {
    evidenceId: opaqueId('evidence_id').primaryKey(),
    orderId: opaqueId('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    publicProof: jsonb('public_proof').$type<Record<string, unknown>>().notNull(),
    publicProofDigest: digest('public_proof_digest').notNull(),
    shareTokenHash: digest('share_token_hash'),
    published: boolean('published').notNull().default(false),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex('judge_evidence_order_unique').on(table.orderId),
    uniqueIndex('judge_evidence_share_token_unique').on(table.shareTokenHash),
  ],
);

/**
 * Privileged, append-only acceptance evidence. No HTTP application port writes
 * this table; the protected live harness calls the validating database adapter
 * only after canonical settlement and restart recovery have both completed.
 */
export const liveAcceptanceEvidence = pgTable(
  'live_acceptance_evidence',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    environment: featureFlagEnvironmentEnum('environment').notNull(),
    releaseId: varchar('release_id', { length: 40 }).notNull(),
    deploymentConfigDigest: digest('deployment_config_digest').notNull(),
    orderId: opaqueId('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    paymentAttemptId: opaqueId('payment_attempt_id')
      .notNull()
      .references(() => paymentAttempts.id, { onDelete: 'restrict' }),
    providerOperationId: varchar('provider_operation_id', { length: 256 }).notNull(),
    previewDigest: digest('preview_digest').notNull(),
    providerEvidenceDigest: digest('provider_evidence_digest').notNull(),
    providerProvenance: varchar('provider_provenance', { length: 32 }).notNull(),
    delegationEvidenceDigest: digest('delegation_evidence_digest').notNull(),
    delegationTransactionHash: digest('delegation_transaction_hash').notNull(),
    route: jsonb('route').$type<LiveAcceptanceEvidenceInput['route']>().notNull(),
    settlementEvent: jsonb('settlement_event')
      .$type<LiveAcceptanceEvidenceInput['settlement']['event']>()
      .notNull(),
    chainId: amount('chain_id').notNull(),
    checkoutAddress: evmAddress('checkout_address').notNull(),
    settlementTransactionHash: digest('settlement_transaction_hash').notNull(),
    settlementBlockNumber: bigint('settlement_block_number', { mode: 'bigint' }).notNull(),
    settlementBlockHash: digest('settlement_block_hash').notNull(),
    settlementLogIndex: integer('settlement_log_index').notNull(),
    receiptId: opaqueId('receipt_id')
      .notNull()
      .references(() => receipts.id, { onDelete: 'restrict' }),
    passTokenId: amount('pass_token_id').notNull(),
    recovery: jsonb('recovery').$type<LiveAcceptanceEvidenceInput['recovery']>().notNull(),
    timingMs: jsonb('timing_ms').$type<LiveAcceptanceEvidenceInput['timingMs']>().notNull(),
    payloadDigest: digest('payload_digest').notNull(),
    attestationVersion: varchar('attestation_version', { length: 32 }).notNull(),
    attestationMac: digest('attestation_mac').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),
    createdAt,
  },
  (table) => [
    uniqueIndex('live_acceptance_evidence_order_unique').on(table.orderId),
    uniqueIndex('live_acceptance_evidence_attempt_unique').on(table.paymentAttemptId),
    uniqueIndex('live_acceptance_evidence_payload_unique').on(table.payloadDigest),
    index('live_acceptance_evidence_provider_idx').on(
      table.providerOperationId,
      table.providerProvenance,
    ),
    check(
      'live_acceptance_evidence_environment_check',
      sql`${table.environment} in ('demo-mainnet', 'production')`,
    ),
    check(
      'live_acceptance_evidence_release_id_check',
      sql`${table.releaseId} ~ '^[0-9a-fA-F]{40}$'`,
    ),
    check(
      'live_acceptance_evidence_deployment_config_digest_check',
      sql`${table.deploymentConfigDigest} ~ '^0x[0-9a-fA-F]{64}$'`,
    ),
    check('live_acceptance_evidence_chain_check', sql`${table.chainId} = 42161`),
    check(
      'live_acceptance_evidence_position_check',
      sql`${table.settlementBlockNumber} >= 0 and ${table.settlementLogIndex} >= 0`,
    ),
    check('live_acceptance_evidence_pass_token_check', sql`${table.passTokenId} > 0`),
    check(
      'live_acceptance_evidence_time_order_check',
      sql`${table.capturedAt} >= ${table.startedAt}`,
    ),
    check(
      'live_acceptance_evidence_provenance_check',
      sql`${table.providerProvenance} in ('live', 'recorded_live')`,
    ),
    check(
      'live_acceptance_evidence_attestation_version_check',
      sql`${table.attestationVersion} = 'hmac-sha256-v1'`,
    ),
  ],
);

export const analyticsEvents = pgTable(
  'analytics_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    anonymousSubjectHash: digest('anonymous_subject_hash'),
    userId: opaqueId('user_id').references(() => users.id, { onDelete: 'restrict' }),
    eventName: varchar('event_name', { length: 100 }).notNull(),
    consentCategory: varchar('consent_category', { length: 40 }).notNull(),
    safeProperties: jsonb('safe_properties')
      .$type<Record<string, string | boolean>>()
      .notNull()
      .default({}),
    retentionExpiresAt: timestamp('retention_expires_at', { withTimezone: true }).notNull(),
    createdAt,
  },
  (table) => [
    index('analytics_events_retention_idx').on(table.retentionExpiresAt),
    index('analytics_events_name_created_idx').on(table.eventName, table.createdAt),
  ],
);
