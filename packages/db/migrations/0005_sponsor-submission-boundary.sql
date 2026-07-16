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
