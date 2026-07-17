-- OpenTab — Supabase backend RLS repair
-- GENERATED FILE. Source: scripts/generate-supabase-sql-editor-setup.mjs
-- Regenerate with: pnpm db:supabase:sql
--
-- Run this entire file once in the dedicated OpenTab Supabase project:
--   Supabase Dashboard -> SQL Editor -> New query -> paste -> Run
--
-- This is idempotent. It does not rotate credentials or modify application rows.

BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '10min';
SELECT pg_advisory_xact_lock(714480106095747);

DO $opentab_rls_repair_preflight$
BEGIN
  IF to_regclass('public.users') IS NULL
    OR to_regclass('public.orders') IS NULL
    OR to_regclass('public.config_snapshots') IS NULL
  THEN
    RAISE EXCEPTION 'OpenTab tables are missing; run the fresh-project setup instead.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'opentab_runtime'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'opentab_indexer'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'opentab_evidence_writer'
  ) THEN
    RAISE EXCEPTION 'OpenTab service roles are missing; do not apply a partial repair.';
  END IF;
END
$opentab_rls_repair_preflight$;

-- Supabase enables RLS on public tables. Keep that protection for its anon and
-- authenticated API roles while allowing only OpenTab's isolated service roles.
-- Table/column GRANTs above remain the authoritative operation boundary.
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;

-- Table-level REVOKE does not clear legacy column ACLs.
DO $opentab_revoke_supabase_api_columns$
DECLARE
  api_role text;
  relation record;
  denied_privilege text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated']::text[]
  LOOP
    FOR relation IN
      SELECT class.relname,
        string_agg(format('%I', attribute.attname), ', ' ORDER BY attribute.attnum) AS columns
      FROM pg_catalog.pg_class class
      INNER JOIN pg_catalog.pg_namespace namespace ON namespace.oid = class.relnamespace
      INNER JOIN pg_catalog.pg_attribute attribute ON attribute.attrelid = class.oid
      WHERE namespace.nspname = 'public'
        AND class.relkind IN ('r', 'p')
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
          api_role
        );
      END LOOP;
    END LOOP;
  END LOOP;
END
$opentab_revoke_supabase_api_columns$;

DO $opentab_backend_rls$
DECLARE
  relation record;
BEGIN
  FOR relation IN
    SELECT namespace.nspname AS schema_name, class.relname AS table_name
    FROM pg_catalog.pg_class class
    INNER JOIN pg_catalog.pg_namespace namespace ON namespace.oid = class.relnamespace
    WHERE namespace.nspname = 'public'
      AND class.relkind IN ('r', 'p')
    ORDER BY class.relname
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY',
      relation.schema_name,
      relation.table_name
    );
    EXECUTE format(
      'DROP POLICY IF EXISTS opentab_backend_roles ON %I.%I',
      relation.schema_name,
      relation.table_name
    );
    EXECUTE format(
      'CREATE POLICY opentab_backend_roles ON %I.%I AS PERMISSIVE FOR ALL TO opentab_runtime, opentab_indexer, opentab_evidence_writer USING (true) WITH CHECK (true)',
      relation.schema_name,
      relation.table_name
    );
  END LOOP;
END
$opentab_backend_rls$;

DO $opentab_validate_backend_rls$
DECLARE
  invalid boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class relation
    INNER JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relkind IN ('r', 'p')
      AND (
        NOT relation.relrowsecurity
        OR NOT EXISTS (
          SELECT 1
          FROM pg_catalog.pg_policy policy
          WHERE policy.polrelid = relation.oid
            AND policy.polname = 'opentab_backend_roles'
            AND policy.polcmd = '*'
            AND policy.polpermissive
            AND cardinality(policy.polroles) = 3
            AND (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'opentab_runtime') = ANY (policy.polroles)
            AND (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'opentab_indexer') = ANY (policy.polroles)
            AND (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'opentab_evidence_writer') = ANY (policy.polroles)
            AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) = 'true'
            AND pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid) = 'true'
        )
      )
  ) INTO invalid;
  IF invalid THEN
    RAISE EXCEPTION 'OpenTab backend RLS policy coverage is invalid.';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class relation
    INNER JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relkind IN ('r', 'p')
      AND (
        pg_catalog.has_table_privilege('anon', relation.oid, 'SELECT')
        OR pg_catalog.has_table_privilege('anon', relation.oid, 'INSERT')
        OR pg_catalog.has_table_privilege('anon', relation.oid, 'UPDATE')
        OR pg_catalog.has_table_privilege('anon', relation.oid, 'DELETE')
        OR pg_catalog.has_any_column_privilege('anon', relation.oid, 'SELECT')
        OR pg_catalog.has_any_column_privilege('anon', relation.oid, 'INSERT')
        OR pg_catalog.has_any_column_privilege('anon', relation.oid, 'UPDATE')
        OR pg_catalog.has_any_column_privilege('anon', relation.oid, 'REFERENCES')
        OR pg_catalog.has_table_privilege('authenticated', relation.oid, 'SELECT')
        OR pg_catalog.has_table_privilege('authenticated', relation.oid, 'INSERT')
        OR pg_catalog.has_table_privilege('authenticated', relation.oid, 'UPDATE')
        OR pg_catalog.has_table_privilege('authenticated', relation.oid, 'DELETE')
        OR pg_catalog.has_any_column_privilege('authenticated', relation.oid, 'SELECT')
        OR pg_catalog.has_any_column_privilege('authenticated', relation.oid, 'INSERT')
        OR pg_catalog.has_any_column_privilege('authenticated', relation.oid, 'UPDATE')
        OR pg_catalog.has_any_column_privilege('authenticated', relation.oid, 'REFERENCES')
      )
  ) INTO invalid;
  IF invalid THEN
    RAISE EXCEPTION 'Supabase public API roles retain OpenTab table privileges.';
  END IF;
END
$opentab_validate_backend_rls$;

COMMIT;

SELECT
  count(*)::integer AS protected_table_count
FROM pg_catalog.pg_class relation
INNER JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
WHERE namespace.nspname = 'public'
  AND relation.relkind IN ('r', 'p')
  AND relation.relrowsecurity
  AND EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy policy
    WHERE policy.polrelid = relation.oid
      AND policy.polname = 'opentab_backend_roles'
  );
