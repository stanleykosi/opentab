\set ON_ERROR_STOP on
\getenv evidence_writer_role OPENTAB_EVIDENCE_WRITER_ROLE

select length(:'evidence_writer_role') > 0 as input_valid
\gset
\if :input_valid
\else
  \echo 'OPENTAB_EVIDENCE_WRITER_ROLE is required.'
  \quit 1
\endif

begin;
select format('alter role %I nologin', :'evidence_writer_role')
\gexec
select format('revoke all privileges on all tables in schema public from %I', :'evidence_writer_role')
\gexec
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
select format('revoke all privileges on all sequences in schema public from %I', :'evidence_writer_role')
\gexec
select format(
  'revoke execute on function public.certify_particle_compatibility_profile(jsonb, jsonb) from %I',
  :'evidence_writer_role'
)
\gexec
select format('revoke usage, create on schema public from %I', :'evidence_writer_role')
\gexec
select format(
  'revoke temporary on database %I from %I',
  current_database(),
  :'evidence_writer_role'
)
\gexec
select format('revoke connect on database %I from %I', current_database(), :'evidence_writer_role')
\gexec
commit;

select not rolcanlogin as login_revoked
from pg_catalog.pg_roles
where rolname = :'evidence_writer_role'
\gset
\if :login_revoked
  \echo 'Evidence-writer role login and database privileges revoked.'
\else
  \echo 'Evidence-writer role revocation verification failed.'
  \quit 1
\endif
