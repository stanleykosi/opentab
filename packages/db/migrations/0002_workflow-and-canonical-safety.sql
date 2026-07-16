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
