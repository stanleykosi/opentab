\set ON_ERROR_STOP on
\getenv runtime_role OPENTAB_RUNTIME_ROLE

select length(:'runtime_role') > 0 as input_valid
\gset
\if :input_valid
\else
  \echo 'OPENTAB_RUNTIME_ROLE is required.'
  \quit 1
\endif

begin;
select format('alter role %I nologin', :'runtime_role')
\gexec
select format('revoke all privileges on all tables in schema public from %I', :'runtime_role')
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
cross join (values ('select'), ('insert'), ('update'), ('references')) denied_privilege(name)
where namespace.nspname = 'public'
  and relation.relkind in ('r', 'p')
  and attribute.attnum > 0
  and not attribute.attisdropped
group by relation.relname, denied_privilege.name
\gexec
select format('revoke all privileges on all sequences in schema public from %I', :'runtime_role')
\gexec
select format('revoke all privileges on schema public from %I', :'runtime_role')
\gexec
select format('revoke all privileges on database %I from %I', current_database(), :'runtime_role')
\gexec
commit;

select
  not role.rolcanlogin
  and not has_table_privilege(:'runtime_role', 'public.orders', 'SELECT')
  and not has_table_privilege(:'runtime_role', 'public.live_acceptance_evidence', 'SELECT')
  as runtime_revoked
from pg_catalog.pg_roles role
where role.rolname = :'runtime_role'
\gset
\if :runtime_revoked
  \echo 'OpenTab runtime role login and application privileges revoked.'
\else
  \echo 'Runtime-role revocation verification failed.'
  \quit 1
\endif
