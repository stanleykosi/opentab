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
