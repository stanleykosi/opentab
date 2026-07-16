CREATE TYPE "public"."auth_method" AS ENUM('google', 'email_otp');--> statement-breakpoint
CREATE TYPE "public"."auth_provider" AS ENUM('magic');--> statement-breakpoint
CREATE TYPE "public"."chain_sync_status" AS ENUM('not_required', 'pending', 'submitted', 'confirmed', 'mismatch', 'failed');--> statement-breakpoint
CREATE TYPE "public"."checkout_session_status" AS ENUM('active', 'bound', 'consumed', 'expired', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."settlement_credit_status" AS ENUM('refundable', 'matured', 'withdrawn', 'orphaned');--> statement-breakpoint
CREATE TYPE "public"."delegation_status" AS ENUM('unknown', 'required', 'submitted', 'confirmed', 'mismatch', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."feature_flag_environment" AS ENUM('local', 'test', 'preview', 'staging', 'demo-mainnet', 'production');--> statement-breakpoint
CREATE TYPE "public"."idempotency_status" AS ENUM('in_progress', 'completed', 'failed_retryable', 'failed_terminal');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('scheduled', 'running', 'completed', 'retrying', 'dead', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."merchant_role" AS ENUM('owner', 'admin', 'operator', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."merchant_status" AS ENUM('draft', 'pending', 'active', 'paused', 'archived');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('created', 'submitted', 'executing', 'paid', 'partially_refunded', 'refunded', 'failed_confirmed', 'mismatch', 'orphaned');--> statement-breakpoint
CREATE TYPE "public"."payment_attempt_status" AS ENUM('created', 'prepared', 'submission_started', 'submitted', 'submitted_unknown', 'executing', 'confirming', 'paid', 'failed_pre_submission', 'failed_confirmed', 'expired');--> statement-breakpoint
CREATE TYPE "public"."product_status" AS ENUM('draft', 'publishing', 'scheduled', 'active', 'paused', 'sold_out', 'ended', 'archived');--> statement-breakpoint
CREATE TYPE "public"."provider_operation_status" AS ENUM('preparing', 'moving_funds', 'executing', 'succeeded', 'failed', 'refunding', 'refunded', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."receipt_status" AS ENUM('expected', 'issued', 'revoked', 'orphaned');--> statement-breakpoint
CREATE TYPE "public"."refund_status" AS ENUM('created', 'prepared', 'submission_started', 'submitted', 'submitted_unknown', 'confirming', 'confirmed', 'failed', 'mismatch', 'orphaned');--> statement-breakpoint
CREATE TYPE "public"."split_invitation_status" AS ENUM('unpaid', 'submission_started', 'submitted_unknown', 'confirming', 'paid', 'expired', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."split_status" AS ENUM('active', 'partially_paid', 'complete', 'expired', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."sponsor_grant_status" AS ENUM('created', 'submitted', 'submitted_unknown', 'confirmed', 'failed', 'replaced');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'suspended', 'closed');--> statement-breakpoint
CREATE TYPE "public"."withdrawal_status" AS ENUM('created', 'prepared', 'submission_started', 'submitted', 'submitted_unknown', 'confirming', 'confirmed', 'failed', 'mismatch', 'orphaned');--> statement-breakpoint
CREATE TABLE "analytics_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"anonymous_subject_hash" varchar(66),
	"user_id" varchar(40),
	"event_name" varchar(100) NOT NULL,
	"consent_category" varchar(40) NOT NULL,
	"safe_properties" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"retention_expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_type" varchar(40) NOT NULL,
	"actor_id" varchar(100),
	"action" varchar(100) NOT NULL,
	"resource_type" varchar(80) NOT NULL,
	"resource_id" varchar(100),
	"result" varchar(40) NOT NULL,
	"request_id" varchar(64) NOT NULL,
	"safe_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "background_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" varchar(80) NOT NULL,
	"business_key" varchar(200) NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "job_status" DEFAULT 'scheduled' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 10 NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_by" varchar(100),
	"locked_until" timestamp with time zone,
	"last_error_code" varchar(80),
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "background_jobs_attempt_bounds_check" CHECK ("background_jobs"."attempts" >= 0 and "background_jobs"."max_attempts" > 0 and "background_jobs"."attempts" <= "background_jobs"."max_attempts")
);
--> statement-breakpoint
CREATE TABLE "bootstrap_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment" "feature_flag_environment" NOT NULL,
	"user_id" varchar(40) NOT NULL,
	"magic_issuer_hash" varchar(66) NOT NULL,
	"recipient_address_lower" varchar(42) NOT NULL,
	"idempotency_key_hash" varchar(66) NOT NULL,
	"eligibility_reason" varchar(80) NOT NULL,
	"balance_before_wei" numeric(78, 0) NOT NULL,
	"target_wei" numeric(78, 0) NOT NULL,
	"amount_wei" numeric(78, 0) NOT NULL,
	"status" "sponsor_grant_status" NOT NULL,
	"transaction_hash" varchar(66),
	"signer_nonce" numeric(78, 0),
	"block_number" bigint,
	"block_hash" varchar(66),
	"risk_decision_id" uuid,
	"error_code" varchar(80),
	"submitted_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bootstrap_grants_amount_positive_check" CHECK ("bootstrap_grants"."amount_wei" > 0),
	CONSTRAINT "bootstrap_grants_amount_target_check" CHECK ("bootstrap_grants"."amount_wei" <= "bootstrap_grants"."target_wei")
);
--> statement-breakpoint
CREATE TABLE "canonical_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chain_id" numeric(78, 0) NOT NULL,
	"stream" varchar(80) NOT NULL,
	"contract_address" varchar(42) NOT NULL,
	"event_name" varchar(80) NOT NULL,
	"transaction_hash" varchar(66) NOT NULL,
	"block_number" bigint NOT NULL,
	"block_hash" varchar(66) NOT NULL,
	"log_index" integer NOT NULL,
	"canonical" boolean DEFAULT true NOT NULL,
	"decoded_payload" jsonb NOT NULL,
	"payload_digest" varchar(66) NOT NULL,
	"projection_status" varchar(40) DEFAULT 'pending' NOT NULL,
	"mismatch_code" varchar(80),
	"observed_at" timestamp with time zone NOT NULL,
	"projected_at" timestamp with time zone,
	"orphaned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chain_event_quarantine" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"canonical_log_id" uuid NOT NULL,
	"reason_code" varchar(80) NOT NULL,
	"safe_details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolution" varchar(80),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chain_receipts" (
	"chain_id" numeric(78, 0) NOT NULL,
	"transaction_hash" varchar(66) NOT NULL,
	"block_number" bigint NOT NULL,
	"block_hash" varchar(66) NOT NULL,
	"success" boolean NOT NULL,
	"gas_used" numeric(78, 0) NOT NULL,
	"effective_gas_price" numeric(78, 0) NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "chain_receipts_chain_id_transaction_hash_pk" PRIMARY KEY("chain_id","transaction_hash")
);
--> statement-breakpoint
CREATE TABLE "chain_transactions" (
	"chain_id" numeric(78, 0) NOT NULL,
	"transaction_hash" varchar(66) NOT NULL,
	"from_address" varchar(42),
	"to_address" varchar(42),
	"status" varchar(24) NOT NULL,
	"block_number" bigint,
	"block_hash" varchar(66),
	"observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chain_transactions_chain_id_transaction_hash_pk" PRIMARY KEY("chain_id","transaction_hash")
);
--> statement-breakpoint
CREATE TABLE "checkout_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" varchar(40) NOT NULL,
	"capability_hash" varchar(66) NOT NULL,
	"campaign" varchar(100),
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_by_user_id" varchar(40) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "checkout_sessions" (
	"id" varchar(40) PRIMARY KEY NOT NULL,
	"public_capability_hash" varchar(66),
	"user_id" varchar(40),
	"product_id" varchar(40) NOT NULL,
	"product_version" integer NOT NULL,
	"quantity" numeric(78, 0) NOT NULL,
	"receipt_recipient" varchar(42),
	"amount_base_units" numeric(78, 0) NOT NULL,
	"order_key" varchar(66) NOT NULL,
	"status" "checkout_session_status" DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"binding_digest" varchar(66),
	"version" integer DEFAULT 1 NOT NULL,
	"bound_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "checkout_sessions_amount_positive_check" CHECK ("checkout_sessions"."amount_base_units" > 0),
	CONSTRAINT "checkout_sessions_quantity_positive_check" CHECK ("checkout_sessions"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "config_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment" "feature_flag_environment" NOT NULL,
	"config_digest" varchar(66) NOT NULL,
	"safe_config" jsonb NOT NULL,
	"application_version" varchar(80) NOT NULL,
	"activated_at" timestamp with time zone NOT NULL,
	"deactivated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "dead_letters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid,
	"kind" varchar(80) NOT NULL,
	"business_key" varchar(200) NOT NULL,
	"safe_payload" jsonb NOT NULL,
	"error_code" varchar(80) NOT NULL,
	"error_digest" varchar(66) NOT NULL,
	"replayed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delegation_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar(40) NOT NULL,
	"chain_id" numeric(78, 0) NOT NULL,
	"owner_address_lower" varchar(42) NOT NULL,
	"implementation_address_lower" varchar(42) NOT NULL,
	"implementation_code_hash" varchar(66) NOT NULL,
	"status" "delegation_status" NOT NULL,
	"transaction_hash" varchar(66),
	"block_number" bigint,
	"block_hash" varchar(66),
	"evidence_digest" varchar(66) NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feature_flag_audits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment" "feature_flag_environment" NOT NULL,
	"flag_name" varchar(100) NOT NULL,
	"old_enabled" boolean,
	"new_enabled" boolean NOT NULL,
	"actor" varchar(100) NOT NULL,
	"reason" varchar(300) NOT NULL,
	"request_id" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feature_flags" (
	"environment" "feature_flag_environment" NOT NULL,
	"name" varchar(100) NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"rollout_bps" integer DEFAULT 0 NOT NULL,
	"allowlist_hashes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"changed_by" varchar(100) NOT NULL,
	"reason" varchar(300) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feature_flags_environment_name_pk" PRIMARY KEY("environment","name"),
	CONSTRAINT "feature_flags_rollout_bounds_check" CHECK ("feature_flags"."rollout_bps" >= 0 and "feature_flags"."rollout_bps" <= 10000)
);
--> statement-breakpoint
CREATE TABLE "idempotency_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" varchar(180) NOT NULL,
	"key_hash" varchar(66) NOT NULL,
	"request_hash" varchar(66) NOT NULL,
	"status" "idempotency_status" DEFAULT 'in_progress' NOT NULL,
	"response_body" jsonb,
	"response_digest" varchar(66),
	"response_status" integer,
	"owner_token" uuid DEFAULT gen_random_uuid() NOT NULL,
	"locked_until" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "indexed_blocks" (
	"chain_id" numeric(78, 0) NOT NULL,
	"stream" varchar(80) NOT NULL,
	"block_number" bigint NOT NULL,
	"block_hash" varchar(66) NOT NULL,
	"parent_hash" varchar(66) NOT NULL,
	"canonical" boolean DEFAULT true NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"orphaned_at" timestamp with time zone,
	CONSTRAINT "indexed_blocks_chain_id_stream_block_number_block_hash_pk" PRIMARY KEY("chain_id","stream","block_number","block_hash")
);
--> statement-breakpoint
CREATE TABLE "indexer_cursors" (
	"chain_id" numeric(78, 0) NOT NULL,
	"stream" varchar(80) NOT NULL,
	"next_block" bigint NOT NULL,
	"last_processed_block" bigint,
	"last_processed_block_hash" varchar(66),
	"confirmation_depth" integer NOT NULL,
	"lease_owner" varchar(100),
	"lease_expires_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "indexer_cursors_chain_id_stream_pk" PRIMARY KEY("chain_id","stream"),
	CONSTRAINT "indexer_cursors_nonnegative_check" CHECK ("indexer_cursors"."next_block" >= 0 and "indexer_cursors"."confirmation_depth" > 0)
);
--> statement-breakpoint
CREATE TABLE "loyalty_awards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"program_id" uuid NOT NULL,
	"user_id" varchar(40) NOT NULL,
	"order_id" varchar(40) NOT NULL,
	"points" numeric(78, 0) NOT NULL,
	"canonical_event_id" uuid NOT NULL,
	"canonical" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loyalty_awards_points_nonnegative_check" CHECK ("loyalty_awards"."points" >= 0)
);
--> statement-breakpoint
CREATE TABLE "loyalty_balances" (
	"program_id" uuid NOT NULL,
	"user_id" varchar(40) NOT NULL,
	"points" numeric(78, 0) DEFAULT '0' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loyalty_balances_program_id_user_id_pk" PRIMARY KEY("program_id","user_id"),
	CONSTRAINT "loyalty_balances_nonnegative_check" CHECK ("loyalty_balances"."points" >= 0)
);
--> statement-breakpoint
CREATE TABLE "loyalty_programs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" varchar(40) NOT NULL,
	"name" varchar(100) NOT NULL,
	"points_per_base_unit_numerator" numeric(78, 0) DEFAULT '0' NOT NULL,
	"points_per_base_unit_denominator" numeric(78, 0) DEFAULT '1' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loyalty_programs_denominator_positive_check" CHECK ("loyalty_programs"."points_per_base_unit_denominator" > 0)
);
--> statement-breakpoint
CREATE TABLE "merchant_members" (
	"merchant_id" varchar(40) NOT NULL,
	"user_id" varchar(40) NOT NULL,
	"role" "merchant_role" NOT NULL,
	"invited_by_user_id" varchar(40),
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchant_members_merchant_id_user_id_pk" PRIMARY KEY("merchant_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "merchants" (
	"id" varchar(40) PRIMARY KEY NOT NULL,
	"onchain_merchant_id" numeric(78, 0),
	"owner_user_id" varchar(40) NOT NULL,
	"slug" varchar(80) NOT NULL,
	"display_name" varchar(100) NOT NULL,
	"support_contact" varchar(200),
	"payout_address" varchar(42) NOT NULL,
	"payout_address_lower" varchar(42) NOT NULL,
	"profile" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "merchant_status" DEFAULT 'draft' NOT NULL,
	"chain_sync_status" "chain_sync_status" DEFAULT 'pending' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchants_version_positive_check" CHECK ("merchants"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" varchar(40) PRIMARY KEY NOT NULL,
	"checkout_session_id" varchar(40) NOT NULL,
	"order_key" varchar(66) NOT NULL,
	"user_id" varchar(40) NOT NULL,
	"merchant_id" varchar(40) NOT NULL,
	"product_id" varchar(40) NOT NULL,
	"payer" varchar(42) NOT NULL,
	"recipient" varchar(42) NOT NULL,
	"token_address" varchar(42) NOT NULL,
	"quantity" numeric(78, 0) NOT NULL,
	"amount_base_units" numeric(78, 0) NOT NULL,
	"paid_amount_base_units" numeric(78, 0) DEFAULT '0' NOT NULL,
	"refunded_amount_base_units" numeric(78, 0) DEFAULT '0' NOT NULL,
	"status" "order_status" DEFAULT 'created' NOT NULL,
	"chain_id" numeric(78, 0) NOT NULL,
	"transaction_hash" varchar(66),
	"block_number" bigint,
	"block_hash" varchar(66),
	"log_index" integer,
	"provider_operation_id" varchar(256),
	"intent_digest" varchar(66) NOT NULL,
	"refundable_until" timestamp with time zone NOT NULL,
	"confirmed_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_amount_positive_check" CHECK ("orders"."amount_base_units" > 0),
	CONSTRAINT "orders_paid_bounds_check" CHECK ("orders"."paid_amount_base_units" >= 0 and "orders"."paid_amount_base_units" <= "orders"."amount_base_units"),
	CONSTRAINT "orders_refund_bounds_check" CHECK ("orders"."refunded_amount_base_units" >= 0 and "orders"."refunded_amount_base_units" <= "orders"."paid_amount_base_units"),
	CONSTRAINT "orders_paid_proof_check" CHECK ("orders"."status" not in ('paid', 'partially_refunded', 'refunded') or ("orders"."transaction_hash" is not null and "orders"."block_number" is not null and "orders"."block_hash" is not null and "orders"."log_index" is not null and "orders"."confirmed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_key" varchar(220) NOT NULL,
	"event_type" varchar(100) NOT NULL,
	"aggregate_type" varchar(80) NOT NULL,
	"aggregate_id" varchar(100) NOT NULL,
	"safe_payload" jsonb NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_attempts" (
	"id" varchar(40) PRIMARY KEY NOT NULL,
	"order_id" varchar(40) NOT NULL,
	"checkout_session_id" varchar(40) NOT NULL,
	"attempt_number" integer NOT NULL,
	"status" "payment_attempt_status" DEFAULT 'created' NOT NULL,
	"binding_digest" varchar(66) NOT NULL,
	"prepared_root_hash_digest" varchar(66),
	"preview_digest" varchar(66),
	"quote_summary" jsonb,
	"prepared_expires_at" timestamp with time zone,
	"provider_operation_id" varchar(256),
	"destination_transaction_hash" varchar(66),
	"submission_started_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"terminal_at" timestamp with time zone,
	"error_code" varchar(80),
	"vendor_code" varchar(100),
	"reconciliation_required" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_attempts_number_positive_check" CHECK ("payment_attempts"."attempt_number" > 0),
	CONSTRAINT "payment_attempts_submission_boundary_check" CHECK ("payment_attempts"."status" not in ('submission_started','submitted','submitted_unknown','executing','confirming','paid') or "payment_attempts"."submission_started_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "product_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" varchar(40) NOT NULL,
	"version" integer NOT NULL,
	"changed_by_user_id" varchar(40) NOT NULL,
	"snapshot" jsonb NOT NULL,
	"change_digest" varchar(66) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" varchar(40) PRIMARY KEY NOT NULL,
	"merchant_id" varchar(40) NOT NULL,
	"onchain_product_id" numeric(78, 0),
	"version" integer DEFAULT 1 NOT NULL,
	"slug" varchar(100) NOT NULL,
	"title" varchar(140) NOT NULL,
	"description" text NOT NULL,
	"image_url" text,
	"unit_price_base_units" numeric(78, 0) NOT NULL,
	"currency_code" varchar(12) DEFAULT 'USDC' NOT NULL,
	"max_supply" numeric(78, 0),
	"sold" numeric(78, 0) DEFAULT '0' NOT NULL,
	"max_per_order" numeric(78, 0) NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"refund_window_seconds" numeric(78, 0) DEFAULT '0' NOT NULL,
	"loyalty_points" numeric(78, 0) DEFAULT '0' NOT NULL,
	"metadata_hash" varchar(66) NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "product_status" DEFAULT 'draft' NOT NULL,
	"chain_sync_status" "chain_sync_status" DEFAULT 'pending' NOT NULL,
	"source_block_number" bigint,
	"source_block_hash" varchar(66),
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_price_nonnegative_check" CHECK ("products"."unit_price_base_units" >= 0),
	CONSTRAINT "products_supply_nonnegative_check" CHECK ("products"."max_supply" is null or "products"."max_supply" >= 0),
	CONSTRAINT "products_sold_nonnegative_check" CHECK ("products"."sold" >= 0),
	CONSTRAINT "products_supply_bounds_check" CHECK ("products"."max_supply" is null or "products"."sold" <= "products"."max_supply"),
	CONSTRAINT "products_version_positive_check" CHECK ("products"."version" > 0),
	CONSTRAINT "products_window_check" CHECK ("products"."ends_at" is null or "products"."ends_at" > "products"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "provider_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" varchar(40) NOT NULL,
	"external_id" varchar(256) NOT NULL,
	"payment_attempt_id" varchar(40),
	"kind" varchar(40) NOT NULL,
	"status" "provider_operation_status" NOT NULL,
	"submission_possible" boolean NOT NULL,
	"destination_transaction_hash" varchar(66),
	"activity_url" text,
	"evidence_digest" varchar(66) NOT NULL,
	"safe_summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "receipts" (
	"id" varchar(40) PRIMARY KEY NOT NULL,
	"order_id" varchar(40) NOT NULL,
	"token_id" numeric(78, 0),
	"metadata_uri" text,
	"metadata_hash" varchar(66) NOT NULL,
	"status" "receipt_status" DEFAULT 'expected' NOT NULL,
	"chain_event_id" uuid,
	"issued_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" varchar(40) PRIMARY KEY NOT NULL,
	"order_id" varchar(40) NOT NULL,
	"merchant_id" varchar(40) NOT NULL,
	"requested_by_user_id" varchar(40) NOT NULL,
	"amount_base_units" numeric(78, 0) NOT NULL,
	"status" "refund_status" DEFAULT 'created' NOT NULL,
	"idempotency_key_hash" varchar(66) NOT NULL,
	"provider_operation_id" varchar(256),
	"transaction_hash" varchar(66),
	"block_number" bigint,
	"block_hash" varchar(66),
	"log_index" integer,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refunds_amount_positive_check" CHECK ("refunds"."amount_base_units" > 0),
	CONSTRAINT "refunds_confirmed_proof_check" CHECK ("refunds"."status" <> 'confirmed' or ("refunds"."transaction_hash" is not null and "refunds"."block_hash" is not null and "refunds"."confirmed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "reorg_incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chain_id" numeric(78, 0) NOT NULL,
	"stream" varchar(80) NOT NULL,
	"detected_at_block" bigint NOT NULL,
	"common_ancestor_block" bigint NOT NULL,
	"depth" integer NOT NULL,
	"old_head_hash" varchar(66) NOT NULL,
	"new_head_hash" varchar(66) NOT NULL,
	"status" varchar(30) NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "reorg_incidents_depth_positive_check" CHECK ("reorg_incidents"."depth" > 0)
);
--> statement-breakpoint
CREATE TABLE "server_sessions" (
	"id" varchar(40) PRIMARY KEY NOT NULL,
	"user_id" varchar(40) NOT NULL,
	"token_hash" varchar(66) NOT NULL,
	"token_hash_version" integer DEFAULT 1 NOT NULL,
	"csrf_token_hash" varchar(66) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_agent_hash" varchar(66),
	"ip_prefix_hash" varchar(66),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settlement_credits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" varchar(40) NOT NULL,
	"order_id" varchar(40) NOT NULL,
	"amount_base_units" numeric(78, 0) NOT NULL,
	"withdrawn_base_units" numeric(78, 0) DEFAULT '0' NOT NULL,
	"status" "settlement_credit_status" NOT NULL,
	"matures_at" timestamp with time zone NOT NULL,
	"finalized_event_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settlement_credits_bounds_check" CHECK ("settlement_credits"."amount_base_units" >= 0 and "settlement_credits"."withdrawn_base_units" >= 0 and "settlement_credits"."withdrawn_base_units" <= "settlement_credits"."amount_base_units")
);
--> statement-breakpoint
CREATE TABLE "signed_order_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"checkout_session_id" varchar(40) NOT NULL,
	"order_key" varchar(66) NOT NULL,
	"digest" varchar(66) NOT NULL,
	"signer_address" varchar(42) NOT NULL,
	"signer_key_id" varchar(80) NOT NULL,
	"intent" jsonb NOT NULL,
	"signature" text NOT NULL,
	"valid_after" timestamp with time zone NOT NULL,
	"valid_until" timestamp with time zone NOT NULL,
	"refundable_until" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signed_order_intents_valid_window_check" CHECK ("signed_order_intents"."valid_until" > "signed_order_intents"."valid_after")
);
--> statement-breakpoint
CREATE TABLE "split_invitations" (
	"id" varchar(40) PRIMARY KEY NOT NULL,
	"split_id" varchar(40) NOT NULL,
	"participant_id" uuid NOT NULL,
	"capability_hash" varchar(66) NOT NULL,
	"status" "split_invitation_status" DEFAULT 'unpaid' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "split_participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"split_id" varchar(40) NOT NULL,
	"label" varchar(60) NOT NULL,
	"participant_user_id" varchar(40),
	"amount_base_units" numeric(78, 0) NOT NULL,
	"confirmed_base_units" numeric(78, 0) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "split_participants_bounds_check" CHECK ("split_participants"."amount_base_units" > 0 and "split_participants"."confirmed_base_units" >= 0 and "split_participants"."confirmed_base_units" <= "split_participants"."amount_base_units")
);
--> statement-breakpoint
CREATE TABLE "split_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"split_id" varchar(40) NOT NULL,
	"invitation_id" varchar(40) NOT NULL,
	"payer_user_id" varchar(40) NOT NULL,
	"payment_key" varchar(66) NOT NULL,
	"amount_base_units" numeric(78, 0) NOT NULL,
	"status" "split_invitation_status" NOT NULL,
	"provider_operation_id" varchar(256),
	"transaction_hash" varchar(66),
	"block_number" bigint,
	"block_hash" varchar(66),
	"log_index" integer,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "split_payments_amount_positive_check" CHECK ("split_payments"."amount_base_units" > 0)
);
--> statement-breakpoint
CREATE TABLE "splits" (
	"id" varchar(40) PRIMARY KEY NOT NULL,
	"order_id" varchar(40) NOT NULL,
	"creator_user_id" varchar(40) NOT NULL,
	"beneficiary" varchar(42) NOT NULL,
	"total_base_units" numeric(78, 0) NOT NULL,
	"confirmed_base_units" numeric(78, 0) DEFAULT '0' NOT NULL,
	"status" "split_status" DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "splits_total_positive_check" CHECK ("splits"."total_base_units" > 0),
	CONSTRAINT "splits_confirmed_bounds_check" CHECK ("splits"."confirmed_base_units" >= 0 and "splits"."confirmed_base_units" <= "splits"."total_base_units")
);
--> statement-breakpoint
CREATE TABLE "sponsor_audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"grant_id" uuid,
	"user_id" varchar(40),
	"action" varchar(80) NOT NULL,
	"decision" varchar(80) NOT NULL,
	"request_id" varchar(64) NOT NULL,
	"safe_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sponsor_budgets" (
	"environment" "feature_flag_environment" NOT NULL,
	"budget_date" varchar(10) NOT NULL,
	"scope" varchar(40) NOT NULL,
	"subject_hash" varchar(66) NOT NULL,
	"granted_wei" numeric(78, 0) DEFAULT '0' NOT NULL,
	"grant_count" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sponsor_budgets_environment_budget_date_scope_subject_hash_pk" PRIMARY KEY("environment","budget_date","scope","subject_hash"),
	CONSTRAINT "sponsor_budgets_nonnegative_check" CHECK ("sponsor_budgets"."granted_wei" >= 0 and "sponsor_budgets"."grant_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "sponsor_eligibility" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar(40) NOT NULL,
	"recipient_address_lower" varchar(42) NOT NULL,
	"eligible" boolean NOT NULL,
	"reason" varchar(80) NOT NULL,
	"balance_bucket" varchar(40) NOT NULL,
	"risk_decision_hash" varchar(66),
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar(40) NOT NULL,
	"provider" "auth_provider" NOT NULL,
	"provider_subject_hash" varchar(66) NOT NULL,
	"auth_method" "auth_method" NOT NULL,
	"evidence_digest" varchar(66) NOT NULL,
	"last_verified_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" varchar(40) PRIMARY KEY NOT NULL,
	"magic_issuer_hash" varchar(66) NOT NULL,
	"wallet_address_checksum" varchar(42) NOT NULL,
	"wallet_address_lower" varchar(42) NOT NULL,
	"email_ciphertext" text,
	"email_hash" varchar(66),
	"status" "user_status" DEFAULT 'active' NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_wallet_lowercase_check" CHECK ("users"."wallet_address_lower" = lower("users"."wallet_address_lower"))
);
--> statement-breakpoint
CREATE TABLE "wallet_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar(40) NOT NULL,
	"environment" "feature_flag_environment" NOT NULL,
	"owner_address_lower" varchar(42) NOT NULL,
	"universal_account_address_lower" varchar(42) NOT NULL,
	"solana_address" varchar(80),
	"sdk_package_version" varchar(40) NOT NULL,
	"protocol_version" varchar(40) NOT NULL,
	"eip7702_enabled" boolean NOT NULL,
	"delegation_status" "delegation_status" DEFAULT 'unknown' NOT NULL,
	"arbitrum_implementation" varchar(42),
	"delegation_transaction_hash" varchar(66),
	"checked_at" timestamp with time zone NOT NULL,
	"evidence_digest" varchar(66) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_accounts_eip7702_required_check" CHECK ("wallet_accounts"."eip7702_enabled" = true)
);
--> statement-breakpoint
CREATE TABLE "withdrawals" (
	"id" varchar(40) PRIMARY KEY NOT NULL,
	"merchant_id" varchar(40) NOT NULL,
	"requested_by_user_id" varchar(40) NOT NULL,
	"recipient" varchar(42) NOT NULL,
	"amount_base_units" numeric(78, 0) NOT NULL,
	"status" "withdrawal_status" DEFAULT 'created' NOT NULL,
	"idempotency_key_hash" varchar(66) NOT NULL,
	"transaction_hash" varchar(66),
	"block_number" bigint,
	"block_hash" varchar(66),
	"log_index" integer,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "withdrawals_amount_positive_check" CHECK ("withdrawals"."amount_base_units" > 0),
	CONSTRAINT "withdrawals_confirmed_proof_check" CHECK ("withdrawals"."status" <> 'confirmed' or ("withdrawals"."transaction_hash" is not null and "withdrawals"."block_hash" is not null and "withdrawals"."confirmed_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "analytics_events" ADD CONSTRAINT "analytics_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bootstrap_grants" ADD CONSTRAINT "bootstrap_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chain_event_quarantine" ADD CONSTRAINT "chain_event_quarantine_canonical_log_id_canonical_logs_id_fk" FOREIGN KEY ("canonical_log_id") REFERENCES "public"."canonical_logs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout_links" ADD CONSTRAINT "checkout_links_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout_links" ADD CONSTRAINT "checkout_links_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dead_letters" ADD CONSTRAINT "dead_letters_job_id_background_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."background_jobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegation_records" ADD CONSTRAINT "delegation_records_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_awards" ADD CONSTRAINT "loyalty_awards_program_id_loyalty_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."loyalty_programs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_awards" ADD CONSTRAINT "loyalty_awards_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_awards" ADD CONSTRAINT "loyalty_awards_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_awards" ADD CONSTRAINT "loyalty_awards_canonical_event_id_canonical_logs_id_fk" FOREIGN KEY ("canonical_event_id") REFERENCES "public"."canonical_logs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_balances" ADD CONSTRAINT "loyalty_balances_program_id_loyalty_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."loyalty_programs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_balances" ADD CONSTRAINT "loyalty_balances_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_programs" ADD CONSTRAINT "loyalty_programs_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_members" ADD CONSTRAINT "merchant_members_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_members" ADD CONSTRAINT "merchant_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_members" ADD CONSTRAINT "merchant_members_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchants" ADD CONSTRAINT "merchants_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_checkout_session_id_checkout_sessions_id_fk" FOREIGN KEY ("checkout_session_id") REFERENCES "public"."checkout_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_checkout_session_id_checkout_sessions_id_fk" FOREIGN KEY ("checkout_session_id") REFERENCES "public"."checkout_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_revisions" ADD CONSTRAINT "product_revisions_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_revisions" ADD CONSTRAINT "product_revisions_changed_by_user_id_users_id_fk" FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_operations" ADD CONSTRAINT "provider_operations_payment_attempt_id_payment_attempts_id_fk" FOREIGN KEY ("payment_attempt_id") REFERENCES "public"."payment_attempts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_chain_event_id_canonical_logs_id_fk" FOREIGN KEY ("chain_event_id") REFERENCES "public"."canonical_logs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_sessions" ADD CONSTRAINT "server_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_credits" ADD CONSTRAINT "settlement_credits_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_credits" ADD CONSTRAINT "settlement_credits_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_credits" ADD CONSTRAINT "settlement_credits_finalized_event_id_canonical_logs_id_fk" FOREIGN KEY ("finalized_event_id") REFERENCES "public"."canonical_logs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signed_order_intents" ADD CONSTRAINT "signed_order_intents_checkout_session_id_checkout_sessions_id_fk" FOREIGN KEY ("checkout_session_id") REFERENCES "public"."checkout_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "split_invitations" ADD CONSTRAINT "split_invitations_split_id_splits_id_fk" FOREIGN KEY ("split_id") REFERENCES "public"."splits"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "split_invitations" ADD CONSTRAINT "split_invitations_participant_id_split_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."split_participants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "split_participants" ADD CONSTRAINT "split_participants_split_id_splits_id_fk" FOREIGN KEY ("split_id") REFERENCES "public"."splits"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "split_participants" ADD CONSTRAINT "split_participants_participant_user_id_users_id_fk" FOREIGN KEY ("participant_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "split_payments" ADD CONSTRAINT "split_payments_split_id_splits_id_fk" FOREIGN KEY ("split_id") REFERENCES "public"."splits"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "split_payments" ADD CONSTRAINT "split_payments_invitation_id_split_invitations_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."split_invitations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "split_payments" ADD CONSTRAINT "split_payments_payer_user_id_users_id_fk" FOREIGN KEY ("payer_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "splits" ADD CONSTRAINT "splits_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "splits" ADD CONSTRAINT "splits_creator_user_id_users_id_fk" FOREIGN KEY ("creator_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sponsor_audit_events" ADD CONSTRAINT "sponsor_audit_events_grant_id_bootstrap_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."bootstrap_grants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sponsor_audit_events" ADD CONSTRAINT "sponsor_audit_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sponsor_eligibility" ADD CONSTRAINT "sponsor_eligibility_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_accounts" ADD CONSTRAINT "wallet_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "analytics_events_retention_idx" ON "analytics_events" USING btree ("retention_expires_at");--> statement-breakpoint
CREATE INDEX "analytics_events_name_created_idx" ON "analytics_events" USING btree ("event_name","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_resource_idx" ON "audit_logs" USING btree ("resource_type","resource_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_actor_idx" ON "audit_logs" USING btree ("actor_type","actor_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "background_jobs_kind_business_unique" ON "background_jobs" USING btree ("kind","business_key");--> statement-breakpoint
CREATE INDEX "background_jobs_due_idx" ON "background_jobs" USING btree ("status","run_at");--> statement-breakpoint
CREATE UNIQUE INDEX "bootstrap_grants_idempotency_unique" ON "bootstrap_grants" USING btree ("environment","user_id","idempotency_key_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "bootstrap_grants_transaction_unique" ON "bootstrap_grants" USING btree ("transaction_hash");--> statement-breakpoint
CREATE INDEX "bootstrap_grants_recipient_created_idx" ON "bootstrap_grants" USING btree ("recipient_address_lower","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "canonical_logs_log_identity_unique" ON "canonical_logs" USING btree ("chain_id","transaction_hash","log_index","block_hash");--> statement-breakpoint
CREATE INDEX "canonical_logs_block_idx" ON "canonical_logs" USING btree ("chain_id","stream","block_number","canonical");--> statement-breakpoint
CREATE INDEX "canonical_logs_projection_idx" ON "canonical_logs" USING btree ("projection_status","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "chain_event_quarantine_log_unique" ON "chain_event_quarantine" USING btree ("canonical_log_id");--> statement-breakpoint
CREATE UNIQUE INDEX "checkout_links_capability_hash_unique" ON "checkout_links" USING btree ("capability_hash");--> statement-breakpoint
CREATE INDEX "checkout_links_product_idx" ON "checkout_links" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "checkout_sessions_order_key_unique" ON "checkout_sessions" USING btree ("order_key");--> statement-breakpoint
CREATE INDEX "checkout_sessions_user_status_idx" ON "checkout_sessions" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "config_snapshots_environment_digest_unique" ON "config_snapshots" USING btree ("environment","config_digest");--> statement-breakpoint
CREATE INDEX "dead_letters_kind_created_idx" ON "dead_letters" USING btree ("kind","created_at");--> statement-breakpoint
CREATE INDEX "delegation_records_user_chain_idx" ON "delegation_records" USING btree ("user_id","chain_id");--> statement-breakpoint
CREATE UNIQUE INDEX "delegation_records_transaction_unique" ON "delegation_records" USING btree ("transaction_hash");--> statement-breakpoint
CREATE INDEX "feature_flag_audits_flag_idx" ON "feature_flag_audits" USING btree ("environment","flag_name","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_records_scope_key_unique" ON "idempotency_records" USING btree ("scope","key_hash");--> statement-breakpoint
CREATE INDEX "idempotency_records_expiry_idx" ON "idempotency_records" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "indexed_blocks_canonical_idx" ON "indexed_blocks" USING btree ("chain_id","stream","block_number","canonical");--> statement-breakpoint
CREATE UNIQUE INDEX "loyalty_awards_order_unique" ON "loyalty_awards" USING btree ("program_id","order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "loyalty_programs_merchant_unique" ON "loyalty_programs" USING btree ("merchant_id");--> statement-breakpoint
CREATE INDEX "merchant_members_user_idx" ON "merchant_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "merchants_slug_unique" ON "merchants" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "merchants_onchain_id_unique" ON "merchants" USING btree ("onchain_merchant_id");--> statement-breakpoint
CREATE INDEX "merchants_owner_idx" ON "merchants" USING btree ("owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_checkout_session_unique" ON "orders" USING btree ("checkout_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_order_key_unique" ON "orders" USING btree ("order_key");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_provider_operation_unique" ON "orders" USING btree ("provider_operation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_chain_log_unique" ON "orders" USING btree ("chain_id","transaction_hash","log_index");--> statement-breakpoint
CREATE INDEX "orders_user_created_idx" ON "orders" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "orders_merchant_created_idx" ON "orders" USING btree ("merchant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_events_event_key_unique" ON "outbox_events" USING btree ("event_key");--> statement-breakpoint
CREATE INDEX "outbox_events_unpublished_idx" ON "outbox_events" USING btree ("published_at","available_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_attempts_order_number_unique" ON "payment_attempts" USING btree ("order_id","attempt_number");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_attempts_provider_operation_unique" ON "payment_attempts" USING btree ("provider_operation_id");--> statement-breakpoint
CREATE INDEX "payment_attempts_reconciliation_idx" ON "payment_attempts" USING btree ("reconciliation_required","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "product_revisions_product_version_unique" ON "product_revisions" USING btree ("product_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "products_merchant_slug_unique" ON "products" USING btree ("merchant_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "products_onchain_id_unique" ON "products" USING btree ("onchain_product_id");--> statement-breakpoint
CREATE INDEX "products_merchant_status_idx" ON "products" USING btree ("merchant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_operations_provider_external_unique" ON "provider_operations" USING btree ("provider","external_id");--> statement-breakpoint
CREATE INDEX "provider_operations_attempt_idx" ON "provider_operations" USING btree ("payment_attempt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "receipts_order_unique" ON "receipts" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "receipts_token_unique" ON "receipts" USING btree ("token_id");--> statement-breakpoint
CREATE UNIQUE INDEX "refunds_idempotency_unique" ON "refunds" USING btree ("merchant_id","idempotency_key_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "refunds_chain_log_unique" ON "refunds" USING btree ("transaction_hash","log_index");--> statement-breakpoint
CREATE UNIQUE INDEX "server_sessions_token_hash_unique" ON "server_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "server_sessions_user_expiry_idx" ON "server_sessions" USING btree ("user_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "settlement_credits_order_unique" ON "settlement_credits" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "settlement_credits_merchant_status_idx" ON "settlement_credits" USING btree ("merchant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "signed_order_intents_order_key_unique" ON "signed_order_intents" USING btree ("order_key");--> statement-breakpoint
CREATE UNIQUE INDEX "signed_order_intents_digest_unique" ON "signed_order_intents" USING btree ("digest");--> statement-breakpoint
CREATE UNIQUE INDEX "split_invitations_capability_unique" ON "split_invitations" USING btree ("capability_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "split_invitations_participant_unique" ON "split_invitations" USING btree ("participant_id");--> statement-breakpoint
CREATE INDEX "split_participants_split_idx" ON "split_participants" USING btree ("split_id");--> statement-breakpoint
CREATE UNIQUE INDEX "split_payments_payment_key_unique" ON "split_payments" USING btree ("payment_key");--> statement-breakpoint
CREATE UNIQUE INDEX "split_payments_invitation_unique" ON "split_payments" USING btree ("invitation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "split_payments_provider_operation_unique" ON "split_payments" USING btree ("provider_operation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "splits_order_unique" ON "splits" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "sponsor_audit_events_grant_idx" ON "sponsor_audit_events" USING btree ("grant_id","created_at");--> statement-breakpoint
CREATE INDEX "sponsor_eligibility_user_recipient_idx" ON "sponsor_eligibility" USING btree ("user_id","recipient_address_lower","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "user_identities_provider_subject_unique" ON "user_identities" USING btree ("provider","provider_subject_hash");--> statement-breakpoint
CREATE INDEX "user_identities_user_idx" ON "user_identities" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_magic_issuer_hash_unique" ON "users" USING btree ("magic_issuer_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "users_wallet_address_lower_unique" ON "users" USING btree ("wallet_address_lower");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_accounts_user_environment_unique" ON "wallet_accounts" USING btree ("user_id","environment");--> statement-breakpoint
CREATE UNIQUE INDEX "withdrawals_idempotency_unique" ON "withdrawals" USING btree ("merchant_id","idempotency_key_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "withdrawals_chain_log_unique" ON "withdrawals" USING btree ("transaction_hash","log_index");