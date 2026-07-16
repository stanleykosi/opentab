ALTER TABLE "live_acceptance_evidence"
  ADD COLUMN "release_id" varchar(40) DEFAULT '0000000000000000000000000000000000000000' NOT NULL;
--> statement-breakpoint
ALTER TABLE "live_acceptance_evidence"
  ALTER COLUMN "release_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "live_acceptance_evidence"
  ADD CONSTRAINT "live_acceptance_evidence_release_id_check"
  CHECK ("release_id" ~ '^[0-9a-fA-F]{40}$');
