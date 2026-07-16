import { AppError } from '@opentab/shared';
import { sql } from 'drizzle-orm';
import type { OpenTabDatabase } from './client.js';

interface IndexerPrivilegeSnapshot extends Record<string, unknown> {
  readonly directLogin: boolean;
  readonly canLogin: boolean;
  readonly inheritsRoles: boolean;
  readonly isSuperuser: boolean;
  readonly canCreateDatabase: boolean;
  readonly canCreateRole: boolean;
  readonly canReplicate: boolean;
  readonly bypassesRowSecurity: boolean;
  readonly isDatabaseOwner: boolean;
  readonly ownsSchema: boolean;
  readonly ownsRelation: boolean;
  readonly ownsRoutine: boolean;
  readonly ownsType: boolean;
  readonly hasRoleMembership: boolean;
  readonly canConnect: boolean;
  readonly canCreateDatabaseObjects: boolean;
  readonly canCreatePublicSchemaObjects: boolean;
  readonly canCreateTemporaryTables: boolean;
  readonly canUsePublicSchema: boolean;
  readonly hasEveryRequiredRead: boolean;
  readonly hasUnexpectedRead: boolean;
  readonly hasEveryRequiredInsert: boolean;
  readonly hasUnexpectedInsert: boolean;
  readonly hasEveryRequiredUpdate: boolean;
  readonly hasUnexpectedUpdate: boolean;
  readonly hasExactJudgePublicationUpdate: boolean;
  readonly hasUnexpectedJudgeUpdate: boolean;
  readonly hasForbiddenRelationPrivilege: boolean;
  readonly hasSequencePrivilege: boolean;
  readonly hasProtectedTemporaryRelation: boolean;
}

/**
 * Fail-closed startup gate for the dedicated indexer/reconciliation database
 * credential. The exact grant set intentionally excludes authentication,
 * sessions, ordinary audit logs, and append-only live-acceptance evidence.
 */
export async function assertIndexerDatabasePrivileges(db: OpenTabDatabase): Promise<void> {
  const rows = await db.execute<IndexerPrivilegeSnapshot>(sql`
    with required_read(relation_name) as (
      values
        ('bootstrap_grants'),
        ('canonical_logs'),
        ('chain_event_quarantine'),
        ('contract_operations'),
        ('dead_letters'),
        ('indexed_blocks'),
        ('indexer_cursors'),
        ('judge_evidence'),
        ('loyalty_awards'),
        ('loyalty_balances'),
        ('loyalty_programs'),
        ('merchants'),
        ('orders'),
        ('outbox_events'),
        ('payment_attempts'),
        ('products'),
        ('provider_operations'),
        ('receipts'),
        ('refunds'),
        ('reorg_incidents'),
        ('settlement_credits'),
        ('signed_order_intents'),
        ('sponsor_audit_events'),
        ('split_invitations'),
        ('split_participants'),
        ('split_payments'),
        ('splits'),
        ('users'),
        ('withdrawals')
    ),
    required_insert(relation_name) as (
      values
        ('canonical_logs'),
        ('chain_event_quarantine'),
        ('dead_letters'),
        ('indexed_blocks'),
        ('indexer_cursors'),
        ('loyalty_awards'),
        ('loyalty_balances'),
        ('outbox_events'),
        ('provider_operations'),
        ('receipts'),
        ('reorg_incidents'),
        ('settlement_credits'),
        ('sponsor_audit_events')
    ),
    required_update(relation_name) as (
      values
        ('bootstrap_grants'),
        ('canonical_logs'),
        ('chain_event_quarantine'),
        ('contract_operations'),
        ('indexed_blocks'),
        ('indexer_cursors'),
        ('loyalty_awards'),
        ('loyalty_balances'),
        ('merchants'),
        ('orders'),
        ('payment_attempts'),
        ('products'),
        ('provider_operations'),
        ('receipts'),
        ('refunds'),
        ('settlement_credits'),
        ('split_invitations'),
        ('split_participants'),
        ('split_payments'),
        ('splits'),
        ('withdrawals')
    ),
    allowed_judge_update(column_name) as (
      values ('published'), ('share_token_hash'), ('expires_at'), ('revoked_at'), ('updated_at')
    )
    select
      current_user = session_user as "directLogin",
      role.rolcanlogin as "canLogin",
      role.rolinherit as "inheritsRoles",
      role.rolsuper as "isSuperuser",
      role.rolcreatedb as "canCreateDatabase",
      role.rolcreaterole as "canCreateRole",
      role.rolreplication as "canReplicate",
      role.rolbypassrls as "bypassesRowSecurity",
      database.datdba = role.oid as "isDatabaseOwner",
      exists (select 1 from pg_catalog.pg_namespace owned where owned.nspowner = role.oid)
        as "ownsSchema",
      exists (select 1 from pg_catalog.pg_class owned where owned.relowner = role.oid)
        as "ownsRelation",
      exists (select 1 from pg_catalog.pg_proc owned where owned.proowner = role.oid)
        as "ownsRoutine",
      exists (select 1 from pg_catalog.pg_type owned where owned.typowner = role.oid)
        as "ownsType",
      exists (select 1 from pg_catalog.pg_auth_members membership where membership.member = role.oid)
        as "hasRoleMembership",
      pg_catalog.has_database_privilege(role.oid, database.oid, 'CONNECT') as "canConnect",
      pg_catalog.has_database_privilege(role.oid, database.oid, 'CREATE')
        as "canCreateDatabaseObjects",
      pg_catalog.has_schema_privilege(role.oid, public_namespace.oid, 'CREATE')
        as "canCreatePublicSchemaObjects",
      pg_catalog.has_database_privilege(role.oid, database.oid, 'TEMP')
        as "canCreateTemporaryTables",
      pg_catalog.has_schema_privilege(role.oid, public_namespace.oid, 'USAGE')
        as "canUsePublicSchema",
      not exists (
        select 1 from required_read required
        left join pg_catalog.pg_class relation
          on relation.relnamespace = public_namespace.oid
          and relation.relname = required.relation_name
          and relation.relkind in ('r', 'p')
        where relation.oid is null
          or not pg_catalog.has_table_privilege(role.oid, relation.oid, 'SELECT')
      ) as "hasEveryRequiredRead",
      exists (
        select 1 from pg_catalog.pg_class relation
        where relation.relnamespace = public_namespace.oid
          and relation.relkind in ('r', 'p')
          and relation.relname not in (select relation_name from required_read)
          and (
            pg_catalog.has_table_privilege(role.oid, relation.oid, 'SELECT')
            or pg_catalog.has_any_column_privilege(role.oid, relation.oid, 'SELECT')
          )
      ) as "hasUnexpectedRead",
      not exists (
        select 1 from required_insert required
        left join pg_catalog.pg_class relation
          on relation.relnamespace = public_namespace.oid
          and relation.relname = required.relation_name
          and relation.relkind in ('r', 'p')
        where relation.oid is null
          or not pg_catalog.has_table_privilege(role.oid, relation.oid, 'INSERT')
      ) as "hasEveryRequiredInsert",
      exists (
        select 1 from pg_catalog.pg_class relation
        where relation.relnamespace = public_namespace.oid
          and relation.relkind in ('r', 'p')
          and relation.relname not in (select relation_name from required_insert)
          and (
            pg_catalog.has_table_privilege(role.oid, relation.oid, 'INSERT')
            or pg_catalog.has_any_column_privilege(role.oid, relation.oid, 'INSERT')
          )
      ) as "hasUnexpectedInsert",
      not exists (
        select 1 from required_update required
        left join pg_catalog.pg_class relation
          on relation.relnamespace = public_namespace.oid
          and relation.relname = required.relation_name
          and relation.relkind in ('r', 'p')
        where relation.oid is null
          or not pg_catalog.has_table_privilege(role.oid, relation.oid, 'UPDATE')
      ) as "hasEveryRequiredUpdate",
      exists (
        select 1 from pg_catalog.pg_class relation
        where relation.relnamespace = public_namespace.oid
          and relation.relkind in ('r', 'p')
          and relation.relname not in (select relation_name from required_update)
          and relation.relname <> 'judge_evidence'
          and (
            pg_catalog.has_table_privilege(role.oid, relation.oid, 'UPDATE')
            or pg_catalog.has_any_column_privilege(role.oid, relation.oid, 'UPDATE')
          )
      ) as "hasUnexpectedUpdate",
      not pg_catalog.has_table_privilege(role.oid, judge_table.oid, 'UPDATE')
        and not exists (
          select 1 from allowed_judge_update allowed
          where not pg_catalog.has_column_privilege(
            role.oid,
            judge_table.oid,
            allowed.column_name,
            'UPDATE'
          )
        ) as "hasExactJudgePublicationUpdate",
      exists (
        select 1 from pg_catalog.pg_attribute attribute
        where attribute.attrelid = judge_table.oid
          and attribute.attnum > 0
          and not attribute.attisdropped
          and attribute.attname not in (select column_name from allowed_judge_update)
          and pg_catalog.has_column_privilege(role.oid, judge_table.oid, attribute.attname, 'UPDATE')
      ) as "hasUnexpectedJudgeUpdate",
      exists (
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
      ) as "hasForbiddenRelationPrivilege",
      exists (
        select 1 from pg_catalog.pg_class sequence_relation
        where sequence_relation.relnamespace = public_namespace.oid
          and sequence_relation.relkind = 'S'
          and (
            pg_catalog.has_sequence_privilege(role.oid, sequence_relation.oid, 'USAGE')
            or pg_catalog.has_sequence_privilege(role.oid, sequence_relation.oid, 'SELECT')
            or pg_catalog.has_sequence_privilege(role.oid, sequence_relation.oid, 'UPDATE')
          )
      ) as "hasSequencePrivilege",
      exists (
        select 1 from pg_catalog.pg_class temporary_relation
        where temporary_relation.relnamespace = pg_catalog.pg_my_temp_schema()
          and temporary_relation.relname in (select relation_name from required_read)
      ) as "hasProtectedTemporaryRelation"
    from pg_catalog.pg_roles role
    inner join pg_catalog.pg_database database on database.datname = pg_catalog.current_database()
    inner join pg_catalog.pg_namespace public_namespace on public_namespace.nspname = 'public'
    inner join pg_catalog.pg_class judge_table
      on judge_table.relnamespace = public_namespace.oid
      and judge_table.relname = 'judge_evidence'
      and judge_table.relkind in ('r', 'p')
    where role.rolname = current_user
  `);
  const snapshot = rows[0];
  const safe =
    snapshot?.directLogin === true &&
    snapshot.canLogin &&
    !snapshot.inheritsRoles &&
    !snapshot.isSuperuser &&
    !snapshot.canCreateDatabase &&
    !snapshot.canCreateRole &&
    !snapshot.canReplicate &&
    !snapshot.bypassesRowSecurity &&
    !snapshot.isDatabaseOwner &&
    !snapshot.ownsSchema &&
    !snapshot.ownsRelation &&
    !snapshot.ownsRoutine &&
    !snapshot.ownsType &&
    !snapshot.hasRoleMembership &&
    snapshot.canConnect &&
    !snapshot.canCreateDatabaseObjects &&
    !snapshot.canCreatePublicSchemaObjects &&
    !snapshot.canCreateTemporaryTables &&
    snapshot.canUsePublicSchema &&
    snapshot.hasEveryRequiredRead &&
    !snapshot.hasUnexpectedRead &&
    snapshot.hasEveryRequiredInsert &&
    !snapshot.hasUnexpectedInsert &&
    snapshot.hasEveryRequiredUpdate &&
    !snapshot.hasUnexpectedUpdate &&
    snapshot.hasExactJudgePublicationUpdate &&
    !snapshot.hasUnexpectedJudgeUpdate &&
    !snapshot.hasForbiddenRelationPrivilege &&
    !snapshot.hasSequencePrivilege &&
    !snapshot.hasProtectedTemporaryRelation;
  if (!safe) {
    throw new AppError(
      'CONFIGURATION_INVALID',
      'The indexer database credential does not satisfy the OpenTab projection boundary.',
    );
  }
}
