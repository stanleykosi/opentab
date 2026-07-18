import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDirectory = path.join(repositoryRoot, 'packages/db/migrations');
const journalPath = path.join(migrationsDirectory, 'meta/_journal.json');
const outputPath = path.join(repositoryRoot, 'SUPABASE_SQL_EDITOR_SETUP.sql');
const rlsRepairOutputPath = path.join(repositoryRoot, 'SUPABASE_SQL_EDITOR_RLS_REPAIR.sql');
const particleCertificationOutputPath = path.join(
  repositoryRoot,
  'SUPABASE_SQL_EDITOR_PARTICLE_CERTIFICATION.sql',
);

const runtimeProtectedTables = [
  'chain_transactions',
  'indexed_blocks',
  'indexer_cursors',
  'canonical_logs',
  'reorg_incidents',
  'receipts',
  'particle_compatibility_profiles',
  'particle_profile_release_bindings',
];

const indexerReadTables = [
  'bootstrap_grants',
  'canonical_logs',
  'chain_event_quarantine',
  'contract_operations',
  'dead_letters',
  'indexed_blocks',
  'indexer_cursors',
  'judge_evidence',
  'loyalty_awards',
  'loyalty_balances',
  'loyalty_programs',
  'merchants',
  'orders',
  'outbox_events',
  'particle_compatibility_profiles',
  'particle_profile_release_bindings',
  'payment_attempts',
  'products',
  'provider_operations',
  'receipts',
  'refunds',
  'reorg_incidents',
  'settlement_credits',
  'signed_order_intents',
  'sponsor_audit_events',
  'split_invitations',
  'split_participants',
  'split_payments',
  'splits',
  'users',
  'withdrawals',
];

const indexerInsertTables = [
  'canonical_logs',
  'chain_event_quarantine',
  'dead_letters',
  'indexed_blocks',
  'indexer_cursors',
  'loyalty_awards',
  'loyalty_balances',
  'outbox_events',
  'provider_operations',
  'receipts',
  'reorg_incidents',
  'settlement_credits',
  'sponsor_audit_events',
];

const indexerUpdateTables = [
  'bootstrap_grants',
  'canonical_logs',
  'chain_event_quarantine',
  'contract_operations',
  'indexed_blocks',
  'indexer_cursors',
  'loyalty_awards',
  'loyalty_balances',
  'merchants',
  'orders',
  'payment_attempts',
  'products',
  'provider_operations',
  'receipts',
  'refunds',
  'settlement_credits',
  'split_invitations',
  'split_participants',
  'split_payments',
  'splits',
  'withdrawals',
];

const evidenceReadTables = [
  'user_identities',
  'merchants',
  'products',
  'signed_order_intents',
  'orders',
  'payment_attempts',
  'provider_operations',
  'canonical_logs',
  'receipts',
  'wallet_accounts',
  'delegation_records',
  'bootstrap_grants',
  'live_acceptance_evidence',
  'particle_compatibility_profiles',
  'particle_profile_release_bindings',
];

function quoteIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function tableList(tables) {
  return tables.map((table) => `public.${quoteIdentifier(table)}`).join(', ');
}

function sqlString(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function sqlArray(values) {
  return `ARRAY[${values.map(sqlString).join(', ')}]::text[]`;
}

function backendRlsPolicySql() {
  return `
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
`;
}

async function loadMigrations() {
  const journal = JSON.parse(await readFile(journalPath, 'utf8'));
  if (!Array.isArray(journal.entries) || journal.entries.length === 0) {
    throw new Error('The Drizzle migration journal has no entries.');
  }

  return Promise.all(
    journal.entries.map(async (entry, expectedIndex) => {
      if (
        entry.idx !== expectedIndex ||
        typeof entry.tag !== 'string' ||
        !Number.isSafeInteger(entry.when)
      ) {
        throw new Error(`Invalid Drizzle journal entry at index ${expectedIndex}.`);
      }
      const filename = `${entry.tag}.sql`;
      const sql = await readFile(path.join(migrationsDirectory, filename), 'utf8');
      return {
        filename,
        sql,
        hash: createHash('sha256').update(sql).digest('hex'),
        createdAt: entry.when,
      };
    }),
  );
}

function roleProvisioningSql() {
  const runtimeProtected = sqlArray(runtimeProtectedTables);
  const indexerRead = sqlArray(indexerReadTables);
  const indexerInsert = sqlArray(indexerInsertTables);
  const indexerUpdate = sqlArray(indexerUpdateTables);
  const evidenceRead = sqlArray(evidenceReadTables);

  return `
-- Generate independent credentials without putting passwords in this file or
-- the SQL Editor query history. Copy the final result grid directly into an
-- approved password manager; closing this SQL Editor session destroys it.
CREATE TEMPORARY TABLE _opentab_bootstrap_credentials (
  role_name text PRIMARY KEY,
  role_password text NOT NULL CHECK (length(role_password) >= 64)
) ON COMMIT PRESERVE ROWS;

INSERT INTO _opentab_bootstrap_credentials (role_name, role_password)
VALUES
  ('opentab_runtime', replace(gen_random_uuid()::text || gen_random_uuid()::text || gen_random_uuid()::text, '-', '')),
  ('opentab_indexer', replace(gen_random_uuid()::text || gen_random_uuid()::text || gen_random_uuid()::text, '-', '')),
  ('opentab_evidence_writer', replace(gen_random_uuid()::text || gen_random_uuid()::text || gen_random_uuid()::text, '-', ''));

DO $opentab_roles$
DECLARE
  credential record;
  granted_role name;
  connection_limit integer;
BEGIN
  FOR credential IN
    SELECT role_name, role_password
    FROM _opentab_bootstrap_credentials
    ORDER BY role_name
  LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = credential.role_name) THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = format('OpenTab role %I already exists; this setup file is fresh-project only.', credential.role_name);
    END IF;

    connection_limit := CASE credential.role_name
      WHEN 'opentab_runtime' THEN 30
      WHEN 'opentab_indexer' THEN 12
      ELSE 2
    END;

    EXECUTE format(
      'CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT %s',
      credential.role_name,
      credential.role_password,
      connection_limit
    );

    FOR granted_role IN
      SELECT parent.rolname
      FROM pg_catalog.pg_auth_members membership
      INNER JOIN pg_catalog.pg_roles member ON member.oid = membership.member
      INNER JOIN pg_catalog.pg_roles parent ON parent.oid = membership.roleid
      WHERE member.rolname = credential.role_name
    LOOP
      EXECUTE format('REVOKE %I FROM %I', granted_role, credential.role_name);
    END LOOP;

    EXECUTE format('REVOKE ALL PRIVILEGES ON DATABASE %I FROM %I', current_database(), credential.role_name);
    EXECUTE format('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM %I', credential.role_name);
    EXECUTE format('REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM %I', credential.role_name);
    EXECUTE format('REVOKE ALL PRIVILEGES ON SCHEMA public FROM %I', credential.role_name);
    EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM %I', current_database(), credential.role_name);
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), credential.role_name);
    EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', credential.role_name);
  END LOOP;
END
$opentab_roles$;

-- Table-level REVOKE does not clear column-level ACLs. Clear every possible
-- column grant before applying the exact role allowlists below.
DO $opentab_clear_column_acls$
DECLARE
  target_role text;
  relation record;
  denied_privilege text;
BEGIN
  FOREACH target_role IN ARRAY ARRAY['opentab_runtime', 'opentab_indexer', 'opentab_evidence_writer']::text[]
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
          target_role
        );
      END LOOP;
    END LOOP;
  END LOOP;
END
$opentab_clear_column_acls$;

-- A role cannot be denied privileges inherited through PUBLIC. This dedicated
-- OpenTab project therefore removes public-schema object creation and database
-- temporary-table access globally before granting the application allowlists.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
DO $opentab_revoke_public_temp$
BEGIN
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
END
$opentab_revoke_public_temp$;

ALTER ROLE opentab_runtime SET search_path = pg_catalog, public;
ALTER ROLE opentab_runtime SET statement_timeout = '30s';
ALTER ROLE opentab_runtime SET lock_timeout = '10s';
ALTER ROLE opentab_runtime SET idle_in_transaction_session_timeout = '15s';

ALTER ROLE opentab_indexer SET search_path = pg_catalog, public;
ALTER ROLE opentab_indexer SET statement_timeout = '120s';
ALTER ROLE opentab_indexer SET idle_in_transaction_session_timeout = '30s';

ALTER ROLE opentab_evidence_writer SET search_path = pg_catalog, public;
ALTER ROLE opentab_evidence_writer SET statement_timeout = '30s';
ALTER ROLE opentab_evidence_writer SET idle_in_transaction_session_timeout = '15s';

-- Web/API role: ordinary application DML, append-only audit history, narrowly
-- mutable Judge publication metadata, pre-canonical order workflow fields,
-- and read-only canonical/indexer projections.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO opentab_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO opentab_runtime;

REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.judge_evidence FROM opentab_runtime;
GRANT UPDATE (share_token_hash, published, expires_at, revoked_at, updated_at)
  ON TABLE public.judge_evidence TO opentab_runtime;

REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.audit_logs FROM opentab_runtime;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.live_acceptance_evidence FROM opentab_runtime;

GRANT EXECUTE ON FUNCTION public.certify_particle_compatibility_profile(jsonb, jsonb)
  TO opentab_runtime;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE ${tableList(runtimeProtectedTables)} FROM opentab_runtime;

REVOKE INSERT, UPDATE, DELETE ON TABLE public.orders FROM opentab_runtime;
GRANT INSERT (
  id, checkout_session_id, order_key, user_id, merchant_id, product_id, payer,
  recipient, token_address, quantity, amount_base_units, status, chain_id,
  provider_operation_id, intent_digest, refundable_until, version, created_at, updated_at
) ON TABLE public.orders TO opentab_runtime;
GRANT UPDATE (status, provider_operation_id, version, updated_at)
  ON TABLE public.orders TO opentab_runtime;

-- Indexer role: exact read/insert/update allowlists, no delete, DDL, TEMP,
-- sequence, trigger, reference, or arbitrary table access.
GRANT SELECT ON TABLE ${tableList(indexerReadTables)} TO opentab_indexer;
GRANT INSERT ON TABLE ${tableList(indexerInsertTables)} TO opentab_indexer;
GRANT UPDATE ON TABLE ${tableList(indexerUpdateTables)} TO opentab_indexer;
GRANT UPDATE (published, share_token_hash, expires_at, revoked_at, updated_at)
  ON TABLE public.judge_evidence TO opentab_indexer;

-- Live-acceptance writer: exact canonical reads and one append-only evidence
-- insert boundary. It receives no sequence access because the evidence ID is
-- UUID-based.
GRANT SELECT ON TABLE ${tableList(evidenceReadTables)} TO opentab_evidence_writer;
GRANT INSERT ON TABLE public.live_acceptance_evidence TO opentab_evidence_writer;
${backendRlsPolicySql()}

-- Fail the transaction if role attributes or the exact table allowlists drift
-- from the application startup assertions.
DO $opentab_validate_roles$
DECLARE
  target_role text;
  role_oid oid;
  invalid boolean;
  required_read text[];
  required_insert text[];
  required_update text[];
  allowed_special text[] := ARRAY[
    'orders', 'judge_evidence', 'audit_logs', 'live_acceptance_evidence',
    'chain_transactions', 'indexed_blocks', 'indexer_cursors', 'canonical_logs',
    'reorg_incidents', 'receipts', 'particle_compatibility_profiles',
    'particle_profile_release_bindings'
  ]::text[];
BEGIN
  FOREACH target_role IN ARRAY ARRAY['opentab_runtime', 'opentab_indexer', 'opentab_evidence_writer']::text[]
  LOOP
    SELECT oid INTO role_oid FROM pg_catalog.pg_roles WHERE rolname = target_role;
    IF role_oid IS NULL THEN
      RAISE EXCEPTION 'Required OpenTab role % is missing.', target_role;
    END IF;

    SELECT
      NOT role.rolcanlogin OR role.rolinherit OR role.rolsuper OR role.rolcreatedb
      OR role.rolcreaterole OR role.rolreplication OR role.rolbypassrls
      OR database.datdba = role.oid
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE member = role.oid)
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspowner = role.oid)
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE relowner = role.oid)
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc WHERE proowner = role.oid)
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_type WHERE typowner = role.oid)
      OR NOT pg_catalog.has_database_privilege(role.oid, database.oid, 'CONNECT')
      OR pg_catalog.has_database_privilege(role.oid, database.oid, 'CREATE')
      OR pg_catalog.has_database_privilege(role.oid, database.oid, 'TEMP')
      OR NOT pg_catalog.has_schema_privilege(role.oid, public_namespace.oid, 'USAGE')
      OR pg_catalog.has_schema_privilege(role.oid, public_namespace.oid, 'CREATE')
    INTO invalid
    FROM pg_catalog.pg_roles role
    INNER JOIN pg_catalog.pg_database database ON database.datname = current_database()
    INNER JOIN pg_catalog.pg_namespace public_namespace ON public_namespace.nspname = 'public'
    WHERE role.oid = role_oid;

    IF invalid THEN
      RAISE EXCEPTION 'OpenTab role % failed its base privilege boundary.', target_role;
    END IF;
  END LOOP;

  SELECT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class relation
    INNER JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relkind IN ('r', 'p')
      AND relation.relname <> ALL (allowed_special)
      AND NOT (
        pg_catalog.has_table_privilege('opentab_runtime', relation.oid, 'SELECT')
        AND pg_catalog.has_table_privilege('opentab_runtime', relation.oid, 'INSERT')
        AND pg_catalog.has_table_privilege('opentab_runtime', relation.oid, 'UPDATE')
        AND pg_catalog.has_table_privilege('opentab_runtime', relation.oid, 'DELETE')
      )
  ) INTO invalid;
  IF invalid THEN
    RAISE EXCEPTION 'OpenTab runtime role is missing ordinary application DML.';
  END IF;

  IF NOT pg_catalog.has_table_privilege('opentab_runtime', 'public.orders', 'SELECT')
    OR pg_catalog.has_table_privilege('opentab_runtime', 'public.orders', 'INSERT')
    OR pg_catalog.has_table_privilege('opentab_runtime', 'public.orders', 'UPDATE')
    OR pg_catalog.has_table_privilege('opentab_runtime', 'public.orders', 'DELETE')
    OR NOT pg_catalog.has_column_privilege('opentab_runtime', 'public.orders', 'id', 'INSERT')
    OR NOT pg_catalog.has_column_privilege('opentab_runtime', 'public.orders', 'status', 'UPDATE')
    OR pg_catalog.has_column_privilege('opentab_runtime', 'public.orders', 'paid_amount_base_units', 'INSERT')
    OR pg_catalog.has_column_privilege('opentab_runtime', 'public.orders', 'transaction_hash', 'UPDATE')
  THEN
    RAISE EXCEPTION 'OpenTab runtime order boundary is invalid.';
  END IF;

  IF NOT pg_catalog.has_table_privilege('opentab_runtime', 'public.judge_evidence', 'SELECT')
    OR NOT pg_catalog.has_table_privilege('opentab_runtime', 'public.judge_evidence', 'INSERT')
    OR pg_catalog.has_table_privilege('opentab_runtime', 'public.judge_evidence', 'UPDATE')
    OR NOT pg_catalog.has_column_privilege('opentab_runtime', 'public.judge_evidence', 'published', 'UPDATE')
    OR pg_catalog.has_column_privilege('opentab_runtime', 'public.judge_evidence', 'public_proof', 'UPDATE')
    OR NOT pg_catalog.has_table_privilege('opentab_runtime', 'public.audit_logs', 'INSERT')
  THEN
    RAISE EXCEPTION 'OpenTab runtime append-only/Judge boundary is invalid.';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class relation
    INNER JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relkind IN ('r', 'p')
      AND relation.relname = ANY (${runtimeProtected})
      AND (
        pg_catalog.has_table_privilege('opentab_runtime', relation.oid, 'INSERT')
        OR pg_catalog.has_table_privilege('opentab_runtime', relation.oid, 'UPDATE')
        OR pg_catalog.has_table_privilege('opentab_runtime', relation.oid, 'DELETE')
        OR pg_catalog.has_any_column_privilege('opentab_runtime', relation.oid, 'INSERT')
        OR pg_catalog.has_any_column_privilege('opentab_runtime', relation.oid, 'UPDATE')
      )
  ) INTO invalid;
  IF invalid
    OR pg_catalog.has_table_privilege('opentab_runtime', 'public.live_acceptance_evidence', 'INSERT')
    OR pg_catalog.has_table_privilege('opentab_runtime', 'public.live_acceptance_evidence', 'UPDATE')
    OR NOT pg_catalog.has_function_privilege(
      'opentab_runtime',
      'public.certify_particle_compatibility_profile(jsonb,jsonb)',
      'EXECUTE'
    )
  THEN
    RAISE EXCEPTION 'OpenTab runtime canonical/evidence boundary is invalid.';
  END IF;

  required_read := ${indexerRead};
  required_insert := ${indexerInsert};
  required_update := ${indexerUpdate};
  SELECT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class relation
    INNER JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public' AND relation.relkind IN ('r', 'p') AND (
      (relation.relname = ANY (required_read)) <> pg_catalog.has_table_privilege('opentab_indexer', relation.oid, 'SELECT')
      OR (relation.relname = ANY (required_insert)) <> pg_catalog.has_table_privilege('opentab_indexer', relation.oid, 'INSERT')
      OR (
        relation.relname <> 'judge_evidence'
        AND (relation.relname = ANY (required_update)) <> pg_catalog.has_table_privilege('opentab_indexer', relation.oid, 'UPDATE')
      )
      OR pg_catalog.has_table_privilege('opentab_indexer', relation.oid, 'DELETE')
      OR pg_catalog.has_table_privilege('opentab_indexer', relation.oid, 'TRUNCATE')
      OR pg_catalog.has_table_privilege('opentab_indexer', relation.oid, 'REFERENCES')
      OR pg_catalog.has_table_privilege('opentab_indexer', relation.oid, 'TRIGGER')
    )
  ) INTO invalid;
  IF invalid
    OR pg_catalog.has_table_privilege('opentab_indexer', 'public.judge_evidence', 'UPDATE')
    OR NOT pg_catalog.has_column_privilege('opentab_indexer', 'public.judge_evidence', 'published', 'UPDATE')
    OR pg_catalog.has_column_privilege('opentab_indexer', 'public.judge_evidence', 'public_proof', 'UPDATE')
    OR pg_catalog.has_function_privilege(
      'opentab_indexer',
      'public.certify_particle_compatibility_profile(jsonb,jsonb)',
      'EXECUTE'
    )
  THEN
    RAISE EXCEPTION 'OpenTab indexer exact allowlist is invalid.';
  END IF;

  required_read := ${evidenceRead};
  SELECT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class relation
    INNER JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public' AND relation.relkind IN ('r', 'p') AND (
      (relation.relname = ANY (required_read)) <> pg_catalog.has_table_privilege('opentab_evidence_writer', relation.oid, 'SELECT')
      OR (relation.relname = 'live_acceptance_evidence') <> pg_catalog.has_table_privilege('opentab_evidence_writer', relation.oid, 'INSERT')
      OR pg_catalog.has_table_privilege('opentab_evidence_writer', relation.oid, 'UPDATE')
      OR pg_catalog.has_table_privilege('opentab_evidence_writer', relation.oid, 'DELETE')
      OR pg_catalog.has_table_privilege('opentab_evidence_writer', relation.oid, 'TRUNCATE')
      OR pg_catalog.has_table_privilege('opentab_evidence_writer', relation.oid, 'REFERENCES')
      OR pg_catalog.has_table_privilege('opentab_evidence_writer', relation.oid, 'TRIGGER')
    )
  ) INTO invalid;
  IF invalid OR pg_catalog.has_function_privilege(
    'opentab_evidence_writer',
    'public.certify_particle_compatibility_profile(jsonb,jsonb)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'OpenTab evidence-writer exact allowlist is invalid.';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class sequence_relation
    INNER JOIN pg_catalog.pg_namespace namespace ON namespace.oid = sequence_relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND sequence_relation.relkind = 'S'
      AND (
        pg_catalog.has_sequence_privilege('opentab_indexer', sequence_relation.oid, 'USAGE')
        OR pg_catalog.has_sequence_privilege('opentab_indexer', sequence_relation.oid, 'SELECT')
        OR pg_catalog.has_sequence_privilege('opentab_indexer', sequence_relation.oid, 'UPDATE')
        OR pg_catalog.has_sequence_privilege('opentab_evidence_writer', sequence_relation.oid, 'USAGE')
        OR pg_catalog.has_sequence_privilege('opentab_evidence_writer', sequence_relation.oid, 'SELECT')
        OR pg_catalog.has_sequence_privilege('opentab_evidence_writer', sequence_relation.oid, 'UPDATE')
      )
  ) INTO invalid;
  IF invalid THEN
    RAISE EXCEPTION 'An isolated OpenTab role unexpectedly has sequence privileges.';
  END IF;
END
$opentab_validate_roles$;
`;
}

function renderSetup(migrations) {
  const migrationSql = migrations
    .map(
      (migration, index) => `
-- ---------------------------------------------------------------------------
-- Migration ${index}: ${migration.filename}
-- SHA-256: ${migration.hash}
-- ---------------------------------------------------------------------------
${migration.sql.trimEnd()}
`,
    )
    .join('\n');

  const journalRows = migrations
    .map((migration) => `  (${sqlString(migration.hash)}, ${migration.createdAt})`)
    .join(',\n');

  return `-- OpenTab — Supabase SQL Editor one-time setup
-- GENERATED FILE. Source: packages/db/migrations + this repository's role policy.
-- Regenerate with: pnpm db:supabase:sql
--
-- Run this entire file once in a fresh, dedicated Supabase project:
--   Supabase Dashboard -> SQL Editor -> New query -> paste -> Run
--
-- Safety:
--   * The transaction fails before changing anything if OpenTab is already installed.
--   * Do not run this against a project shared with another application.
--   * The final result grid contains three newly generated database passwords.
--     Copy them immediately to your secret manager; never commit or share them.
--   * Keep the Supabase postgres password separate for controlled migrations only.

BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '10min';
-- Migrations contain intentionally unqualified CREATE TABLE statements, so
-- public must be the creation target. Runtime roles are hardened separately.
SET LOCAL search_path = public, pg_catalog;
SELECT pg_advisory_xact_lock(714480106095746);

DO $opentab_fresh_project$
BEGIN
  IF to_regclass('public.users') IS NOT NULL
    OR to_regclass('public.orders') IS NOT NULL
    OR to_regclass('drizzle.__drizzle_migrations') IS NOT NULL
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'OpenTab objects already exist. Use controlled migrations instead of the fresh-project SQL Editor setup.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles
    WHERE rolname = current_user AND rolcreaterole
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'Run this file from Supabase SQL Editor as the postgres project role with CREATEROLE.';
  END IF;
END
$opentab_fresh_project$;

CREATE SCHEMA drizzle;
CREATE TABLE drizzle.__drizzle_migrations (
  id serial PRIMARY KEY,
  hash text NOT NULL,
  created_at bigint
);
${migrationSql}
INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
VALUES
${journalRows};
${roleProvisioningSql()}
COMMIT;

-- SECRET OUTPUT: copy these three values into your password manager now.
-- The role names become the usernames in Vercel/Railway Supabase URLs.
SELECT
  role_name,
  role_password,
  CASE role_name
    WHEN 'opentab_runtime' THEN 'Vercel DATABASE_URL (transaction pooler :6543)'
    WHEN 'opentab_indexer' THEN 'Railway DATABASE_URL_INDEXER (session/direct :5432)'
    ELSE 'Protected DATABASE_URL_EVIDENCE_WRITER (session/direct :5432)'
  END AS use_for
FROM _opentab_bootstrap_credentials
ORDER BY role_name;
`;
}

function renderRlsRepair() {
  return `-- OpenTab — Supabase backend RLS repair
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
${backendRlsPolicySql()}
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
`;
}

function renderParticleCertificationIncremental(migrations) {
  const migration = migrations.at(-1);
  if (migration?.filename !== '0011_particle-compatibility-profiles.sql') {
    throw new Error('Particle certification incremental must track migration 0011.');
  }
  return `-- OpenTab — incremental Particle compatibility certification storage
-- GENERATED FILE. Source: ${migration.filename} + least-privilege Supabase policy.
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
-- ${migration.filename}
-- SHA-256: ${migration.hash}
-- ---------------------------------------------------------------------------
${migration.sql.trimEnd()}

INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
SELECT ${sqlString(migration.hash)}, ${migration.createdAt}
WHERE NOT EXISTS (
  SELECT 1 FROM drizzle.__drizzle_migrations WHERE hash = ${sqlString(migration.hash)}
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
  ${sqlString(migration.hash)} AS migration_hash;
`;
}

const migrations = await loadMigrations();
const rendered = renderSetup(migrations);
const renderedRlsRepair = renderRlsRepair();
const renderedParticleCertification = renderParticleCertificationIncremental(migrations);
const checkOnly = process.argv.includes('--check');

if (checkOnly) {
  let current;
  let currentRlsRepair;
  let currentParticleCertification;
  try {
    current = await readFile(outputPath, 'utf8');
    currentRlsRepair = await readFile(rlsRepairOutputPath, 'utf8');
    currentParticleCertification = await readFile(particleCertificationOutputPath, 'utf8');
  } catch {
    throw new Error('A generated Supabase SQL Editor file is missing. Run pnpm db:supabase:sql.');
  }
  if (
    current !== rendered ||
    currentRlsRepair !== renderedRlsRepair ||
    currentParticleCertification !== renderedParticleCertification
  ) {
    throw new Error('A Supabase SQL Editor file is stale. Run pnpm db:supabase:sql.');
  }
  console.log(
    `Supabase SQL Editor setup, RLS repair, and Particle incremental are current (${migrations.length} migrations).`,
  );
} else {
  await writeFile(outputPath, rendered, 'utf8');
  await writeFile(rlsRepairOutputPath, renderedRlsRepair, 'utf8');
  await writeFile(particleCertificationOutputPath, renderedParticleCertification, 'utf8');
  console.log(
    `Generated ${path.relative(repositoryRoot, outputPath)}, ${path.relative(repositoryRoot, rlsRepairOutputPath)}, and ${path.relative(repositoryRoot, particleCertificationOutputPath)} from ${migrations.length} migrations.`,
  );
}
