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
