\set ON_ERROR_STOP on
\getenv indexer_role OPENTAB_INDEXER_ROLE
\getenv indexer_password OPENTAB_INDEXER_PASSWORD

select
  length(:'indexer_role') > 0
  and length(:'indexer_password') >= 32
  and :'indexer_role' <> current_user
  as inputs_valid
\gset
\if :inputs_valid
\else
  \echo 'A non-owner OPENTAB_INDEXER_ROLE and a 32+ character OPENTAB_INDEXER_PASSWORD are required.'
  do $$ begin raise exception using errcode = '22023', message = 'Invalid indexer role inputs'; end $$;
\endif

begin;

select format(
  'create role %I login password %L nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls connection limit 12',
  :'indexer_role',
  :'indexer_password'
)
where not exists (select 1 from pg_catalog.pg_roles where rolname = :'indexer_role')
\gexec

select format(
  'alter role %I with login password %L nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls connection limit 12',
  :'indexer_role',
  :'indexer_password'
)
\gexec

select format('revoke %I from %I', granted_role.rolname, :'indexer_role')
from pg_catalog.pg_auth_members membership
inner join pg_catalog.pg_roles member_role on member_role.oid = membership.member
inner join pg_catalog.pg_roles granted_role on granted_role.oid = membership.roleid
where member_role.rolname = :'indexer_role'
\gexec

select format('alter role %I set search_path = pg_catalog, public', :'indexer_role')
\gexec
select format('alter role %I set statement_timeout = %L', :'indexer_role', '120s')
\gexec
select format(
  'alter role %I set idle_in_transaction_session_timeout = %L',
  :'indexer_role',
  '30s'
)
\gexec

select format('revoke all privileges on database %I from %I', current_database(), :'indexer_role')
\gexec
select format('revoke all privileges on all tables in schema public from %I', :'indexer_role')
\gexec
select format('revoke all privileges on all sequences in schema public from %I', :'indexer_role')
\gexec
select format('revoke all privileges on schema public from %I', :'indexer_role')
\gexec
select format(
  'revoke %s (%s) on table public.%I from %I',
  denied_privilege.name,
  string_agg(format('%I', attribute.attname), ', ' order by attribute.attnum),
  relation.relname,
  :'indexer_role'
)
from pg_catalog.pg_attribute attribute
inner join pg_catalog.pg_class relation on relation.oid = attribute.attrelid
inner join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
cross join (values ('select'), ('insert'), ('update'), ('references')) denied_privilege(name)
where namespace.nspname = 'public'
  and relation.relkind in ('r', 'p')
  and attribute.attnum > 0
  and not attribute.attisdropped
group by relation.relname, denied_privilege.name
\gexec

revoke create on schema public from public;
select format('revoke temporary on database %I from public', current_database())
\gexec
select format('revoke temporary on database %I from %I', current_database(), :'indexer_role')
\gexec
select format('grant connect on database %I to %I', current_database(), :'indexer_role')
\gexec
select format('grant usage on schema public to %I', :'indexer_role')
\gexec

select format(
  'grant select on table public.bootstrap_grants, public.canonical_logs, public.chain_event_quarantine, public.contract_operations, public.dead_letters, public.indexed_blocks, public.indexer_cursors, public.judge_evidence, public.loyalty_awards, public.loyalty_balances, public.loyalty_programs, public.merchants, public.orders, public.outbox_events, public.particle_compatibility_profiles, public.particle_profile_release_bindings, public.payment_attempts, public.products, public.provider_operations, public.receipts, public.refunds, public.reorg_incidents, public.settlement_credits, public.signed_order_intents, public.sponsor_audit_events, public.split_invitations, public.split_participants, public.split_payments, public.splits, public.users, public.withdrawals to %I',
  :'indexer_role'
)
\gexec
select format(
  'grant insert on table public.canonical_logs, public.chain_event_quarantine, public.dead_letters, public.indexed_blocks, public.indexer_cursors, public.loyalty_awards, public.loyalty_balances, public.outbox_events, public.provider_operations, public.receipts, public.reorg_incidents, public.settlement_credits, public.sponsor_audit_events to %I',
  :'indexer_role'
)
\gexec
select format(
  'grant update on table public.bootstrap_grants, public.canonical_logs, public.chain_event_quarantine, public.contract_operations, public.indexed_blocks, public.indexer_cursors, public.loyalty_awards, public.loyalty_balances, public.merchants, public.orders, public.payment_attempts, public.products, public.provider_operations, public.receipts, public.refunds, public.settlement_credits, public.split_invitations, public.split_participants, public.split_payments, public.splits, public.withdrawals to %I',
  :'indexer_role'
)
\gexec
select format(
  'grant update (published, share_token_hash, expires_at, revoked_at, updated_at) on table public.judge_evidence to %I',
  :'indexer_role'
)
\gexec

with required_read(relation_name) as (
  values
    ('bootstrap_grants'), ('canonical_logs'), ('chain_event_quarantine'),
    ('contract_operations'), ('dead_letters'), ('indexed_blocks'), ('indexer_cursors'),
    ('judge_evidence'), ('loyalty_awards'), ('loyalty_balances'), ('loyalty_programs'),
    ('merchants'), ('orders'), ('outbox_events'), ('particle_compatibility_profiles'),
    ('particle_profile_release_bindings'), ('payment_attempts'), ('products'),
    ('provider_operations'), ('receipts'), ('refunds'), ('reorg_incidents'),
    ('settlement_credits'), ('signed_order_intents'), ('sponsor_audit_events'),
    ('split_invitations'), ('split_participants'), ('split_payments'), ('splits'),
    ('users'), ('withdrawals')
),
required_insert(relation_name) as (
  values
    ('canonical_logs'), ('chain_event_quarantine'), ('dead_letters'), ('indexed_blocks'),
    ('indexer_cursors'), ('loyalty_awards'), ('loyalty_balances'), ('outbox_events'),
    ('provider_operations'), ('receipts'), ('reorg_incidents'), ('settlement_credits'),
    ('sponsor_audit_events')
),
required_update(relation_name) as (
  values
    ('bootstrap_grants'), ('canonical_logs'), ('chain_event_quarantine'),
    ('contract_operations'), ('indexed_blocks'), ('indexer_cursors'), ('loyalty_awards'),
    ('loyalty_balances'), ('merchants'), ('orders'), ('payment_attempts'), ('products'),
    ('provider_operations'), ('receipts'), ('refunds'), ('settlement_credits'),
    ('split_invitations'), ('split_participants'), ('split_payments'), ('splits'),
    ('withdrawals')
)
select
  role.rolcanlogin
  and not role.rolinherit
  and not role.rolsuper
  and not role.rolcreatedb
  and not role.rolcreaterole
  and not role.rolreplication
  and not role.rolbypassrls
  and database.datdba <> role.oid
  and not pg_catalog.has_database_privilege(role.oid, database.oid, 'CREATE')
  and not pg_catalog.has_database_privilege(role.oid, database.oid, 'TEMP')
  and pg_catalog.has_database_privilege(role.oid, database.oid, 'CONNECT')
  and pg_catalog.has_schema_privilege(role.oid, public_namespace.oid, 'USAGE')
  and not pg_catalog.has_schema_privilege(role.oid, public_namespace.oid, 'CREATE')
  and not exists (select 1 from pg_catalog.pg_auth_members where member = role.oid)
  and not exists (select 1 from pg_catalog.pg_namespace where nspowner = role.oid)
  and not exists (select 1 from pg_catalog.pg_class where relowner = role.oid)
  and not exists (select 1 from pg_catalog.pg_proc where proowner = role.oid)
  and not exists (select 1 from pg_catalog.pg_type where typowner = role.oid)
  and not exists (
    select 1 from required_read required
    left join pg_catalog.pg_class relation
      on relation.relnamespace = public_namespace.oid
      and relation.relname = required.relation_name
      and relation.relkind in ('r', 'p')
    where relation.oid is null
      or not pg_catalog.has_table_privilege(role.oid, relation.oid, 'SELECT')
  )
  and not exists (
    select 1 from pg_catalog.pg_class relation
    where relation.relnamespace = public_namespace.oid
      and relation.relkind in ('r', 'p')
      and relation.relname not in (select relation_name from required_read)
      and (
        pg_catalog.has_table_privilege(role.oid, relation.oid, 'SELECT')
        or pg_catalog.has_any_column_privilege(role.oid, relation.oid, 'SELECT')
      )
  )
  and not exists (
    select 1 from required_insert required
    left join pg_catalog.pg_class relation
      on relation.relnamespace = public_namespace.oid
      and relation.relname = required.relation_name
      and relation.relkind in ('r', 'p')
    where relation.oid is null
      or not pg_catalog.has_table_privilege(role.oid, relation.oid, 'INSERT')
  )
  and not exists (
    select 1 from pg_catalog.pg_class relation
    where relation.relnamespace = public_namespace.oid
      and relation.relkind in ('r', 'p')
      and relation.relname not in (select relation_name from required_insert)
      and (
        pg_catalog.has_table_privilege(role.oid, relation.oid, 'INSERT')
        or pg_catalog.has_any_column_privilege(role.oid, relation.oid, 'INSERT')
      )
  )
  and not exists (
    select 1 from required_update required
    left join pg_catalog.pg_class relation
      on relation.relnamespace = public_namespace.oid
      and relation.relname = required.relation_name
      and relation.relkind in ('r', 'p')
    where relation.oid is null
      or not pg_catalog.has_table_privilege(role.oid, relation.oid, 'UPDATE')
  )
  and not pg_catalog.has_table_privilege(role.oid, judge_table.oid, 'UPDATE')
  and pg_catalog.has_column_privilege(role.oid, judge_table.oid, 'published', 'UPDATE')
  and pg_catalog.has_column_privilege(role.oid, judge_table.oid, 'share_token_hash', 'UPDATE')
  and pg_catalog.has_column_privilege(role.oid, judge_table.oid, 'expires_at', 'UPDATE')
  and pg_catalog.has_column_privilege(role.oid, judge_table.oid, 'revoked_at', 'UPDATE')
  and pg_catalog.has_column_privilege(role.oid, judge_table.oid, 'updated_at', 'UPDATE')
  and not pg_catalog.has_column_privilege(role.oid, judge_table.oid, 'public_proof', 'UPDATE')
  and not pg_catalog.has_column_privilege(role.oid, judge_table.oid, 'public_proof_digest', 'UPDATE')
  and not exists (
    select 1 from pg_catalog.pg_class relation
    where relation.relnamespace = public_namespace.oid
      and relation.relkind in ('r', 'p')
      and (
        pg_catalog.has_table_privilege(role.oid, relation.oid, 'DELETE')
        or pg_catalog.has_table_privilege(role.oid, relation.oid, 'TRUNCATE')
        or pg_catalog.has_table_privilege(role.oid, relation.oid, 'REFERENCES')
        or pg_catalog.has_table_privilege(role.oid, relation.oid, 'TRIGGER')
        or pg_catalog.has_any_column_privilege(role.oid, relation.oid, 'REFERENCES')
      )
  )
  and not pg_catalog.has_function_privilege(
    role.oid,
    'public.certify_particle_compatibility_profile(jsonb,jsonb)',
    'EXECUTE'
  ) as grants_valid
from pg_catalog.pg_roles role
inner join pg_catalog.pg_database database on database.datname = current_database()
inner join pg_catalog.pg_namespace public_namespace on public_namespace.nspname = 'public'
inner join pg_catalog.pg_class judge_table
  on judge_table.relnamespace = public_namespace.oid
  and judge_table.relname = 'judge_evidence'
  and judge_table.relkind in ('r', 'p')
where role.rolname = :'indexer_role'
\gset

\if :grants_valid
  commit;
  \echo 'OpenTab indexer role provisioned with exact projection and reconciliation privileges.'
\else
  rollback;
  \echo 'Indexer-role privilege verification failed.'
  do $$ begin raise exception using errcode = '42501', message = 'Indexer role privilege verification failed'; end $$;
\endif
