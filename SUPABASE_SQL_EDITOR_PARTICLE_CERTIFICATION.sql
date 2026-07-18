-- OpenTab — incremental Particle compatibility certification storage
-- GENERATED FILE. Source: 0011_particle-compatibility-profiles.sql + least-privilege Supabase policy.
-- Regenerate with: pnpm db:supabase:sql
--
-- Run this entire file once in the existing dedicated OpenTab Supabase project.
-- It does not rotate service-role passwords or enable payments.

BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '10min';
SET LOCAL search_path = public, pg_catalog;
SELECT pg_advisory_xact_lock(714480106095748);

DO $opentab_particle_certification_preflight$
BEGIN
  IF to_regclass('public.users') IS NULL
    OR to_regclass('public.live_acceptance_evidence') IS NULL
    OR to_regclass('drizzle.__drizzle_migrations') IS NULL
  THEN
    RAISE EXCEPTION 'OpenTab base schema is missing; use the fresh-project setup instead.';
  END IF;
  IF to_regclass('public.particle_compatibility_profiles') IS NOT NULL
    OR to_regclass('public.particle_profile_release_bindings') IS NOT NULL
  THEN
    RAISE EXCEPTION 'Particle certification storage already exists; do not reapply this file.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'opentab_runtime')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'opentab_indexer')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'opentab_evidence_writer')
  THEN
    RAISE EXCEPTION 'OpenTab service roles are missing; do not apply a partial certification migration.';
  END IF;
END
$opentab_particle_certification_preflight$;

-- ---------------------------------------------------------------------------
-- 0011_particle-compatibility-profiles.sql
-- SHA-256: 41f366d6c21ffaae29875f0b2f1368feb2c9117437eb22ef3b990b6bb94824b6
-- ---------------------------------------------------------------------------
CREATE TABLE "particle_compatibility_profiles" (
  "profile_id" varchar(128) PRIMARY KEY NOT NULL,
  "schema_version" integer NOT NULL,
  "stage" varchar(20) NOT NULL,
  "environment" "feature_flag_environment" NOT NULL,
  "chain_id" numeric(78, 0) NOT NULL,
  "particle_sdk_version" varchar(20) NOT NULL,
  "particle_protocol_version" varchar(40) NOT NULL,
  "particle_project_config_digest" varchar(66) NOT NULL,
  "use_eip7702" boolean NOT NULL,
  "delegate_address" varchar(42) NOT NULL,
  "delegate_code_hash" varchar(66) NOT NULL,
  "response_digests" jsonb NOT NULL,
  "nonce_convention" jsonb NOT NULL,
  "source_token_profile" jsonb,
  "canonical_canary_evidence" jsonb,
  "captured_at" timestamp with time zone NOT NULL,
  "profile_digest" varchar(66) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "particle_compatibility_profiles_version_check" CHECK ("schema_version" = 1),
  CONSTRAINT "particle_compatibility_profiles_id_check" CHECK ("profile_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$'),
  CONSTRAINT "particle_compatibility_profiles_stage_check" CHECK ("stage" IN ('bootstrap', 'canary_ready', 'certified')),
  CONSTRAINT "particle_compatibility_profiles_environment_check" CHECK ("environment" IN ('demo-mainnet', 'production')),
  CONSTRAINT "particle_compatibility_profiles_chain_check" CHECK ("chain_id" = 42161),
  CONSTRAINT "particle_compatibility_profiles_sdk_check" CHECK ("particle_sdk_version" = '2.0.3'),
  CONSTRAINT "particle_compatibility_profiles_eip7702_check" CHECK ("use_eip7702" = true),
  CONSTRAINT "particle_compatibility_profiles_delegate_check" CHECK ("delegate_address" ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT "particle_compatibility_profiles_digests_check" CHECK (
    "particle_project_config_digest" ~ '^0x[0-9a-f]{64}$'
    AND "delegate_code_hash" ~ '^0x[0-9a-f]{64}$'
    AND "profile_digest" ~ '^0x[0-9a-f]{64}$'
  ),
  CONSTRAINT "particle_compatibility_profiles_json_check" CHECK (
    jsonb_typeof("response_digests") = 'object'
    AND jsonb_typeof("nonce_convention") = 'object'
    AND ("source_token_profile" IS NULL OR jsonb_typeof("source_token_profile") = 'object')
    AND ("canonical_canary_evidence" IS NULL OR jsonb_typeof("canonical_canary_evidence") = 'object')
  ),
  CONSTRAINT "particle_compatibility_profiles_stage_evidence_check" CHECK (
    (
      "stage" = 'bootstrap'
      AND "source_token_profile" IS NULL
      AND "canonical_canary_evidence" IS NULL
      AND NOT ("response_digests" ? 'submission')
      AND NOT ("response_digests" ? 'status')
    ) OR (
      "stage" = 'canary_ready'
      AND "source_token_profile" IS NOT NULL
      AND "canonical_canary_evidence" IS NULL
      AND NOT ("response_digests" ? 'submission')
      AND NOT ("response_digests" ? 'status')
    ) OR (
      "stage" = 'certified'
      AND "source_token_profile" IS NOT NULL
      AND "canonical_canary_evidence" IS NOT NULL
      AND "response_digests" ? 'submission'
      AND "response_digests" ? 'status'
    )
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX "particle_compatibility_profiles_digest_unique"
  ON "particle_compatibility_profiles" ("profile_digest");
--> statement-breakpoint
CREATE INDEX "particle_compatibility_profiles_lookup_idx"
  ON "particle_compatibility_profiles" ("environment", "chain_id", "stage", "captured_at");
--> statement-breakpoint
CREATE TABLE "particle_profile_release_bindings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "schema_version" integer NOT NULL,
  "environment" "feature_flag_environment" NOT NULL,
  "application_release_id" varchar(40) NOT NULL,
  "chain_id" numeric(78, 0) NOT NULL,
  "stage" varchar(20) NOT NULL,
  "profile_id" varchar(128) NOT NULL,
  "profile_digest" varchar(66) NOT NULL,
  "certified_subject_hash" varchar(66) NOT NULL,
  "canary_product_id" numeric(78, 0) NOT NULL,
  "canary_max_base_units" numeric(78, 0) NOT NULL,
  "bound_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "particle_profile_release_bindings_profile_fk"
    FOREIGN KEY ("profile_id") REFERENCES "particle_compatibility_profiles"("profile_id") ON DELETE RESTRICT,
  CONSTRAINT "particle_profile_release_bindings_version_check" CHECK ("schema_version" = 1),
  CONSTRAINT "particle_profile_release_bindings_environment_check" CHECK ("environment" IN ('demo-mainnet', 'production')),
  CONSTRAINT "particle_profile_release_bindings_chain_check" CHECK ("chain_id" = 42161),
  CONSTRAINT "particle_profile_release_bindings_release_check" CHECK ("application_release_id" ~ '^[0-9a-f]{40}$'),
  CONSTRAINT "particle_profile_release_bindings_stage_check" CHECK ("stage" IN ('bootstrap', 'canary_ready', 'certified')),
  CONSTRAINT "particle_profile_release_bindings_digests_check" CHECK (
    "profile_digest" ~ '^0x[0-9a-f]{64}$'
    AND "certified_subject_hash" ~ '^0x[0-9a-f]{64}$'
  ),
  CONSTRAINT "particle_profile_release_bindings_canary_check" CHECK (
    "canary_product_id" > 0
    AND "canary_max_base_units" > 0
    AND "canary_max_base_units" <= 1000000
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX "particle_profile_release_bindings_profile_unique"
  ON "particle_profile_release_bindings" ("profile_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "particle_profile_release_bindings_stage_unique"
  ON "particle_profile_release_bindings" ("environment", "application_release_id", "chain_id", "stage");
--> statement-breakpoint
CREATE INDEX "particle_profile_release_bindings_lookup_idx"
  ON "particle_profile_release_bindings" ("environment", "application_release_id", "chain_id", "bound_at", "id");
--> statement-breakpoint
CREATE FUNCTION "reject_particle_certification_mutation"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = 'Particle compatibility certification is append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "particle_compatibility_profiles_append_only"
BEFORE UPDATE OR DELETE ON "particle_compatibility_profiles"
FOR EACH ROW EXECUTE FUNCTION "reject_particle_certification_mutation"();
--> statement-breakpoint
CREATE TRIGGER "particle_compatibility_profiles_no_truncate"
BEFORE TRUNCATE ON "particle_compatibility_profiles"
FOR EACH STATEMENT EXECUTE FUNCTION "reject_particle_certification_mutation"();
--> statement-breakpoint
CREATE TRIGGER "particle_profile_release_bindings_append_only"
BEFORE UPDATE OR DELETE ON "particle_profile_release_bindings"
FOR EACH ROW EXECUTE FUNCTION "reject_particle_certification_mutation"();
--> statement-breakpoint
CREATE TRIGGER "particle_profile_release_bindings_no_truncate"
BEFORE TRUNCATE ON "particle_profile_release_bindings"
FOR EACH STATEMENT EXECUTE FUNCTION "reject_particle_certification_mutation"();
--> statement-breakpoint
CREATE FUNCTION "certify_particle_compatibility_profile"(
  p_profile jsonb,
  p_binding jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_profile_keys constant text[] := ARRAY[
    'schemaVersion', 'profileId', 'stage', 'environment', 'chainId',
    'particleSdkVersion', 'particleProtocolVersion', 'particleProjectConfigDigest',
    'useEIP7702', 'delegateAddress', 'delegateCodeHash', 'responseDigests',
    'nonceConvention', 'sourceTokenProfile', 'canonicalCanaryEvidence', 'capturedAt'
  ];
  v_binding_keys constant text[] := ARRAY[
    'schemaVersion', 'environment', 'applicationReleaseId', 'chainId', 'stage',
    'profileId', 'profileDigest', 'certifiedSubjectHash', 'canaryProductId',
    'canaryMaxBaseUnits', 'boundAt'
  ];
  v_profile_required constant text[] := ARRAY[
    'schemaVersion', 'profileId', 'stage', 'environment', 'chainId',
    'particleSdkVersion', 'particleProtocolVersion', 'particleProjectConfigDigest',
    'useEIP7702', 'delegateAddress', 'delegateCodeHash', 'responseDigests',
    'nonceConvention', 'capturedAt'
  ];
  v_stage text;
  v_environment text;
  v_chain_id numeric(78, 0);
  v_profile_id text;
  v_profile_digest text;
  v_release_id text;
  v_subject_hash text;
  v_canary_product_id numeric(78, 0);
  v_canary_max numeric(78, 0);
  v_captured_at timestamptz;
  v_bound_at timestamptz;
  v_response_digests jsonb;
  v_same record;
  v_current record;
  v_inserted_profile_id text;
  v_binding_id uuid;
BEGIN
  IF jsonb_typeof(p_profile) IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_binding) IS DISTINCT FROM 'object'
    OR NOT (p_profile ?& v_profile_required)
    OR NOT (p_binding ?& v_binding_keys)
    OR EXISTS (
      SELECT 1 FROM jsonb_object_keys(p_profile) AS supplied(key)
      WHERE NOT (supplied.key = ANY (v_profile_keys))
    )
    OR EXISTS (
      SELECT 1 FROM jsonb_object_keys(p_binding) AS supplied(key)
      WHERE NOT (supplied.key = ANY (v_binding_keys))
    )
  THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Particle certification shape is invalid';
  END IF;

  v_stage := p_profile->>'stage';
  v_environment := p_profile->>'environment';
  v_chain_id := (p_profile->>'chainId')::numeric;
  v_profile_id := p_profile->>'profileId';
  v_profile_digest := lower(p_binding->>'profileDigest');
  v_release_id := lower(p_binding->>'applicationReleaseId');
  v_subject_hash := lower(p_binding->>'certifiedSubjectHash');
  v_canary_product_id := (p_binding->>'canaryProductId')::numeric;
  v_canary_max := (p_binding->>'canaryMaxBaseUnits')::numeric;
  v_captured_at := (p_profile->>'capturedAt')::timestamptz;
  v_bound_at := (p_binding->>'boundAt')::timestamptz;
  v_response_digests := p_profile->'responseDigests';

  IF (p_profile->>'schemaVersion')::integer <> 1
    OR (p_binding->>'schemaVersion')::integer <> 1
    OR v_stage NOT IN ('bootstrap', 'canary_ready', 'certified')
    OR v_environment NOT IN ('demo-mainnet', 'production')
    OR v_chain_id <> 42161
    OR p_profile->>'particleSdkVersion' <> '2.0.3'
    OR (p_profile->>'useEIP7702')::boolean IS DISTINCT FROM true
    OR p_binding->>'environment' <> v_environment
    OR (p_binding->>'chainId')::numeric <> v_chain_id
    OR p_binding->>'stage' <> v_stage
    OR p_binding->>'profileId' <> v_profile_id
    OR v_bound_at < v_captured_at
    OR jsonb_typeof(v_response_digests) IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_profile->'nonceConvention') IS DISTINCT FROM 'object'
    OR NOT (v_response_digests ?& ARRAY['deployments', 'auth'])
    OR EXISTS (
      SELECT 1 FROM jsonb_object_keys(v_response_digests) AS supplied(key)
      WHERE supplied.key NOT IN ('deployments', 'auth', 'submission', 'status')
    )
    OR EXISTS (
      SELECT 1 FROM jsonb_object_keys(p_profile->'nonceConvention') AS supplied(key)
      WHERE supplied.key NOT IN ('magicAuthorizationNonceOffset', 'delegationPlanTtlSeconds')
    )
    OR NOT ((p_profile->'nonceConvention') ?& ARRAY['magicAuthorizationNonceOffset', 'delegationPlanTtlSeconds'])
  THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Particle certification binding is invalid';
  END IF;

  IF v_profile_id !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$'
    OR v_release_id !~ '^[0-9a-f]{40}$'
    OR lower(p_profile->>'particleProjectConfigDigest') !~ '^0x[0-9a-f]{64}$'
    OR lower(p_profile->>'delegateAddress') !~ '^0x[0-9a-f]{40}$'
    OR lower(p_profile->>'delegateCodeHash') !~ '^0x[0-9a-f]{64}$'
    OR v_profile_digest !~ '^0x[0-9a-f]{64}$'
    OR v_subject_hash !~ '^0x[0-9a-f]{64}$'
    OR lower(v_response_digests->>'deployments') !~ '^0x[0-9a-f]{64}$'
    OR lower(v_response_digests->>'auth') !~ '^0x[0-9a-f]{64}$'
    OR v_canary_product_id <= 0
    OR v_canary_max <= 0
    OR v_canary_max > 1000000
    OR (p_profile->'nonceConvention'->>'magicAuthorizationNonceOffset')::integer NOT IN (0, 1)
    OR (p_profile->'nonceConvention'->>'delegationPlanTtlSeconds')::integer NOT BETWEEN 30 AND 600
  THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Particle certification value is outside policy';
  END IF;

  IF v_stage = 'bootstrap' THEN
    IF p_profile ? 'sourceTokenProfile'
      OR p_profile ? 'canonicalCanaryEvidence'
      OR v_response_digests ? 'submission'
      OR v_response_digests ? 'status'
    THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Bootstrap stage overclaims evidence';
    END IF;
  ELSIF v_stage = 'canary_ready' THEN
    IF NOT (p_profile ? 'sourceTokenProfile')
      OR p_profile ? 'canonicalCanaryEvidence'
      OR v_response_digests ? 'submission'
      OR v_response_digests ? 'status'
      OR jsonb_typeof(p_profile->'sourceTokenProfile') IS DISTINCT FROM 'object'
    THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Canary-ready stage evidence is incomplete';
    END IF;
  ELSE
    IF NOT (p_profile ?& ARRAY['sourceTokenProfile', 'canonicalCanaryEvidence'])
      OR NOT (v_response_digests ?& ARRAY['submission', 'status'])
      OR jsonb_typeof(p_profile->'sourceTokenProfile') IS DISTINCT FROM 'object'
      OR jsonb_typeof(p_profile->'canonicalCanaryEvidence') IS DISTINCT FROM 'object'
      OR lower(v_response_digests->>'submission') !~ '^0x[0-9a-f]{64}$'
      OR lower(v_response_digests->>'status') !~ '^0x[0-9a-f]{64}$'
    THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Certified stage evidence is incomplete';
    END IF;
  END IF;

  IF p_profile ? 'sourceTokenProfile' AND (
    NOT ((p_profile->'sourceTokenProfile') ?& ARRAY[
      'allowedSourceChainIds', 'allowedSourceAssets', 'allowedSourceTokens', 'sourceCallPolicies'
    ])
    OR EXISTS (
      SELECT 1 FROM jsonb_object_keys(p_profile->'sourceTokenProfile') AS supplied(key)
      WHERE supplied.key NOT IN (
        'allowedSourceChainIds', 'allowedSourceAssets', 'allowedSourceTokens', 'sourceCallPolicies'
      )
    )
    OR jsonb_typeof(p_profile->'sourceTokenProfile'->'allowedSourceChainIds') IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_profile->'sourceTokenProfile'->'allowedSourceAssets') IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_profile->'sourceTokenProfile'->'allowedSourceTokens') IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_profile->'sourceTokenProfile'->'sourceCallPolicies') IS DISTINCT FROM 'array'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Particle source-token policy shape is invalid';
  END IF;

  IF p_profile ? 'canonicalCanaryEvidence' AND (
    NOT ((p_profile->'canonicalCanaryEvidence') ?& ARRAY[
      'paymentAttemptId', 'orderKey', 'transactionHash', 'blockHash', 'acceptanceEvidenceDigest'
    ])
    OR EXISTS (
      SELECT 1 FROM jsonb_object_keys(p_profile->'canonicalCanaryEvidence') AS supplied(key)
      WHERE supplied.key NOT IN (
        'paymentAttemptId', 'orderKey', 'transactionHash', 'blockHash', 'acceptanceEvidenceDigest'
      )
    )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Canonical canary evidence shape is invalid';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'particle-certification:' || v_environment || ':' || v_release_id || ':' || v_chain_id::text,
      0
    )
  );

  SELECT binding.*, profile.profile_digest AS stored_profile_digest
  INTO v_same
  FROM public.particle_profile_release_bindings AS binding
  INNER JOIN public.particle_compatibility_profiles AS profile
    ON profile.profile_id = binding.profile_id
  WHERE binding.environment::text = v_environment
    AND binding.application_release_id = v_release_id
    AND binding.chain_id = v_chain_id
    AND binding.stage = v_stage
  LIMIT 1;

  IF FOUND THEN
    IF v_same.profile_id = v_profile_id
      AND lower(v_same.profile_digest) = v_profile_digest
      AND lower(v_same.stored_profile_digest) = v_profile_digest
      AND lower(v_same.certified_subject_hash) = v_subject_hash
      AND v_same.canary_product_id = v_canary_product_id
      AND v_same.canary_max_base_units = v_canary_max
    THEN
      RETURN v_same.id;
    END IF;
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = 'Particle certification stage already has different immutable evidence';
  END IF;

  SELECT
    binding.*,
    profile.particle_sdk_version AS current_sdk,
    profile.particle_protocol_version AS current_protocol,
    profile.particle_project_config_digest AS current_project_digest,
    profile.use_eip7702 AS current_use_eip7702,
    profile.delegate_address AS current_delegate,
    profile.delegate_code_hash AS current_code_hash,
    profile.response_digests AS current_response_digests,
    profile.nonce_convention AS current_nonce_convention,
    profile.source_token_profile AS current_source_token_profile,
    profile.captured_at AS current_captured_at
  INTO v_current
  FROM public.particle_profile_release_bindings AS binding
  INNER JOIN public.particle_compatibility_profiles AS profile
    ON profile.profile_id = binding.profile_id
  WHERE binding.environment::text = v_environment
    AND binding.application_release_id = v_release_id
    AND binding.chain_id = v_chain_id
  ORDER BY CASE binding.stage
    WHEN 'certified' THEN 3
    WHEN 'canary_ready' THEN 2
    WHEN 'bootstrap' THEN 1
    ELSE 0
  END DESC, binding.bound_at DESC, binding.id DESC
  LIMIT 1;

  IF NOT FOUND THEN
    IF v_stage <> 'bootstrap' THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'Particle certification must begin at bootstrap';
    END IF;
  ELSE
    IF (v_current.stage = 'bootstrap' AND v_stage <> 'canary_ready')
      OR (v_current.stage = 'canary_ready' AND v_stage <> 'certified')
      OR v_current.stage = 'certified'
    THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'Particle certification stage cannot skip or downgrade';
    END IF;
    IF v_current.current_sdk <> p_profile->>'particleSdkVersion'
      OR v_current.current_protocol <> p_profile->>'particleProtocolVersion'
      OR lower(v_current.current_project_digest) <> lower(p_profile->>'particleProjectConfigDigest')
      OR v_current.current_use_eip7702 IS DISTINCT FROM true
      OR lower(v_current.current_delegate) <> lower(p_profile->>'delegateAddress')
      OR lower(v_current.current_code_hash) <> lower(p_profile->>'delegateCodeHash')
      OR lower(v_current.current_response_digests->>'deployments') <> lower(v_response_digests->>'deployments')
      OR lower(v_current.current_response_digests->>'auth') <> lower(v_response_digests->>'auth')
      OR v_current.current_nonce_convention <> p_profile->'nonceConvention'
      OR (v_current.stage = 'canary_ready' AND v_current.current_source_token_profile <> p_profile->'sourceTokenProfile')
      OR v_captured_at < v_current.current_captured_at
      OR lower(v_current.certified_subject_hash) <> v_subject_hash
      OR v_current.canary_product_id <> v_canary_product_id
      OR v_current.canary_max_base_units <> v_canary_max
    THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'Particle certification lineage or canary policy changed';
    END IF;
  END IF;

  INSERT INTO public.particle_compatibility_profiles (
    profile_id,
    schema_version,
    stage,
    environment,
    chain_id,
    particle_sdk_version,
    particle_protocol_version,
    particle_project_config_digest,
    use_eip7702,
    delegate_address,
    delegate_code_hash,
    response_digests,
    nonce_convention,
    source_token_profile,
    canonical_canary_evidence,
    captured_at,
    profile_digest
  ) VALUES (
    v_profile_id,
    1,
    v_stage,
    v_environment::public.feature_flag_environment,
    v_chain_id,
    p_profile->>'particleSdkVersion',
    p_profile->>'particleProtocolVersion',
    lower(p_profile->>'particleProjectConfigDigest'),
    true,
    lower(p_profile->>'delegateAddress'),
    lower(p_profile->>'delegateCodeHash'),
    jsonb_build_object(
      'deployments', lower(v_response_digests->>'deployments'),
      'auth', lower(v_response_digests->>'auth')
    ) || CASE
      WHEN v_stage = 'certified' THEN jsonb_build_object(
        'submission', lower(v_response_digests->>'submission'),
        'status', lower(v_response_digests->>'status')
      )
      ELSE '{}'::jsonb
    END,
    p_profile->'nonceConvention',
    p_profile->'sourceTokenProfile',
    p_profile->'canonicalCanaryEvidence',
    v_captured_at,
    v_profile_digest
  )
  ON CONFLICT DO NOTHING
  RETURNING profile_id INTO v_inserted_profile_id;

  IF v_inserted_profile_id IS NULL AND NOT EXISTS (
    SELECT 1
    FROM public.particle_compatibility_profiles AS existing
    WHERE existing.profile_id = v_profile_id
      AND existing.profile_digest = v_profile_digest
      AND existing.stage = v_stage
      AND existing.environment::text = v_environment
      AND existing.chain_id = v_chain_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'Particle profile ID or digest is already bound';
  END IF;

  INSERT INTO public.particle_profile_release_bindings (
    schema_version,
    environment,
    application_release_id,
    chain_id,
    stage,
    profile_id,
    profile_digest,
    certified_subject_hash,
    canary_product_id,
    canary_max_base_units,
    bound_at
  ) VALUES (
    1,
    v_environment::public.feature_flag_environment,
    v_release_id,
    v_chain_id,
    v_stage,
    v_profile_id,
    v_profile_digest,
    v_subject_hash,
    v_canary_product_id,
    v_canary_max,
    v_bound_at
  )
  RETURNING id INTO v_binding_id;

  RETURN v_binding_id;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON TABLE "particle_compatibility_profiles" FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON TABLE "particle_profile_release_bindings" FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "certify_particle_compatibility_profile"(jsonb, jsonb) FROM PUBLIC;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'opentab_runtime') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
      ON TABLE public.particle_compatibility_profiles, public.particle_profile_release_bindings
      FROM opentab_runtime;
    GRANT SELECT
      ON TABLE public.particle_compatibility_profiles, public.particle_profile_release_bindings
      TO opentab_runtime;
    GRANT EXECUTE
      ON FUNCTION public.certify_particle_compatibility_profile(jsonb, jsonb)
      TO opentab_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'opentab_indexer') THEN
    GRANT SELECT
      ON TABLE public.particle_compatibility_profiles, public.particle_profile_release_bindings
      TO opentab_indexer;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'opentab_evidence_writer') THEN
    GRANT SELECT
      ON TABLE public.particle_compatibility_profiles, public.particle_profile_release_bindings
      TO opentab_evidence_writer;
  END IF;
END
$$;

INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
SELECT '41f366d6c21ffaae29875f0b2f1368feb2c9117437eb22ef3b990b6bb94824b6', 1784373600000
WHERE NOT EXISTS (
  SELECT 1 FROM drizzle.__drizzle_migrations WHERE hash = '41f366d6c21ffaae29875f0b2f1368feb2c9117437eb22ef3b990b6bb94824b6'
);

-- Clear any inherited/legacy column ACL before applying the exact boundary.
DO $opentab_particle_certification_column_acls$
DECLARE
  target_role text;
  relation record;
  denied_privilege text;
BEGIN
  FOREACH target_role IN ARRAY ARRAY[
    'opentab_runtime', 'opentab_indexer', 'opentab_evidence_writer', 'anon', 'authenticated'
  ]::text[]
  LOOP
    FOR relation IN
      SELECT class.relname,
        string_agg(format('%I', attribute.attname), ', ' ORDER BY attribute.attnum) AS columns
      FROM pg_catalog.pg_class class
      INNER JOIN pg_catalog.pg_namespace namespace ON namespace.oid = class.relnamespace
      INNER JOIN pg_catalog.pg_attribute attribute ON attribute.attrelid = class.oid
      WHERE namespace.nspname = 'public'
        AND class.relname IN (
          'particle_compatibility_profiles', 'particle_profile_release_bindings'
        )
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
      GROUP BY class.relname
    LOOP
      FOREACH denied_privilege IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']::text[]
      LOOP
        EXECUTE format(
          'REVOKE %s (%s) ON TABLE public.%I FROM %I',
          denied_privilege,
          relation.columns,
          relation.relname,
          target_role
        );
      END LOOP;
    END LOOP;
  END LOOP;
END
$opentab_particle_certification_column_acls$;

REVOKE ALL PRIVILEGES
  ON TABLE public.particle_compatibility_profiles, public.particle_profile_release_bindings
  FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.particle_compatibility_profiles, public.particle_profile_release_bindings
  FROM opentab_runtime, opentab_indexer, opentab_evidence_writer;
GRANT SELECT
  ON TABLE public.particle_compatibility_profiles, public.particle_profile_release_bindings
  TO opentab_runtime, opentab_indexer, opentab_evidence_writer;
REVOKE ALL ON FUNCTION public.certify_particle_compatibility_profile(jsonb, jsonb)
  FROM PUBLIC, opentab_indexer, opentab_evidence_writer, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.certify_particle_compatibility_profile(jsonb, jsonb)
  TO opentab_runtime;

ALTER TABLE public.particle_compatibility_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.particle_profile_release_bindings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS opentab_backend_roles ON public.particle_compatibility_profiles;
CREATE POLICY opentab_backend_roles ON public.particle_compatibility_profiles
  AS PERMISSIVE FOR ALL
  TO opentab_runtime, opentab_indexer, opentab_evidence_writer
  USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS opentab_backend_roles ON public.particle_profile_release_bindings;
CREATE POLICY opentab_backend_roles ON public.particle_profile_release_bindings
  AS PERMISSIVE FOR ALL
  TO opentab_runtime, opentab_indexer, opentab_evidence_writer
  USING (true) WITH CHECK (true);

DO $opentab_validate_particle_certification$
DECLARE
  relation_name text;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY[
    'particle_compatibility_profiles', 'particle_profile_release_bindings'
  ]::text[]
  LOOP
    IF NOT pg_catalog.has_table_privilege('opentab_runtime', 'public.' || relation_name, 'SELECT')
      OR NOT pg_catalog.has_table_privilege('opentab_indexer', 'public.' || relation_name, 'SELECT')
      OR NOT pg_catalog.has_table_privilege('opentab_evidence_writer', 'public.' || relation_name, 'SELECT')
      OR pg_catalog.has_table_privilege('opentab_runtime', 'public.' || relation_name, 'INSERT')
      OR pg_catalog.has_table_privilege('opentab_runtime', 'public.' || relation_name, 'UPDATE')
      OR pg_catalog.has_table_privilege('opentab_runtime', 'public.' || relation_name, 'DELETE')
      OR pg_catalog.has_table_privilege('opentab_indexer', 'public.' || relation_name, 'INSERT')
      OR pg_catalog.has_table_privilege('opentab_evidence_writer', 'public.' || relation_name, 'INSERT')
      OR pg_catalog.has_table_privilege('anon', 'public.' || relation_name, 'SELECT')
      OR pg_catalog.has_table_privilege('authenticated', 'public.' || relation_name, 'SELECT')
    THEN
      RAISE EXCEPTION 'Particle certification table % has an invalid privilege boundary.', relation_name;
    END IF;
  END LOOP;
  IF NOT pg_catalog.has_function_privilege(
    'opentab_runtime',
    'public.certify_particle_compatibility_profile(jsonb,jsonb)',
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'opentab_indexer',
    'public.certify_particle_compatibility_profile(jsonb,jsonb)',
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'opentab_evidence_writer',
    'public.certify_particle_compatibility_profile(jsonb,jsonb)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'Particle certification function privilege boundary is invalid.';
  END IF;
END
$opentab_validate_particle_certification$;

COMMIT;

SELECT
  'particle-certification-storage-ready' AS status,
  '41f366d6c21ffaae29875f0b2f1368feb2c9117437eb22ef3b990b6bb94824b6' AS migration_hash;
