ALTER TABLE "withdrawals" ADD COLUMN IF NOT EXISTS "provider_operation_id" varchar(256);
CREATE UNIQUE INDEX IF NOT EXISTS "withdrawals_provider_operation_unique"
  ON "withdrawals" USING btree ("provider_operation_id");
CREATE UNIQUE INDEX IF NOT EXISTS "dead_letters_kind_business_unique"
  ON "dead_letters" USING btree ("kind", "business_key");
