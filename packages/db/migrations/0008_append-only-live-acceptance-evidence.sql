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
