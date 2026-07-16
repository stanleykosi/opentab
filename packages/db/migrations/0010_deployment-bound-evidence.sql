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
