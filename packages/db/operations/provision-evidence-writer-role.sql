\set ON_ERROR_STOP on
\getenv evidence_writer_role OPENTAB_EVIDENCE_WRITER_ROLE
\getenv evidence_writer_password OPENTAB_EVIDENCE_WRITER_PASSWORD

select
  length(:'evidence_writer_role') > 0
  and length(:'evidence_writer_password') >= 32
  and :'evidence_writer_role' <> current_user
  as inputs_valid
\gset
\if :inputs_valid
\else
  \echo 'A non-owner OPENTAB_EVIDENCE_WRITER_ROLE and a 32+ character OPENTAB_EVIDENCE_WRITER_PASSWORD are required.'
  \quit 1
\endif

begin;

select format(
  'create role %I login password %L nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls connection limit 2',
  :'evidence_writer_role',
  :'evidence_writer_password'
)
where not exists (
  select 1 from pg_catalog.pg_roles where rolname = :'evidence_writer_role'
)
\gexec

select format(
  'alter role %I with login password %L nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls connection limit 2',
  :'evidence_writer_role',
  :'evidence_writer_password'
)
\gexec

-- NOINHERIT does not prevent SET ROLE. Remove every direct membership so a
-- compromised writer credential cannot assume a more privileged role.
select format('revoke %I from %I', granted_role.rolname, :'evidence_writer_role')
from pg_catalog.pg_auth_members membership
inner join pg_catalog.pg_roles member_role on member_role.oid = membership.member
inner join pg_catalog.pg_roles granted_role on granted_role.oid = membership.roleid
where member_role.rolname = :'evidence_writer_role'
\gexec

select format('alter role %I set search_path = pg_catalog, public', :'evidence_writer_role')
\gexec
select format('alter role %I set statement_timeout = %L', :'evidence_writer_role', '30s')
\gexec
select format(
  'alter role %I set idle_in_transaction_session_timeout = %L',
  :'evidence_writer_role',
  '15s'
)
\gexec

select format('revoke all privileges on database %I from %I', current_database(), :'evidence_writer_role')
\gexec
select format('revoke all privileges on all tables in schema public from %I', :'evidence_writer_role')
\gexec
select format('revoke all privileges on all sequences in schema public from %I', :'evidence_writer_role')
\gexec
select format('revoke all privileges on schema public from %I', :'evidence_writer_role')
\gexec
-- Table-level REVOKE does not clear old column-level grants. Remove every
-- column grant before rebuilding the exact SELECT + append-only INSERT set.
select format(
  'revoke %s (%s) on table public.%I from %I',
  denied_privilege.name,
  string_agg(format('%I', attribute.attname), ', ' order by attribute.attnum),
  relation.relname,
  :'evidence_writer_role'
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

-- PUBLIC grants are effective grants. Harden the application database itself
-- so neither pg_temp nor a public-schema shadow can precede canonical tables.
revoke create on schema public from public;
select format('revoke temporary on database %I from public', current_database())
\gexec
select format(
  'revoke temporary on database %I from %I',
  current_database(),
  :'evidence_writer_role'
)
\gexec
select format('grant connect on database %I to %I', current_database(), :'evidence_writer_role')
\gexec
select format('grant usage on schema public to %I', :'evidence_writer_role')
\gexec
select format(
  'grant select on table public.user_identities, public.merchants, public.products, public.signed_order_intents, public.orders, public.payment_attempts, public.provider_operations, public.canonical_logs, public.receipts, public.wallet_accounts, public.delegation_records, public.bootstrap_grants, public.live_acceptance_evidence to %I',
  :'evidence_writer_role'
)
\gexec
select format(
  'grant insert on table public.live_acceptance_evidence to %I',
  :'evidence_writer_role'
)
\gexec
with required_read(relation_name) as (
  values
    ('user_identities'),
    ('merchants'),
    ('products'),
    ('signed_order_intents'),
    ('orders'),
    ('payment_attempts'),
    ('provider_operations'),
    ('canonical_logs'),
    ('receipts'),
    ('wallet_accounts'),
    ('delegation_records'),
    ('bootstrap_grants'),
    ('live_acceptance_evidence')
)
select
  role.rolcanlogin
  and not role.rolinherit
  and not role.rolsuper
  and not role.rolcreatedb
  and not role.rolcreaterole
  and not role.rolreplication
  and not role.rolbypassrls
  and not exists (
    select 1 from pg_catalog.pg_auth_members membership where membership.member = role.oid
  )
  and not exists (
    select 1 from pg_catalog.pg_database owned_database where owned_database.datdba = role.oid
  )
  and not exists (
    select 1 from pg_catalog.pg_namespace owned_namespace where owned_namespace.nspowner = role.oid
  )
  and not exists (
    select 1 from pg_catalog.pg_class owned_relation where owned_relation.relowner = role.oid
  )
  and not exists (
    select 1 from pg_catalog.pg_proc owned_routine where owned_routine.proowner = role.oid
  )
  and not exists (
    select 1 from pg_catalog.pg_type owned_type where owned_type.typowner = role.oid
  )
  and pg_catalog.has_database_privilege(role.oid, database.oid, 'CONNECT')
  and not pg_catalog.has_database_privilege(role.oid, database.oid, 'CREATE')
  and not pg_catalog.has_database_privilege(role.oid, database.oid, 'TEMP')
  and pg_catalog.has_schema_privilege(role.oid, public_namespace.oid, 'USAGE')
  and not pg_catalog.has_schema_privilege(role.oid, public_namespace.oid, 'CREATE')
  and not exists (
    select 1
    from required_read required
    left join pg_catalog.pg_class required_relation
      on required_relation.relnamespace = public_namespace.oid
      and required_relation.relname = required.relation_name
      and required_relation.relkind in ('r', 'p')
    where required_relation.oid is null
      or not pg_catalog.has_table_privilege(role.oid, required_relation.oid, 'SELECT')
  )
  and not exists (
    select 1
    from pg_catalog.pg_class readable_relation
    where readable_relation.relnamespace = public_namespace.oid
      and readable_relation.relkind in ('r', 'p')
      and readable_relation.relname not in (select relation_name from required_read)
      and (
        pg_catalog.has_table_privilege(role.oid, readable_relation.oid, 'SELECT')
        or pg_catalog.has_any_column_privilege(role.oid, readable_relation.oid, 'SELECT')
      )
  )
  and pg_catalog.has_table_privilege(role.oid, acceptance_table.oid, 'INSERT')
  and not pg_catalog.has_table_privilege(role.oid, acceptance_table.oid, 'UPDATE')
  and not pg_catalog.has_table_privilege(role.oid, acceptance_table.oid, 'DELETE')
  and not pg_catalog.has_table_privilege(role.oid, acceptance_table.oid, 'TRUNCATE')
  and not pg_catalog.has_table_privilege(role.oid, acceptance_table.oid, 'REFERENCES')
  and not pg_catalog.has_table_privilege(role.oid, acceptance_table.oid, 'TRIGGER')
  and not pg_catalog.has_any_column_privilege(role.oid, acceptance_table.oid, 'UPDATE')
  and not pg_catalog.has_any_column_privilege(role.oid, acceptance_table.oid, 'REFERENCES')
  and not exists (
    select 1
    from pg_catalog.pg_class mutable_relation
    where mutable_relation.relnamespace = public_namespace.oid
      and mutable_relation.relkind in ('r', 'p')
      and mutable_relation.oid <> acceptance_table.oid
      and (
        pg_catalog.has_table_privilege(role.oid, mutable_relation.oid, 'INSERT')
        or pg_catalog.has_table_privilege(role.oid, mutable_relation.oid, 'UPDATE')
        or pg_catalog.has_table_privilege(role.oid, mutable_relation.oid, 'DELETE')
        or pg_catalog.has_table_privilege(role.oid, mutable_relation.oid, 'TRUNCATE')
        or pg_catalog.has_table_privilege(role.oid, mutable_relation.oid, 'REFERENCES')
        or pg_catalog.has_table_privilege(role.oid, mutable_relation.oid, 'TRIGGER')
        or pg_catalog.has_any_column_privilege(role.oid, mutable_relation.oid, 'INSERT')
        or pg_catalog.has_any_column_privilege(role.oid, mutable_relation.oid, 'UPDATE')
        or pg_catalog.has_any_column_privilege(role.oid, mutable_relation.oid, 'REFERENCES')
      )
  )
  and not exists (
    select 1
    from pg_catalog.pg_class sequence_relation
    where sequence_relation.relnamespace = public_namespace.oid
      and sequence_relation.relkind = 'S'
      and (
        pg_catalog.has_sequence_privilege(role.oid, sequence_relation.oid, 'USAGE')
        or pg_catalog.has_sequence_privilege(role.oid, sequence_relation.oid, 'SELECT')
        or pg_catalog.has_sequence_privilege(role.oid, sequence_relation.oid, 'UPDATE')
      )
  )
  as grants_valid
from pg_catalog.pg_roles role
inner join pg_catalog.pg_database database on database.datname = current_database()
inner join pg_catalog.pg_namespace public_namespace on public_namespace.nspname = 'public'
inner join pg_catalog.pg_class acceptance_table
  on acceptance_table.relnamespace = public_namespace.oid
  and acceptance_table.relname = 'live_acceptance_evidence'
  and acceptance_table.relkind in ('r', 'p')
where role.rolname = :'evidence_writer_role'
\gset
\if :grants_valid
  commit;
  \echo 'Evidence-writer role provisioned with SELECT plus append-only acceptance INSERT privileges.'
\else
  rollback;
  \echo 'Evidence-writer role privilege verification failed. Review table grants, inherited CREATE ON SCHEMA public, and inherited TEMPORARY database privileges.'
  do $$
  begin
    raise exception using
      errcode = '42501',
      message = 'Evidence-writer role privilege verification failed';
  end
  $$;
\endif
