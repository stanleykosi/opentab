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