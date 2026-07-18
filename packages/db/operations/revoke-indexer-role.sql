\set ON_ERROR_STOP on
\getenv indexer_role OPENTAB_INDEXER_ROLE

select length(:'indexer_role') > 0 as input_valid
\gset
\if :input_valid
\else
  \echo 'OPENTAB_INDEXER_ROLE is required.'
  do $$ begin raise exception using errcode = '22023', message = 'Missing indexer role'; end $$;
\endif

begin;
select format('alter role %I nologin', :'indexer_role')
\gexec
select format('revoke all privileges on all tables in schema public from %I', :'indexer_role')
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
select format('revoke all privileges on all sequences in schema public from %I', :'indexer_role')
\gexec
select format(
  'revoke execute on function public.certify_particle_compatibility_profile(jsonb, jsonb) from %I',
  :'indexer_role'
)
\gexec
select format('revoke usage, create on schema public from %I', :'indexer_role')
\gexec
select format('revoke temporary on database %I from %I', current_database(), :'indexer_role')
\gexec
select format('revoke connect on database %I from %I', current_database(), :'indexer_role')
\gexec
commit;

select not rolcanlogin as login_revoked
from pg_catalog.pg_roles
where rolname = :'indexer_role'
\gset
\if :login_revoked
  \echo 'Indexer role login and database privileges revoked.'
\else
  do $$ begin raise exception using errcode = '42501', message = 'Indexer role revocation failed'; end $$;
\endif
