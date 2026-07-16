\set ON_ERROR_STOP on
\getenv runtime_role OPENTAB_RUNTIME_ROLE
\getenv runtime_password OPENTAB_RUNTIME_PASSWORD
\getenv evidence_writer_role OPENTAB_EVIDENCE_WRITER_ROLE

select
  length(:'runtime_role') > 0
  and length(:'runtime_password') >= 32
  and length(:'evidence_writer_role') > 0
  and :'runtime_role' <> :'evidence_writer_role'
  and :'runtime_role' <> current_user
  as inputs_valid
\gset
\if :inputs_valid
\else
  \echo 'Distinct OPENTAB_RUNTIME_ROLE, OPENTAB_EVIDENCE_WRITER_ROLE, and a 32+ character OPENTAB_RUNTIME_PASSWORD are required; runtime must not be the migration role.'
  \quit 1
\endif

begin;

select format(
  'create role %I login password %L nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls connection limit 30',
  :'runtime_role',
  :'runtime_password'
)
where not exists (
  select 1 from pg_catalog.pg_roles where rolname = :'runtime_role'
)
\gexec

select format(
  'alter role %I with login password %L nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls connection limit 30',
  :'runtime_role',
  :'runtime_password'
)
\gexec

-- NOINHERIT does not stop an explicit SET ROLE. Remove every role the runtime
-- can assume before rebuilding its direct least-privilege grants.
select format('revoke %I from %I', granted_role.rolname, :'runtime_role')
from pg_catalog.pg_auth_members membership
inner join pg_catalog.pg_roles member_role on member_role.oid = membership.member
inner join pg_catalog.pg_roles granted_role on granted_role.oid = membership.roleid
where member_role.rolname = :'runtime_role'
\gexec
select format('alter role %I set search_path = pg_catalog, public', :'runtime_role')
\gexec
select format('alter role %I set statement_timeout = %L', :'runtime_role', '30s')
\gexec
select format('alter role %I set lock_timeout = %L', :'runtime_role', '10s')
\gexec
select format(
  'alter role %I set idle_in_transaction_session_timeout = %L',
  :'runtime_role',
  '15s'
)
\gexec

select format('revoke all privileges on database %I from %I', current_database(), :'runtime_role')
\gexec
select format('revoke all privileges on all tables in schema public from %I', :'runtime_role')
\gexec
select format('revoke all privileges on all sequences in schema public from %I', :'runtime_role')
\gexec
select format('revoke all privileges on schema public from %I', :'runtime_role')
\gexec

-- These inherited PUBLIC defaults cannot be denied for only one role. OpenTab
-- therefore hardens the entire application database before granting runtime DML.
revoke create on schema public from public;
select format('revoke temporary on database %I from public', current_database())
\gexec

select format('grant connect on database %I to %I', current_database(), :'runtime_role')
\gexec
select format('grant usage on schema public to %I', :'runtime_role')
\gexec
select format(
  'grant select, insert, update, delete on all tables in schema public to %I',
  :'runtime_role'
)
\gexec
select format('grant usage, select on all sequences in schema public to %I', :'runtime_role')
\gexec

-- Judge proof content is created once from canonical facts. Ordinary web/API
-- credentials may publish/revoke it, but cannot replace proof JSON or its
-- digest after insertion.
select format(
  'revoke update, delete, truncate, references, trigger on table public.judge_evidence from %I',
  :'runtime_role'
)
\gexec
select format(
  'revoke update (%s), references (%s) on table public.judge_evidence from %I',
  string_agg(format('%I', attribute.attname), ', ' order by attribute.attnum),
  string_agg(format('%I', attribute.attname), ', ' order by attribute.attnum),
  :'runtime_role'
)
from pg_catalog.pg_attribute attribute
inner join pg_catalog.pg_class relation on relation.oid = attribute.attrelid
inner join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
where namespace.nspname = 'public'
  and relation.relname = 'judge_evidence'
  and relation.relkind in ('r', 'p')
  and attribute.attnum > 0
  and not attribute.attisdropped
\gexec
select format(
  'grant update (share_token_hash, published, expires_at, revoked_at, updated_at) on table public.judge_evidence to %I',
  :'runtime_role'
)
\gexec

-- Audit history is append-only for the ordinary application credential. It
-- may record and read its own safe events, but cannot rewrite or erase them.
select format(
  'revoke update, delete, truncate, references, trigger on table public.audit_logs from %I',
  :'runtime_role'
)
\gexec
select format(
  'revoke %s (%s) on table public.audit_logs from %I',
  denied_privilege.name,
  string_agg(format('%I', attribute.attname), ', ' order by attribute.attnum),
  :'runtime_role'
)
from pg_catalog.pg_attribute attribute
inner join pg_catalog.pg_class relation on relation.oid = attribute.attrelid
inner join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
cross join (values ('update'), ('references')) denied_privilege(name)
where namespace.nspname = 'public'
  and relation.relname = 'audit_logs'
  and relation.relkind in ('r', 'p')
  and attribute.attnum > 0
  and not attribute.attisdropped
group by denied_privilege.name
\gexec

-- The ordinary web process may verify accepted evidence but can never create,
-- rewrite, delete, truncate, reference, or attach triggers to the attested row.
select format(
  'revoke insert, update, delete, truncate, references, trigger on table public.live_acceptance_evidence from %I',
  :'runtime_role'
)
\gexec
select format(
  'revoke insert (%s) on table public.live_acceptance_evidence from %I',
  string_agg(format('%I', attribute.attname), ', ' order by attribute.attnum),
  :'runtime_role'
)
from pg_catalog.pg_attribute attribute
inner join pg_catalog.pg_class relation on relation.oid = attribute.attrelid
inner join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
where namespace.nspname = 'public'
  and relation.relname = 'live_acceptance_evidence'
  and relation.relkind in ('r', 'p')
  and attribute.attnum > 0
  and not attribute.attisdropped
\gexec
select format(
  'revoke update (%s) on table public.live_acceptance_evidence from %I',
  string_agg(format('%I', attribute.attname), ', ' order by attribute.attnum),
  :'runtime_role'
)
from pg_catalog.pg_attribute attribute
inner join pg_catalog.pg_class relation on relation.oid = attribute.attrelid
inner join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
where namespace.nspname = 'public'
  and relation.relname = 'live_acceptance_evidence'
  and relation.relkind in ('r', 'p')
  and attribute.attnum > 0
  and not attribute.attisdropped
\gexec
select format(
  'revoke references (%s) on table public.live_acceptance_evidence from %I',
  string_agg(format('%I', attribute.attname), ', ' order by attribute.attnum),
  :'runtime_role'
)
from pg_catalog.pg_attribute attribute
inner join pg_catalog.pg_class relation on relation.oid = attribute.attrelid
inner join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
where namespace.nspname = 'public'
  and relation.relname = 'live_acceptance_evidence'
  and relation.relkind in ('r', 'p')
  and attribute.attnum > 0
  and not attribute.attisdropped
\gexec

-- Arbitrum/indexer projections and issued receipts are authoritative. The web
-- role reads them but only the separately credentialed indexer may mutate them.
select format(
  'revoke insert, update, delete, truncate, references, trigger on table public.%I from %I',
  relation.relname,
  :'runtime_role'
)
from pg_catalog.pg_class relation
inner join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
where namespace.nspname = 'public'
  and relation.relkind in ('r', 'p')
  and relation.relname in (
    'chain_transactions',
    'indexed_blocks',
    'indexer_cursors',
    'canonical_logs',
    'reorg_incidents',
    'receipts'
  )
\gexec
select format(
  'revoke %s (%s) on table public.%I from %I',
  denied_privilege.name,
  string_agg(format('%I', attribute.attname), ', ' order by attribute.attnum),
  relation.relname,
  :'runtime_role'
)
from pg_catalog.pg_attribute attribute
inner join pg_catalog.pg_class relation on relation.oid = attribute.attrelid
inner join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
cross join (values ('insert'), ('update'), ('references')) denied_privilege(name)
where namespace.nspname = 'public'
  and relation.relkind in ('r', 'p')
  and relation.relname in (
    'chain_transactions',
    'indexed_blocks',
    'indexer_cursors',
    'canonical_logs',
    'reorg_incidents',
    'receipts'
  )
  and attribute.attnum > 0
  and not attribute.attisdropped
group by relation.relname, denied_privilege.name
\gexec

-- The web creates an order and may advance it only through pre-canonical
-- workflow states. Settlement proof columns remain indexer-only.
select format(
  'revoke insert, update, delete on table public.orders from %I',
  :'runtime_role'
)
\gexec
select format(
  'revoke %s (%s) on table public.orders from %I',
  denied_privilege.name,
  string_agg(format('%I', attribute.attname), ', ' order by attribute.attnum),
  :'runtime_role'
)
from pg_catalog.pg_attribute attribute
inner join pg_catalog.pg_class relation on relation.oid = attribute.attrelid
inner join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
cross join (values ('insert'), ('update'), ('references')) denied_privilege(name)
where namespace.nspname = 'public'
  and relation.relname = 'orders'
  and relation.relkind in ('r', 'p')
  and attribute.attnum > 0
  and not attribute.attisdropped
group by denied_privilege.name
\gexec
select format(
  'grant insert (id, checkout_session_id, order_key, user_id, merchant_id, product_id, payer, recipient, token_address, quantity, amount_base_units, status, chain_id, provider_operation_id, intent_digest, refundable_until, version, created_at, updated_at) on table public.orders to %I',
  :'runtime_role'
)
\gexec
select format(
  'grant update (status, provider_operation_id, version, updated_at) on table public.orders to %I',
  :'runtime_role'
)
\gexec

select
  role.rolcanlogin
  and not role.rolinherit
  and not role.rolsuper
  and not role.rolcreatedb
  and not role.rolcreaterole
  and not role.rolreplication
  and not role.rolbypassrls
  and database.datdba <> role.oid
  and not exists (
    select 1
    from pg_catalog.pg_auth_members membership
    where membership.member = role.oid
  )
  and not exists (
    select 1
    from pg_catalog.pg_namespace namespace
    where namespace.nspowner = role.oid
  )
  and not exists (
    select 1
    from pg_catalog.pg_class relation
    where relation.relowner = role.oid
  )
  and not exists (
    select 1
    from pg_catalog.pg_proc routine
    where routine.proowner = role.oid
  )
  and not exists (
    select 1
    from pg_catalog.pg_type owned_type
    where owned_type.typowner = role.oid
  )
  and not pg_catalog.has_database_privilege(role.oid, database.oid, 'CREATE')
  and not pg_catalog.has_database_privilege(role.oid, database.oid, 'TEMP')
  and not pg_catalog.has_schema_privilege(role.oid, public_namespace.oid, 'CREATE')
  and pg_catalog.has_table_privilege(role.oid, judge_table.oid, 'SELECT')
  and pg_catalog.has_table_privilege(role.oid, judge_table.oid, 'INSERT')
  and not pg_catalog.has_table_privilege(role.oid, judge_table.oid, 'UPDATE')
  and not pg_catalog.has_table_privilege(role.oid, judge_table.oid, 'DELETE')
  and pg_catalog.has_column_privilege(role.oid, judge_table.oid, 'published', 'UPDATE')
  and pg_catalog.has_column_privilege(role.oid, judge_table.oid, 'share_token_hash', 'UPDATE')
  and pg_catalog.has_column_privilege(role.oid, judge_table.oid, 'expires_at', 'UPDATE')
  and pg_catalog.has_column_privilege(role.oid, judge_table.oid, 'revoked_at', 'UPDATE')
  and not pg_catalog.has_column_privilege(role.oid, judge_table.oid, 'public_proof', 'UPDATE')
  and not pg_catalog.has_column_privilege(
    role.oid,
    judge_table.oid,
    'public_proof_digest',
    'UPDATE'
  )
  and not exists (
    select 1
    from pg_catalog.pg_class application_table
    where application_table.relnamespace = public_namespace.oid
      and application_table.relkind in ('r', 'p')
      and application_table.oid <> acceptance_table.oid
      and application_table.relname not in (
        'orders',
        'judge_evidence',
        'audit_logs',
        'chain_transactions',
        'indexed_blocks',
        'indexer_cursors',
        'canonical_logs',
        'reorg_incidents',
        'receipts'
      )
      and not (
        pg_catalog.has_table_privilege(role.oid, application_table.oid, 'SELECT')
        and pg_catalog.has_table_privilege(role.oid, application_table.oid, 'INSERT')
        and pg_catalog.has_table_privilege(role.oid, application_table.oid, 'UPDATE')
        and pg_catalog.has_table_privilege(role.oid, application_table.oid, 'DELETE')
      )
  )
  and pg_catalog.has_table_privilege(role.oid, acceptance_table.oid, 'SELECT')
  and not pg_catalog.has_table_privilege(role.oid, acceptance_table.oid, 'INSERT')
  and not pg_catalog.has_table_privilege(role.oid, acceptance_table.oid, 'UPDATE')
  and not pg_catalog.has_table_privilege(role.oid, acceptance_table.oid, 'DELETE')
  and not pg_catalog.has_table_privilege(role.oid, acceptance_table.oid, 'TRUNCATE')
  and not pg_catalog.has_table_privilege(role.oid, acceptance_table.oid, 'REFERENCES')
  and not pg_catalog.has_table_privilege(role.oid, acceptance_table.oid, 'TRIGGER')
  and not pg_catalog.has_any_column_privilege(
    role.oid,
    acceptance_table.oid,
    'INSERT'
  )
  and not pg_catalog.has_any_column_privilege(
    role.oid,
    acceptance_table.oid,
    'UPDATE'
  )
  and not pg_catalog.has_any_column_privilege(
    role.oid,
    acceptance_table.oid,
    'REFERENCES'
  )
  and not exists (
    select 1
    from pg_catalog.pg_class protected_table
    where protected_table.relnamespace = public_namespace.oid
      and protected_table.relkind in ('r', 'p')
      and protected_table.relname in (
        'chain_transactions',
        'indexed_blocks',
        'indexer_cursors',
        'canonical_logs',
        'reorg_incidents',
        'receipts'
      )
      and (
        pg_catalog.has_table_privilege(role.oid, protected_table.oid, 'INSERT')
        or pg_catalog.has_table_privilege(role.oid, protected_table.oid, 'UPDATE')
        or pg_catalog.has_table_privilege(role.oid, protected_table.oid, 'DELETE')
        or pg_catalog.has_table_privilege(role.oid, protected_table.oid, 'TRUNCATE')
        or pg_catalog.has_table_privilege(role.oid, protected_table.oid, 'REFERENCES')
        or pg_catalog.has_table_privilege(role.oid, protected_table.oid, 'TRIGGER')
        or pg_catalog.has_any_column_privilege(role.oid, protected_table.oid, 'INSERT')
        or pg_catalog.has_any_column_privilege(role.oid, protected_table.oid, 'UPDATE')
        or pg_catalog.has_any_column_privilege(role.oid, protected_table.oid, 'REFERENCES')
      )
  )
  and pg_catalog.has_table_privilege(role.oid, orders_table.oid, 'SELECT')
  and not pg_catalog.has_table_privilege(role.oid, orders_table.oid, 'INSERT')
  and not pg_catalog.has_table_privilege(role.oid, orders_table.oid, 'UPDATE')
  and not pg_catalog.has_table_privilege(role.oid, orders_table.oid, 'DELETE')
  and pg_catalog.has_column_privilege(role.oid, orders_table.oid, 'id', 'INSERT')
  and pg_catalog.has_column_privilege(role.oid, orders_table.oid, 'status', 'INSERT')
  and pg_catalog.has_column_privilege(role.oid, orders_table.oid, 'status', 'UPDATE')
  and pg_catalog.has_column_privilege(
    role.oid,
    orders_table.oid,
    'provider_operation_id',
    'UPDATE'
  )
  and not pg_catalog.has_column_privilege(
    role.oid,
    orders_table.oid,
    'paid_amount_base_units',
    'INSERT'
  )
  and not pg_catalog.has_column_privilege(
    role.oid,
    orders_table.oid,
    'paid_amount_base_units',
    'UPDATE'
  )
  and pg_catalog.has_table_privilege(role.oid, audit_table.oid, 'SELECT')
  and pg_catalog.has_table_privilege(role.oid, audit_table.oid, 'INSERT')
  and not pg_catalog.has_table_privilege(role.oid, audit_table.oid, 'UPDATE')
  and not pg_catalog.has_table_privilege(role.oid, audit_table.oid, 'DELETE')
  and not pg_catalog.has_table_privilege(role.oid, audit_table.oid, 'TRUNCATE')
  and not pg_catalog.has_table_privilege(role.oid, audit_table.oid, 'REFERENCES')
  and not pg_catalog.has_table_privilege(role.oid, audit_table.oid, 'TRIGGER')
  and not pg_catalog.has_any_column_privilege(role.oid, audit_table.oid, 'UPDATE')
  and not pg_catalog.has_any_column_privilege(role.oid, audit_table.oid, 'REFERENCES')
  and not pg_catalog.has_column_privilege(role.oid, orders_table.oid, 'transaction_hash', 'INSERT')
  and not pg_catalog.has_column_privilege(role.oid, orders_table.oid, 'transaction_hash', 'UPDATE')
  and not pg_catalog.has_column_privilege(role.oid, orders_table.oid, 'block_number', 'INSERT')
  and not pg_catalog.has_column_privilege(role.oid, orders_table.oid, 'block_number', 'UPDATE')
  and not pg_catalog.has_column_privilege(role.oid, orders_table.oid, 'block_hash', 'INSERT')
  and not pg_catalog.has_column_privilege(role.oid, orders_table.oid, 'block_hash', 'UPDATE')
  and not pg_catalog.has_column_privilege(role.oid, orders_table.oid, 'log_index', 'INSERT')
  and not pg_catalog.has_column_privilege(role.oid, orders_table.oid, 'log_index', 'UPDATE')
  and not pg_catalog.has_column_privilege(role.oid, orders_table.oid, 'confirmed_at', 'INSERT')
  and not pg_catalog.has_column_privilege(role.oid, orders_table.oid, 'confirmed_at', 'UPDATE')
  as grants_valid
from pg_catalog.pg_roles role
inner join pg_catalog.pg_database database on database.datname = current_database()
inner join pg_catalog.pg_namespace public_namespace on public_namespace.nspname = 'public'
inner join pg_catalog.pg_class acceptance_table
  on acceptance_table.relnamespace = public_namespace.oid
  and acceptance_table.relname = 'live_acceptance_evidence'
  and acceptance_table.relkind in ('r', 'p')
inner join pg_catalog.pg_class judge_table
  on judge_table.relnamespace = public_namespace.oid
  and judge_table.relname = 'judge_evidence'
  and judge_table.relkind in ('r', 'p')
inner join pg_catalog.pg_class orders_table
  on orders_table.relnamespace = public_namespace.oid
  and orders_table.relname = 'orders'
  and orders_table.relkind in ('r', 'p')
inner join pg_catalog.pg_class audit_table
  on audit_table.relnamespace = public_namespace.oid
  and audit_table.relname = 'audit_logs'
  and audit_table.relkind in ('r', 'p')
where role.rolname = :'runtime_role'
\gset

\if :grants_valid
  commit;
  \echo 'OpenTab runtime role provisioned with application DML and a read-only live-acceptance boundary.'
\else
  rollback;
  \echo 'Runtime-role verification failed. Review ownership, memberships, PUBLIC schema/TEMP grants, and live-acceptance privileges.'
  do $$
  begin
    raise exception using
      errcode = '42501',
      message = 'Runtime-role privilege verification failed';
  end
  $$;
\endif
