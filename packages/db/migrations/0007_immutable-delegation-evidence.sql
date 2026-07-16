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
