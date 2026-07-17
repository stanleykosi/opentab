-- OpenTab — Supabase SQL Editor one-time setup
-- GENERATED FILE. Source: packages/db/migrations + this repository's role policy.
-- Regenerate with: pnpm db:supabase:sql
--
-- Run this entire file once in a fresh, dedicated Supabase project:
--   Supabase Dashboard -> SQL Editor -> New query -> paste -> Run
--
-- Safety:
--   * The transaction fails before changing anything if OpenTab is already installed.
--   * Do not run this against a project shared with another application.
--   * The final result grid contains three newly generated database passwords.
--     Copy them immediately to your secret manager; never commit or share them.
--   * Keep the Supabase postgres password separate for controlled migrations only.

BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '10min';
-- Migrations contain intentionally unqualified CREATE TABLE statements, so
-- public must be the creation target. Runtime roles are hardened separately.
SET LOCAL search_path = public, pg_catalog;
SELECT pg_advisory_xact_lock(714480106095746);

DO $opentab_fresh_project$
BEGIN
  IF to_regclass('public.users') IS NOT NULL
    OR to_regclass('public.orders') IS NOT NULL
    OR to_regclass('drizzle.__drizzle_migrations') IS NOT NULL
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'OpenTab objects already exist. Use controlled migrations instead of the fresh-project SQL Editor setup.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles
    WHERE rolname = current_user AND rolcreaterole
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'Run this file from Supabase SQL Editor as the postgres project role with CREATEROLE.';
  END IF;
END
$opentab_fresh_project$;

CREATE SCHEMA drizzle;
CREATE TABLE drizzle.__drizzle_migrations (
  id serial PRIMARY KEY,
  hash text NOT NULL,
  created_at bigint
);

-- ---------------------------------------------------------------------------
-- Migration 0: 0000_initial-production-schema.sql
-- SHA-256: c5899101c8780689f5d157a9c8181b31cc20566d6b4ec68f1d2b44896a04ef1c
-- ---------------------------------------------------------------------------
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


-- ---------------------------------------------------------------------------
-- Migration 1: 0001_judge-evidence.sql
-- SHA-256: 66c1a7f167bd69b8097cff12b857a92d2e208401419cd59b82b4609285b7f5ff
-- ---------------------------------------------------------------------------
CREATE TABLE "judge_evidence" (
	"evidence_id" varchar(40) PRIMARY KEY NOT NULL,
	"order_id" varchar(40) NOT NULL,
	"public_proof" jsonb NOT NULL,
	"public_proof_digest" varchar(66) NOT NULL,
	"share_token_hash" varchar(66),
	"published" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "judge_evidence" ADD CONSTRAINT "judge_evidence_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "judge_evidence_order_unique" ON "judge_evidence" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "judge_evidence_share_token_unique" ON "judge_evidence" USING btree ("share_token_hash");


-- ---------------------------------------------------------------------------
-- Migration 2: 0002_workflow-and-canonical-safety.sql
-- SHA-256: 67c6c76587abe0b5a2136a143dab7c9cf18f942c5393c678c91ce980eef573dc
-- ---------------------------------------------------------------------------
ALTER TABLE "split_payments" ADD COLUMN "split_digest" varchar(66);--> statement-breakpoint
ALTER TABLE "split_payments" ADD COLUMN "original_order_key" varchar(66);--> statement-breakpoint
ALTER TABLE "split_payments" ADD COLUMN "token_address" varchar(42);--> statement-breakpoint
ALTER TABLE "split_payments" ADD COLUMN "intent_digest" varchar(66);--> statement-breakpoint
DROP INDEX "receipts_token_unique";--> statement-breakpoint
CREATE INDEX "receipts_token_idx" ON "receipts" USING btree ("token_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bootstrap_grants_one_pending_recipient_unique" ON "bootstrap_grants" USING btree ("environment","recipient_address_lower") WHERE "bootstrap_grants"."status" in ('created','submitted','submitted_unknown');--> statement-breakpoint
CREATE UNIQUE INDEX "canonical_logs_one_canonical_identity_unique" ON "canonical_logs" USING btree ("chain_id","contract_address","transaction_hash","log_index") WHERE "canonical_logs"."canonical" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_attempts_one_active_per_order_unique" ON "payment_attempts" USING btree ("order_id") WHERE "payment_attempts"."status" in ('created','prepared','submission_started','submitted','submitted_unknown','executing','confirming');--> statement-breakpoint
-- Legacy paid rows without the new signed binding cannot remain final. Move
-- them to replayable reconciliation rather than fabricating cryptographic
-- evidence, then validate the invariant for every row.
UPDATE "split_payments"
SET "status" = 'confirming', "confirmed_at" = null, "updated_at" = now()
WHERE "status" = 'paid' AND (
  "split_digest" is null OR "original_order_key" is null OR
  "token_address" is null OR "intent_digest" is null OR
  "transaction_hash" is null OR "block_number" is null OR
  "block_hash" is null OR "log_index" is null OR "confirmed_at" is null
);--> statement-breakpoint
ALTER TABLE "split_payments" ADD CONSTRAINT "split_payments_paid_proof_check" CHECK ("split_payments"."status" <> 'paid' or ("split_payments"."split_digest" is not null and "split_payments"."original_order_key" is not null and "split_payments"."token_address" is not null and "split_payments"."intent_digest" is not null and "split_payments"."transaction_hash" is not null and "split_payments"."block_number" is not null and "split_payments"."block_hash" is not null and "split_payments"."log_index" is not null and "split_payments"."confirmed_at" is not null));


-- ---------------------------------------------------------------------------
-- Migration 3: 0003_backend_workflow_completion.sql
-- SHA-256: 7a641af4613456e30f0bd31b1ea92fee703e34b204b1d3ed051dac6cad618b78
-- ---------------------------------------------------------------------------
ALTER TABLE "withdrawals" ADD COLUMN IF NOT EXISTS "provider_operation_id" varchar(256);
CREATE UNIQUE INDEX IF NOT EXISTS "withdrawals_provider_operation_unique"
  ON "withdrawals" USING btree ("provider_operation_id");
CREATE UNIQUE INDEX IF NOT EXISTS "dead_letters_kind_business_unique"
  ON "dead_letters" USING btree ("kind", "business_key");


-- ---------------------------------------------------------------------------
-- Migration 4: 0004_contract-operations.sql
-- SHA-256: 61c1173a8baa0064e73cc598aeced92dec3572d012cc4853bac2a00c74e832f8
-- ---------------------------------------------------------------------------
CREATE TYPE "public"."split_payment_status" AS ENUM('unpaid','submission_started','submitted_unknown','confirming','paid','failed','orphaned','revoked');
--> statement-breakpoint
ALTER TABLE "split_payments" DROP CONSTRAINT "split_payments_paid_proof_check";
--> statement-breakpoint
ALTER TABLE "split_payments" ALTER COLUMN "status" TYPE "public"."split_payment_status" USING "status"::text::"public"."split_payment_status";
--> statement-breakpoint
ALTER TABLE "split_payments" ADD CONSTRAINT "split_payments_paid_proof_check" CHECK ("status" <> 'paid' or ("split_digest" is not null and "original_order_key" is not null and "token_address" is not null and "intent_digest" is not null and "transaction_hash" is not null and "block_number" is not null and "block_hash" is not null and "log_index" is not null and "confirmed_at" is not null));
--> statement-breakpoint
CREATE TABLE "contract_operations" (
  "id" varchar(40) PRIMARY KEY NOT NULL,
  "kind" varchar(40) NOT NULL,
  "aggregate_type" varchar(40) NOT NULL,
  "aggregate_id" varchar(100) NOT NULL,
  "actor_user_id" varchar(40) NOT NULL,
  "owner_address" varchar(42) NOT NULL,
  "chain_id" numeric(78, 0) NOT NULL,
  "binding" jsonb NOT NULL,
  "template" jsonb NOT NULL,
  "binding_digest" varchar(66) NOT NULL,
  "status" varchar(32) DEFAULT 'prepared' NOT NULL,
  "provider_operation_id" varchar(256),
  "managed_signer_nonce" numeric(78, 0),
  "transaction_hash" varchar(66),
  "canonical_event_name" varchar(80),
  "block_number" bigint,
  "block_hash" varchar(66),
  "log_index" integer,
  "expires_at" timestamp with time zone NOT NULL,
  "submission_started_at" timestamp with time zone,
  "submitted_at" timestamp with time zone,
  "confirmed_at" timestamp with time zone,
  "version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "contract_operations_status_check" CHECK ("status" in ('prepared','submission_started','submitted','submitted_unknown','confirming','confirmed','failed','orphaned')),
  CONSTRAINT "contract_operations_submission_boundary_check" CHECK ("status" not in ('submission_started','submitted','submitted_unknown','confirming','confirmed') or "submission_started_at" is not null),
  CONSTRAINT "contract_operations_confirmed_proof_check" CHECK ("status" <> 'confirmed' or ("transaction_hash" is not null and "canonical_event_name" is not null and "block_number" is not null and "block_hash" is not null and "log_index" is not null and "confirmed_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "contract_operations" ADD CONSTRAINT "contract_operations_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "contract_operations_binding_unique" ON "contract_operations" USING btree ("binding_digest");
--> statement-breakpoint
CREATE UNIQUE INDEX "contract_operations_provider_unique" ON "contract_operations" USING btree ("provider_operation_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "contract_operations_chain_log_unique" ON "contract_operations" USING btree ("chain_id","transaction_hash","log_index");
--> statement-breakpoint
CREATE INDEX "contract_operations_aggregate_idx" ON "contract_operations" USING btree ("aggregate_type","aggregate_id","created_at");
--> statement-breakpoint
CREATE INDEX "contract_operations_reconcile_idx" ON "contract_operations" USING btree ("status","updated_at");
--> statement-breakpoint
ALTER TYPE "public"."split_status" ADD VALUE IF NOT EXISTS 'revoking' BEFORE 'complete';
--> statement-breakpoint
ALTER TABLE "loyalty_programs" ADD COLUMN "reward_threshold_points" numeric(78, 0) DEFAULT '0' NOT NULL;
--> statement-breakpoint
UPDATE "loyalty_programs" SET "points_per_base_unit_numerator" = '0', "points_per_base_unit_denominator" = '1';
--> statement-breakpoint
ALTER TABLE "loyalty_programs" ADD CONSTRAINT "loyalty_programs_threshold_nonnegative_check" CHECK ("reward_threshold_points" >= 0);


-- ---------------------------------------------------------------------------
-- Migration 5: 0005_sponsor-submission-boundary.sql
-- SHA-256: fd39576f06e29d284c8fdaf41c590f0bc3b3f3eb191f8f4775659180ba21942d
-- ---------------------------------------------------------------------------
ALTER TYPE "public"."sponsor_grant_status" ADD VALUE IF NOT EXISTS 'submission_started' AFTER 'created';
--> statement-breakpoint
ALTER TYPE "public"."sponsor_grant_status" ADD VALUE IF NOT EXISTS 'orphaned' AFTER 'replaced';
--> statement-breakpoint
ALTER TABLE "bootstrap_grants" ADD COLUMN "sponsor_signer_address_lower" varchar(42);
--> statement-breakpoint
ALTER TABLE "bootstrap_grants" ADD COLUMN "submission_started_at" timestamp with time zone;
--> statement-breakpoint
DROP INDEX "bootstrap_grants_one_pending_recipient_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX "bootstrap_grants_one_recipient_unique"
  ON "bootstrap_grants" USING btree ("environment", "recipient_address_lower");
--> statement-breakpoint
CREATE UNIQUE INDEX "bootstrap_grants_signer_nonce_unique"
  ON "bootstrap_grants" USING btree ("environment", "sponsor_signer_address_lower", "signer_nonce")
  WHERE "sponsor_signer_address_lower" is not null AND "signer_nonce" is not null;
--> statement-breakpoint
ALTER TABLE "bootstrap_grants"
  ADD CONSTRAINT "bootstrap_grants_submission_boundary_check"
  CHECK (
    "status"::text <> 'submission_started'
    OR (
      "sponsor_signer_address_lower" is not null
      AND "signer_nonce" is not null
      AND "submission_started_at" is not null
    )
  );


-- ---------------------------------------------------------------------------
-- Migration 6: 0006_sponsor-recoverable-preparation.sql
-- SHA-256: 25aea0bac87efba32379226edc32385d55efdd72054271528ea47d4c3f002fcf
-- ---------------------------------------------------------------------------
ALTER TABLE "bootstrap_grants"
  ADD COLUMN "transaction_hash_candidates" text[] NOT NULL DEFAULT ARRAY[]::text[];
--> statement-breakpoint
UPDATE "bootstrap_grants"
  SET "transaction_hash_candidates" = ARRAY["transaction_hash"]
  WHERE "transaction_hash" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "bootstrap_grants"
  ADD CONSTRAINT "bootstrap_grants_transaction_candidates_check"
  CHECK (
    cardinality("transaction_hash_candidates") <= 4
    AND (
      "transaction_hash" IS NULL
      OR "transaction_hash" = ANY("transaction_hash_candidates")
    )
  );


-- ---------------------------------------------------------------------------
-- Migration 7: 0007_immutable-delegation-evidence.sql
-- SHA-256: 0b672dce2af34b4c62311680b9cd0d88cc9e3c8ddbbe4308745e7c01b0d24db8
-- ---------------------------------------------------------------------------
ALTER TABLE "delegation_records"
  ADD COLUMN "environment" "feature_flag_environment";
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT lower("transaction_hash")
    FROM "delegation_records"
    WHERE "transaction_hash" IS NOT NULL
    GROUP BY lower("transaction_hash")
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'delegation evidence contains case-variant transaction duplicates';
  END IF;
END
$$;
--> statement-breakpoint
UPDATE "delegation_records"
SET
  "transaction_hash" = lower("transaction_hash"),
  "implementation_code_hash" = lower("implementation_code_hash"),
  "block_hash" = lower("block_hash"),
  "evidence_digest" = lower("evidence_digest");
--> statement-breakpoint
UPDATE "wallet_accounts"
SET
  "delegation_transaction_hash" = lower("delegation_transaction_hash"),
  "evidence_digest" = lower("evidence_digest")
WHERE "delegation_transaction_hash" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "delegation_records_transaction_lower_unique"
  ON "delegation_records" USING btree (lower("transaction_hash"));
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "wallet_accounts" AS wa
    JOIN "delegation_records" AS dr
      ON wa."delegation_transaction_hash" = dr."transaction_hash"
    WHERE wa."user_id" <> dr."user_id"
      OR wa."owner_address_lower" <> dr."owner_address_lower"
      OR wa."universal_account_address_lower" <> dr."owner_address_lower"
      OR wa."arbitrum_implementation" IS DISTINCT FROM dr."implementation_address_lower"
      OR wa."evidence_digest" <> dr."evidence_digest"
      OR wa."delegation_status" <> 'confirmed'
      OR wa."eip7702_enabled" <> true
  ) THEN
    RAISE EXCEPTION 'delegation evidence contains conflicting wallet-account bindings';
  END IF;

  IF EXISTS (
    SELECT dr."id"
    FROM "delegation_records" AS dr
    LEFT JOIN "wallet_accounts" AS wa
      ON wa."user_id" = dr."user_id"
      AND wa."delegation_transaction_hash" = dr."transaction_hash"
      AND wa."owner_address_lower" = dr."owner_address_lower"
      AND wa."universal_account_address_lower" = dr."owner_address_lower"
      AND wa."arbitrum_implementation" = dr."implementation_address_lower"
      AND wa."evidence_digest" = dr."evidence_digest"
      AND wa."delegation_status" = 'confirmed'
      AND wa."eip7702_enabled" = true
    GROUP BY dr."id"
    HAVING count(DISTINCT wa."environment"::text) <> 1
  ) THEN
    RAISE EXCEPTION 'delegation evidence cannot be assigned an unambiguous environment';
  END IF;
END
$$;
--> statement-breakpoint
UPDATE "delegation_records" AS dr
SET "environment" = binding."environment"
FROM (
  SELECT
    dr_inner."id",
    min(wa."environment"::text)::"feature_flag_environment" AS "environment"
  FROM "delegation_records" AS dr_inner
  JOIN "wallet_accounts" AS wa
    ON wa."user_id" = dr_inner."user_id"
    AND wa."delegation_transaction_hash" = dr_inner."transaction_hash"
    AND wa."owner_address_lower" = dr_inner."owner_address_lower"
    AND wa."universal_account_address_lower" = dr_inner."owner_address_lower"
    AND wa."arbitrum_implementation" = dr_inner."implementation_address_lower"
    AND wa."evidence_digest" = dr_inner."evidence_digest"
    AND wa."delegation_status" = 'confirmed'
    AND wa."eip7702_enabled" = true
  GROUP BY dr_inner."id"
) AS binding
WHERE dr."id" = binding."id";
--> statement-breakpoint
ALTER TABLE "delegation_records"
  ALTER COLUMN "environment" SET NOT NULL;


-- ---------------------------------------------------------------------------
-- Migration 8: 0008_append-only-live-acceptance-evidence.sql
-- SHA-256: 6cf0b1b4f5eeb8d97b0e7708c1d872d6221efbd41688c0bb119a2b7f80e54e8d
-- ---------------------------------------------------------------------------
CREATE TABLE "live_acceptance_evidence" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "environment" "feature_flag_environment" NOT NULL,
  "order_id" varchar(40) NOT NULL,
  "payment_attempt_id" varchar(40) NOT NULL,
  "provider_operation_id" varchar(256) NOT NULL,
  "preview_digest" varchar(66) NOT NULL,
  "provider_evidence_digest" varchar(66) NOT NULL,
  "provider_provenance" varchar(32) NOT NULL,
  "delegation_evidence_digest" varchar(66) NOT NULL,
  "delegation_transaction_hash" varchar(66) NOT NULL,
  "route" jsonb NOT NULL,
  "chain_id" numeric(78, 0) NOT NULL,
  "checkout_address" varchar(42) NOT NULL,
  "settlement_transaction_hash" varchar(66) NOT NULL,
  "settlement_block_number" bigint NOT NULL,
  "settlement_block_hash" varchar(66) NOT NULL,
  "settlement_log_index" integer NOT NULL,
  "receipt_id" varchar(40) NOT NULL,
  "pass_token_id" numeric(78, 0) NOT NULL,
  "recovery" jsonb NOT NULL,
  "timing_ms" jsonb NOT NULL,
  "payload_digest" varchar(66) NOT NULL,
  "attestation_version" varchar(32) NOT NULL,
  "attestation_mac" varchar(66) NOT NULL,
  "started_at" timestamp with time zone NOT NULL,
  "captured_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "live_acceptance_evidence_order_fk"
    FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE restrict,
  CONSTRAINT "live_acceptance_evidence_attempt_fk"
    FOREIGN KEY ("payment_attempt_id") REFERENCES "payment_attempts"("id") ON DELETE restrict,
  CONSTRAINT "live_acceptance_evidence_receipt_fk"
    FOREIGN KEY ("receipt_id") REFERENCES "receipts"("id") ON DELETE restrict,
  CONSTRAINT "live_acceptance_evidence_environment_check"
    CHECK ("environment" IN ('demo-mainnet', 'production')),
  CONSTRAINT "live_acceptance_evidence_chain_check" CHECK ("chain_id" = 42161),
  CONSTRAINT "live_acceptance_evidence_position_check"
    CHECK ("settlement_block_number" >= 0 AND "settlement_log_index" >= 0),
  CONSTRAINT "live_acceptance_evidence_pass_token_check" CHECK ("pass_token_id" > 0),
  CONSTRAINT "live_acceptance_evidence_time_order_check"
    CHECK ("captured_at" >= "started_at"),
  CONSTRAINT "live_acceptance_evidence_provenance_check"
    CHECK ("provider_provenance" IN ('live', 'recorded_live')),
  CONSTRAINT "live_acceptance_evidence_attestation_version_check"
    CHECK ("attestation_version" = 'hmac-sha256-v1')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "live_acceptance_evidence_order_unique"
  ON "live_acceptance_evidence" USING btree ("order_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "live_acceptance_evidence_attempt_unique"
  ON "live_acceptance_evidence" USING btree ("payment_attempt_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "live_acceptance_evidence_payload_unique"
  ON "live_acceptance_evidence" USING btree ("payload_digest");
--> statement-breakpoint
CREATE INDEX "live_acceptance_evidence_provider_idx"
  ON "live_acceptance_evidence" USING btree ("provider_operation_id", "provider_provenance");
--> statement-breakpoint
CREATE FUNCTION "reject_live_acceptance_evidence_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'live acceptance evidence is append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "live_acceptance_evidence_append_only"
BEFORE UPDATE OR DELETE ON "live_acceptance_evidence"
FOR EACH ROW EXECUTE FUNCTION "reject_live_acceptance_evidence_mutation"();


-- ---------------------------------------------------------------------------
-- Migration 9: 0009_release-bound-evidence.sql
-- SHA-256: f05db9d9fe215b70a0047f7544af20cc9d7e7dde9b67858b3e1da6edae3ef8b0
-- ---------------------------------------------------------------------------
ALTER TABLE "live_acceptance_evidence"
  ADD COLUMN "release_id" varchar(40) DEFAULT '0000000000000000000000000000000000000000' NOT NULL;
--> statement-breakpoint
ALTER TABLE "live_acceptance_evidence"
  ALTER COLUMN "release_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "live_acceptance_evidence"
  ADD CONSTRAINT "live_acceptance_evidence_release_id_check"
  CHECK ("release_id" ~ '^[0-9a-fA-F]{40}$');


-- ---------------------------------------------------------------------------
-- Migration 10: 0010_deployment-bound-evidence.sql
-- SHA-256: ad6de06155988cd55ce2da5d743e370b1d76977365dae386b6d37f5487baf7fd
-- ---------------------------------------------------------------------------
ALTER TABLE "live_acceptance_evidence"
  ADD COLUMN "deployment_config_digest" varchar(66)
  DEFAULT '0x0000000000000000000000000000000000000000000000000000000000000000'
  NOT NULL,
  ADD COLUMN "settlement_event" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "live_acceptance_evidence"
  ALTER COLUMN "deployment_config_digest" DROP DEFAULT,
  ALTER COLUMN "settlement_event" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "live_acceptance_evidence"
  ADD CONSTRAINT "live_acceptance_evidence_deployment_config_digest_check"
  CHECK ("deployment_config_digest" ~ '^0x[0-9a-fA-F]{64}$');
--> statement-breakpoint
CREATE INDEX "live_acceptance_evidence_deployment_config_idx"
  ON "live_acceptance_evidence" ("environment", "release_id", "deployment_config_digest");

INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
VALUES
  ('c5899101c8780689f5d157a9c8181b31cc20566d6b4ec68f1d2b44896a04ef1c', 1783723965977),
  ('66c1a7f167bd69b8097cff12b857a92d2e208401419cd59b82b4609285b7f5ff', 1783724478239),
  ('67c6c76587abe0b5a2136a143dab7c9cf18f942c5393c678c91ce980eef573dc', 1783979761271),
  ('7a641af4613456e30f0bd31b1ea92fee703e34b204b1d3ed051dac6cad618b78', 1783995200000),
  ('61c1173a8baa0064e73cc598aeced92dec3572d012cc4853bac2a00c74e832f8', 1784023200000),
  ('fd39576f06e29d284c8fdaf41c590f0bc3b3f3eb191f8f4775659180ba21942d', 1784026800000),
  ('25aea0bac87efba32379226edc32385d55efdd72054271528ea47d4c3f002fcf', 1784030400000),
  ('0b672dce2af34b4c62311680b9cd0d88cc9e3c8ddbbe4308745e7c01b0d24db8', 1784052000000),
  ('6cf0b1b4f5eeb8d97b0e7708c1d872d6221efbd41688c0bb119a2b7f80e54e8d', 1784055600000),
  ('f05db9d9fe215b70a0047f7544af20cc9d7e7dde9b67858b3e1da6edae3ef8b0', 1784112000000),
  ('ad6de06155988cd55ce2da5d743e370b1d76977365dae386b6d37f5487baf7fd', 1784142000000);

-- Generate independent credentials without putting passwords in this file or
-- the SQL Editor query history. Copy the final result grid directly into an
-- approved password manager; closing this SQL Editor session destroys it.
CREATE TEMPORARY TABLE _opentab_bootstrap_credentials (
  role_name text PRIMARY KEY,
  role_password text NOT NULL CHECK (length(role_password) >= 64)
) ON COMMIT PRESERVE ROWS;

INSERT INTO _opentab_bootstrap_credentials (role_name, role_password)
VALUES
  ('opentab_runtime', replace(gen_random_uuid()::text || gen_random_uuid()::text || gen_random_uuid()::text, '-', '')),
  ('opentab_indexer', replace(gen_random_uuid()::text || gen_random_uuid()::text || gen_random_uuid()::text, '-', '')),
  ('opentab_evidence_writer', replace(gen_random_uuid()::text || gen_random_uuid()::text || gen_random_uuid()::text, '-', ''));

DO $opentab_roles$
DECLARE
  credential record;
  granted_role name;
  connection_limit integer;
BEGIN
  FOR credential IN
    SELECT role_name, role_password
    FROM _opentab_bootstrap_credentials
    ORDER BY role_name
  LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = credential.role_name) THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = format('OpenTab role %I already exists; this setup file is fresh-project only.', credential.role_name);
    END IF;

    connection_limit := CASE credential.role_name
      WHEN 'opentab_runtime' THEN 30
      WHEN 'opentab_indexer' THEN 12
      ELSE 2
    END;

    EXECUTE format(
      'CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT %s',
      credential.role_name,
      credential.role_password,
      connection_limit
    );

    FOR granted_role IN
      SELECT parent.rolname
      FROM pg_catalog.pg_auth_members membership
      INNER JOIN pg_catalog.pg_roles member ON member.oid = membership.member
      INNER JOIN pg_catalog.pg_roles parent ON parent.oid = membership.roleid
      WHERE member.rolname = credential.role_name
    LOOP
      EXECUTE format('REVOKE %I FROM %I', granted_role, credential.role_name);
    END LOOP;

    EXECUTE format('REVOKE ALL PRIVILEGES ON DATABASE %I FROM %I', current_database(), credential.role_name);
    EXECUTE format('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM %I', credential.role_name);
    EXECUTE format('REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM %I', credential.role_name);
    EXECUTE format('REVOKE ALL PRIVILEGES ON SCHEMA public FROM %I', credential.role_name);
    EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM %I', current_database(), credential.role_name);
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), credential.role_name);
    EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', credential.role_name);
  END LOOP;
END
$opentab_roles$;

-- Table-level REVOKE does not clear column-level ACLs. Clear every possible
-- column grant before applying the exact role allowlists below.
DO $opentab_clear_column_acls$
DECLARE
  target_role text;
  relation record;
  denied_privilege text;
BEGIN
  FOREACH target_role IN ARRAY ARRAY['opentab_runtime', 'opentab_indexer', 'opentab_evidence_writer']::text[]
  LOOP
    FOR relation IN
      SELECT class.relname,
        string_agg(format('%I', attribute.attname), ', ' ORDER BY attribute.attnum) AS columns
      FROM pg_catalog.pg_class class
      INNER JOIN pg_catalog.pg_namespace namespace ON namespace.oid = class.relnamespace
      INNER JOIN pg_catalog.pg_attribute attribute ON attribute.attrelid = class.oid
      WHERE namespace.nspname = 'public'
        AND class.relkind IN ('r', 'p')
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
      GROUP BY class.relname
    LOOP
      FOREACH denied_privilege IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']::text[]
      LOOP
        EXECUTE format(
          'REVOKE %s (%s) ON TABLE public.%I FROM %I',
          denied_privilege,
          relation.columns,
          relation.relname,
          target_role
        );
      END LOOP;
    END LOOP;
  END LOOP;
END
$opentab_clear_column_acls$;

-- A role cannot be denied privileges inherited through PUBLIC. This dedicated
-- OpenTab project therefore removes public-schema object creation and database
-- temporary-table access globally before granting the application allowlists.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
DO $opentab_revoke_public_temp$
BEGIN
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
END
$opentab_revoke_public_temp$;

ALTER ROLE opentab_runtime SET search_path = pg_catalog, public;
ALTER ROLE opentab_runtime SET statement_timeout = '30s';
ALTER ROLE opentab_runtime SET lock_timeout = '10s';
ALTER ROLE opentab_runtime SET idle_in_transaction_session_timeout = '15s';

ALTER ROLE opentab_indexer SET search_path = pg_catalog, public;
ALTER ROLE opentab_indexer SET statement_timeout = '120s';
ALTER ROLE opentab_indexer SET idle_in_transaction_session_timeout = '30s';

ALTER ROLE opentab_evidence_writer SET search_path = pg_catalog, public;
ALTER ROLE opentab_evidence_writer SET statement_timeout = '30s';
ALTER ROLE opentab_evidence_writer SET idle_in_transaction_session_timeout = '15s';

-- Web/API role: ordinary application DML, append-only audit history, narrowly
-- mutable Judge publication metadata, pre-canonical order workflow fields,
-- and read-only canonical/indexer projections.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO opentab_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO opentab_runtime;

REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.judge_evidence FROM opentab_runtime;
GRANT UPDATE (share_token_hash, published, expires_at, revoked_at, updated_at)
  ON TABLE public.judge_evidence TO opentab_runtime;

REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.audit_logs FROM opentab_runtime;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.live_acceptance_evidence FROM opentab_runtime;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public."chain_transactions", public."indexed_blocks", public."indexer_cursors", public."canonical_logs", public."reorg_incidents", public."receipts" FROM opentab_runtime;

REVOKE INSERT, UPDATE, DELETE ON TABLE public.orders FROM opentab_runtime;
GRANT INSERT (
  id, checkout_session_id, order_key, user_id, merchant_id, product_id, payer,
  recipient, token_address, quantity, amount_base_units, status, chain_id,
  provider_operation_id, intent_digest, refundable_until, version, created_at, updated_at
) ON TABLE public.orders TO opentab_runtime;
GRANT UPDATE (status, provider_operation_id, version, updated_at)
  ON TABLE public.orders TO opentab_runtime;

-- Indexer role: exact read/insert/update allowlists, no delete, DDL, TEMP,
-- sequence, trigger, reference, or arbitrary table access.
GRANT SELECT ON TABLE public."bootstrap_grants", public."canonical_logs", public."chain_event_quarantine", public."contract_operations", public."dead_letters", public."indexed_blocks", public."indexer_cursors", public."judge_evidence", public."loyalty_awards", public."loyalty_balances", public."loyalty_programs", public."merchants", public."orders", public."outbox_events", public."payment_attempts", public."products", public."provider_operations", public."receipts", public."refunds", public."reorg_incidents", public."settlement_credits", public."signed_order_intents", public."sponsor_audit_events", public."split_invitations", public."split_participants", public."split_payments", public."splits", public."users", public."withdrawals" TO opentab_indexer;
GRANT INSERT ON TABLE public."canonical_logs", public."chain_event_quarantine", public."dead_letters", public."indexed_blocks", public."indexer_cursors", public."loyalty_awards", public."loyalty_balances", public."outbox_events", public."provider_operations", public."receipts", public."reorg_incidents", public."settlement_credits", public."sponsor_audit_events" TO opentab_indexer;
GRANT UPDATE ON TABLE public."bootstrap_grants", public."canonical_logs", public."chain_event_quarantine", public."contract_operations", public."indexed_blocks", public."indexer_cursors", public."loyalty_awards", public."loyalty_balances", public."merchants", public."orders", public."payment_attempts", public."products", public."provider_operations", public."receipts", public."refunds", public."settlement_credits", public."split_invitations", public."split_participants", public."split_payments", public."splits", public."withdrawals" TO opentab_indexer;
GRANT UPDATE (published, share_token_hash, expires_at, revoked_at, updated_at)
  ON TABLE public.judge_evidence TO opentab_indexer;

-- Live-acceptance writer: exact canonical reads and one append-only evidence
-- insert boundary. It receives no sequence access because the evidence ID is
-- UUID-based.
GRANT SELECT ON TABLE public."user_identities", public."merchants", public."products", public."signed_order_intents", public."orders", public."payment_attempts", public."provider_operations", public."canonical_logs", public."receipts", public."wallet_accounts", public."delegation_records", public."bootstrap_grants", public."live_acceptance_evidence" TO opentab_evidence_writer;
GRANT INSERT ON TABLE public.live_acceptance_evidence TO opentab_evidence_writer;

-- Supabase enables RLS on public tables. Keep that protection for its anon and
-- authenticated API roles while allowing only OpenTab's isolated service roles.
-- Table/column GRANTs above remain the authoritative operation boundary.
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;

-- Table-level REVOKE does not clear legacy column ACLs.
DO $opentab_revoke_supabase_api_columns$
DECLARE
  api_role text;
  relation record;
  denied_privilege text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated']::text[]
  LOOP
    FOR relation IN
      SELECT class.relname,
        string_agg(format('%I', attribute.attname), ', ' ORDER BY attribute.attnum) AS columns
      FROM pg_catalog.pg_class class
      INNER JOIN pg_catalog.pg_namespace namespace ON namespace.oid = class.relnamespace
      INNER JOIN pg_catalog.pg_attribute attribute ON attribute.attrelid = class.oid
      WHERE namespace.nspname = 'public'
        AND class.relkind IN ('r', 'p')
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
      GROUP BY class.relname
    LOOP
      FOREACH denied_privilege IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']::text[]
      LOOP
        EXECUTE format(
          'REVOKE %s (%s) ON TABLE public.%I FROM %I',
          denied_privilege,
          relation.columns,
          relation.relname,
          api_role
        );
      END LOOP;
    END LOOP;
  END LOOP;
END
$opentab_revoke_supabase_api_columns$;

DO $opentab_backend_rls$
DECLARE
  relation record;
BEGIN
  FOR relation IN
    SELECT namespace.nspname AS schema_name, class.relname AS table_name
    FROM pg_catalog.pg_class class
    INNER JOIN pg_catalog.pg_namespace namespace ON namespace.oid = class.relnamespace
    WHERE namespace.nspname = 'public'
      AND class.relkind IN ('r', 'p')
    ORDER BY class.relname
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY',
      relation.schema_name,
      relation.table_name
    );
    EXECUTE format(
      'DROP POLICY IF EXISTS opentab_backend_roles ON %I.%I',
      relation.schema_name,
      relation.table_name
    );
    EXECUTE format(
      'CREATE POLICY opentab_backend_roles ON %I.%I AS PERMISSIVE FOR ALL TO opentab_runtime, opentab_indexer, opentab_evidence_writer USING (true) WITH CHECK (true)',
      relation.schema_name,
      relation.table_name
    );
  END LOOP;
END
$opentab_backend_rls$;

DO $opentab_validate_backend_rls$
DECLARE
  invalid boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class relation
    INNER JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relkind IN ('r', 'p')
      AND (
        NOT relation.relrowsecurity
        OR NOT EXISTS (
          SELECT 1
          FROM pg_catalog.pg_policy policy
          WHERE policy.polrelid = relation.oid
            AND policy.polname = 'opentab_backend_roles'
            AND policy.polcmd = '*'
            AND policy.polpermissive
            AND cardinality(policy.polroles) = 3
            AND (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'opentab_runtime') = ANY (policy.polroles)
            AND (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'opentab_indexer') = ANY (policy.polroles)
            AND (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'opentab_evidence_writer') = ANY (policy.polroles)
            AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) = 'true'
            AND pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid) = 'true'
        )
      )
  ) INTO invalid;
  IF invalid THEN
    RAISE EXCEPTION 'OpenTab backend RLS policy coverage is invalid.';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class relation
    INNER JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relkind IN ('r', 'p')
      AND (
        pg_catalog.has_table_privilege('anon', relation.oid, 'SELECT')
        OR pg_catalog.has_table_privilege('anon', relation.oid, 'INSERT')
        OR pg_catalog.has_table_privilege('anon', relation.oid, 'UPDATE')
        OR pg_catalog.has_table_privilege('anon', relation.oid, 'DELETE')
        OR pg_catalog.has_any_column_privilege('anon', relation.oid, 'SELECT')
        OR pg_catalog.has_any_column_privilege('anon', relation.oid, 'INSERT')
        OR pg_catalog.has_any_column_privilege('anon', relation.oid, 'UPDATE')
        OR pg_catalog.has_any_column_privilege('anon', relation.oid, 'REFERENCES')
        OR pg_catalog.has_table_privilege('authenticated', relation.oid, 'SELECT')
        OR pg_catalog.has_table_privilege('authenticated', relation.oid, 'INSERT')
        OR pg_catalog.has_table_privilege('authenticated', relation.oid, 'UPDATE')
        OR pg_catalog.has_table_privilege('authenticated', relation.oid, 'DELETE')
        OR pg_catalog.has_any_column_privilege('authenticated', relation.oid, 'SELECT')
        OR pg_catalog.has_any_column_privilege('authenticated', relation.oid, 'INSERT')
        OR pg_catalog.has_any_column_privilege('authenticated', relation.oid, 'UPDATE')
        OR pg_catalog.has_any_column_privilege('authenticated', relation.oid, 'REFERENCES')
      )
  ) INTO invalid;
  IF invalid THEN
    RAISE EXCEPTION 'Supabase public API roles retain OpenTab table privileges.';
  END IF;
END
$opentab_validate_backend_rls$;


-- Fail the transaction if role attributes or the exact table allowlists drift
-- from the application startup assertions.
DO $opentab_validate_roles$
DECLARE
  target_role text;
  role_oid oid;
  invalid boolean;
  required_read text[];
  required_insert text[];
  required_update text[];
  allowed_special text[] := ARRAY[
    'orders', 'judge_evidence', 'audit_logs', 'live_acceptance_evidence',
    'chain_transactions', 'indexed_blocks', 'indexer_cursors', 'canonical_logs',
    'reorg_incidents', 'receipts'
  ]::text[];
BEGIN
  FOREACH target_role IN ARRAY ARRAY['opentab_runtime', 'opentab_indexer', 'opentab_evidence_writer']::text[]
  LOOP
    SELECT oid INTO role_oid FROM pg_catalog.pg_roles WHERE rolname = target_role;
    IF role_oid IS NULL THEN
      RAISE EXCEPTION 'Required OpenTab role % is missing.', target_role;
    END IF;

    SELECT
      NOT role.rolcanlogin OR role.rolinherit OR role.rolsuper OR role.rolcreatedb
      OR role.rolcreaterole OR role.rolreplication OR role.rolbypassrls
      OR database.datdba = role.oid
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE member = role.oid)
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspowner = role.oid)
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE relowner = role.oid)
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc WHERE proowner = role.oid)
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_type WHERE typowner = role.oid)
      OR NOT pg_catalog.has_database_privilege(role.oid, database.oid, 'CONNECT')
      OR pg_catalog.has_database_privilege(role.oid, database.oid, 'CREATE')
      OR pg_catalog.has_database_privilege(role.oid, database.oid, 'TEMP')
      OR NOT pg_catalog.has_schema_privilege(role.oid, public_namespace.oid, 'USAGE')
      OR pg_catalog.has_schema_privilege(role.oid, public_namespace.oid, 'CREATE')
    INTO invalid
    FROM pg_catalog.pg_roles role
    INNER JOIN pg_catalog.pg_database database ON database.datname = current_database()
    INNER JOIN pg_catalog.pg_namespace public_namespace ON public_namespace.nspname = 'public'
    WHERE role.oid = role_oid;

    IF invalid THEN
      RAISE EXCEPTION 'OpenTab role % failed its base privilege boundary.', target_role;
    END IF;
  END LOOP;

  SELECT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class relation
    INNER JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relkind IN ('r', 'p')
      AND relation.relname <> ALL (allowed_special)
      AND NOT (
        pg_catalog.has_table_privilege('opentab_runtime', relation.oid, 'SELECT')
        AND pg_catalog.has_table_privilege('opentab_runtime', relation.oid, 'INSERT')
        AND pg_catalog.has_table_privilege('opentab_runtime', relation.oid, 'UPDATE')
        AND pg_catalog.has_table_privilege('opentab_runtime', relation.oid, 'DELETE')
      )
  ) INTO invalid;
  IF invalid THEN
    RAISE EXCEPTION 'OpenTab runtime role is missing ordinary application DML.';
  END IF;

  IF NOT pg_catalog.has_table_privilege('opentab_runtime', 'public.orders', 'SELECT')
    OR pg_catalog.has_table_privilege('opentab_runtime', 'public.orders', 'INSERT')
    OR pg_catalog.has_table_privilege('opentab_runtime', 'public.orders', 'UPDATE')
    OR pg_catalog.has_table_privilege('opentab_runtime', 'public.orders', 'DELETE')
    OR NOT pg_catalog.has_column_privilege('opentab_runtime', 'public.orders', 'id', 'INSERT')
    OR NOT pg_catalog.has_column_privilege('opentab_runtime', 'public.orders', 'status', 'UPDATE')
    OR pg_catalog.has_column_privilege('opentab_runtime', 'public.orders', 'paid_amount_base_units', 'INSERT')
    OR pg_catalog.has_column_privilege('opentab_runtime', 'public.orders', 'transaction_hash', 'UPDATE')
  THEN
    RAISE EXCEPTION 'OpenTab runtime order boundary is invalid.';
  END IF;

  IF NOT pg_catalog.has_table_privilege('opentab_runtime', 'public.judge_evidence', 'SELECT')
    OR NOT pg_catalog.has_table_privilege('opentab_runtime', 'public.judge_evidence', 'INSERT')
    OR pg_catalog.has_table_privilege('opentab_runtime', 'public.judge_evidence', 'UPDATE')
    OR NOT pg_catalog.has_column_privilege('opentab_runtime', 'public.judge_evidence', 'published', 'UPDATE')
    OR pg_catalog.has_column_privilege('opentab_runtime', 'public.judge_evidence', 'public_proof', 'UPDATE')
    OR NOT pg_catalog.has_table_privilege('opentab_runtime', 'public.audit_logs', 'INSERT')
  THEN
    RAISE EXCEPTION 'OpenTab runtime append-only/Judge boundary is invalid.';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class relation
    INNER JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relkind IN ('r', 'p')
      AND relation.relname = ANY (ARRAY['chain_transactions', 'indexed_blocks', 'indexer_cursors', 'canonical_logs', 'reorg_incidents', 'receipts']::text[])
      AND (
        pg_catalog.has_table_privilege('opentab_runtime', relation.oid, 'INSERT')
        OR pg_catalog.has_table_privilege('opentab_runtime', relation.oid, 'UPDATE')
        OR pg_catalog.has_table_privilege('opentab_runtime', relation.oid, 'DELETE')
        OR pg_catalog.has_any_column_privilege('opentab_runtime', relation.oid, 'INSERT')
        OR pg_catalog.has_any_column_privilege('opentab_runtime', relation.oid, 'UPDATE')
      )
  ) INTO invalid;
  IF invalid
    OR pg_catalog.has_table_privilege('opentab_runtime', 'public.live_acceptance_evidence', 'INSERT')
    OR pg_catalog.has_table_privilege('opentab_runtime', 'public.live_acceptance_evidence', 'UPDATE')
  THEN
    RAISE EXCEPTION 'OpenTab runtime canonical/evidence boundary is invalid.';
  END IF;

  required_read := ARRAY['bootstrap_grants', 'canonical_logs', 'chain_event_quarantine', 'contract_operations', 'dead_letters', 'indexed_blocks', 'indexer_cursors', 'judge_evidence', 'loyalty_awards', 'loyalty_balances', 'loyalty_programs', 'merchants', 'orders', 'outbox_events', 'payment_attempts', 'products', 'provider_operations', 'receipts', 'refunds', 'reorg_incidents', 'settlement_credits', 'signed_order_intents', 'sponsor_audit_events', 'split_invitations', 'split_participants', 'split_payments', 'splits', 'users', 'withdrawals']::text[];
  required_insert := ARRAY['canonical_logs', 'chain_event_quarantine', 'dead_letters', 'indexed_blocks', 'indexer_cursors', 'loyalty_awards', 'loyalty_balances', 'outbox_events', 'provider_operations', 'receipts', 'reorg_incidents', 'settlement_credits', 'sponsor_audit_events']::text[];
  required_update := ARRAY['bootstrap_grants', 'canonical_logs', 'chain_event_quarantine', 'contract_operations', 'indexed_blocks', 'indexer_cursors', 'loyalty_awards', 'loyalty_balances', 'merchants', 'orders', 'payment_attempts', 'products', 'provider_operations', 'receipts', 'refunds', 'settlement_credits', 'split_invitations', 'split_participants', 'split_payments', 'splits', 'withdrawals']::text[];
  SELECT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class relation
    INNER JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public' AND relation.relkind IN ('r', 'p') AND (
      (relation.relname = ANY (required_read)) <> pg_catalog.has_table_privilege('opentab_indexer', relation.oid, 'SELECT')
      OR (relation.relname = ANY (required_insert)) <> pg_catalog.has_table_privilege('opentab_indexer', relation.oid, 'INSERT')
      OR (
        relation.relname <> 'judge_evidence'
        AND (relation.relname = ANY (required_update)) <> pg_catalog.has_table_privilege('opentab_indexer', relation.oid, 'UPDATE')
      )
      OR pg_catalog.has_table_privilege('opentab_indexer', relation.oid, 'DELETE')
      OR pg_catalog.has_table_privilege('opentab_indexer', relation.oid, 'TRUNCATE')
      OR pg_catalog.has_table_privilege('opentab_indexer', relation.oid, 'REFERENCES')
      OR pg_catalog.has_table_privilege('opentab_indexer', relation.oid, 'TRIGGER')
    )
  ) INTO invalid;
  IF invalid
    OR pg_catalog.has_table_privilege('opentab_indexer', 'public.judge_evidence', 'UPDATE')
    OR NOT pg_catalog.has_column_privilege('opentab_indexer', 'public.judge_evidence', 'published', 'UPDATE')
    OR pg_catalog.has_column_privilege('opentab_indexer', 'public.judge_evidence', 'public_proof', 'UPDATE')
  THEN
    RAISE EXCEPTION 'OpenTab indexer exact allowlist is invalid.';
  END IF;

  required_read := ARRAY['user_identities', 'merchants', 'products', 'signed_order_intents', 'orders', 'payment_attempts', 'provider_operations', 'canonical_logs', 'receipts', 'wallet_accounts', 'delegation_records', 'bootstrap_grants', 'live_acceptance_evidence']::text[];
  SELECT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class relation
    INNER JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public' AND relation.relkind IN ('r', 'p') AND (
      (relation.relname = ANY (required_read)) <> pg_catalog.has_table_privilege('opentab_evidence_writer', relation.oid, 'SELECT')
      OR (relation.relname = 'live_acceptance_evidence') <> pg_catalog.has_table_privilege('opentab_evidence_writer', relation.oid, 'INSERT')
      OR pg_catalog.has_table_privilege('opentab_evidence_writer', relation.oid, 'UPDATE')
      OR pg_catalog.has_table_privilege('opentab_evidence_writer', relation.oid, 'DELETE')
      OR pg_catalog.has_table_privilege('opentab_evidence_writer', relation.oid, 'TRUNCATE')
      OR pg_catalog.has_table_privilege('opentab_evidence_writer', relation.oid, 'REFERENCES')
      OR pg_catalog.has_table_privilege('opentab_evidence_writer', relation.oid, 'TRIGGER')
    )
  ) INTO invalid;
  IF invalid THEN
    RAISE EXCEPTION 'OpenTab evidence-writer exact allowlist is invalid.';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class sequence_relation
    INNER JOIN pg_catalog.pg_namespace namespace ON namespace.oid = sequence_relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND sequence_relation.relkind = 'S'
      AND (
        pg_catalog.has_sequence_privilege('opentab_indexer', sequence_relation.oid, 'USAGE')
        OR pg_catalog.has_sequence_privilege('opentab_indexer', sequence_relation.oid, 'SELECT')
        OR pg_catalog.has_sequence_privilege('opentab_indexer', sequence_relation.oid, 'UPDATE')
        OR pg_catalog.has_sequence_privilege('opentab_evidence_writer', sequence_relation.oid, 'USAGE')
        OR pg_catalog.has_sequence_privilege('opentab_evidence_writer', sequence_relation.oid, 'SELECT')
        OR pg_catalog.has_sequence_privilege('opentab_evidence_writer', sequence_relation.oid, 'UPDATE')
      )
  ) INTO invalid;
  IF invalid THEN
    RAISE EXCEPTION 'An isolated OpenTab role unexpectedly has sequence privileges.';
  END IF;
END
$opentab_validate_roles$;

COMMIT;

-- SECRET OUTPUT: copy these three values into your password manager now.
-- The role names become the usernames in Vercel/Railway Supabase URLs.
SELECT
  role_name,
  role_password,
  CASE role_name
    WHEN 'opentab_runtime' THEN 'Vercel DATABASE_URL (transaction pooler :6543)'
    WHEN 'opentab_indexer' THEN 'Railway DATABASE_URL_INDEXER (session/direct :5432)'
    ELSE 'Protected DATABASE_URL_EVIDENCE_WRITER (session/direct :5432)'
  END AS use_for
FROM _opentab_bootstrap_credentials
ORDER BY role_name;
