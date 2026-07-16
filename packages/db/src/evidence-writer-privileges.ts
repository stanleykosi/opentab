import { AppError } from '@opentab/shared';
import { sql } from 'drizzle-orm';
import type { OpenTabDatabase } from './client.js';

interface EvidenceWriterPrivilegeSnapshot extends Record<string, unknown> {
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
  readonly hasUnexpectedMutation: boolean;
  readonly canReadAcceptance: boolean;
  readonly canInsertAcceptance: boolean;
  readonly canUpdateAcceptance: boolean;
  readonly canDeleteAcceptance: boolean;
  readonly canTruncateAcceptance: boolean;
  readonly canReferenceAcceptance: boolean;
  readonly canTriggerAcceptance: boolean;
  readonly canUpdateAnyAcceptanceColumn: boolean;
  readonly canReferenceAnyAcceptanceColumn: boolean;
  readonly hasSequencePrivilege: boolean;
  readonly hasProtectedTemporaryRelation: boolean;
}

/**
 * Fail-closed privilege gate for the isolated live-acceptance writer.
 *
 * This query uses only pg_catalog OIDs and fully qualified names. It runs
 * before any application-table read, so an unsafe credential cannot use a
 * temporary/search-path shadow relation to manufacture acceptance evidence.
 */
export async function assertEvidenceWriterDatabasePrivileges(db: OpenTabDatabase): Promise<void> {
  await db.execute(sql`set local search_path = pg_catalog, public`);
  const rows = await db.execute<EvidenceWriterPrivilegeSnapshot>(sql`
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
      current_user = session_user as "directLogin",
      role.rolcanlogin as "canLogin",
      role.rolinherit as "inheritsRoles",
      role.rolsuper as "isSuperuser",
      role.rolcreatedb as "canCreateDatabase",
      role.rolcreaterole as "canCreateRole",
      role.rolreplication as "canReplicate",
      role.rolbypassrls as "bypassesRowSecurity",
      database.datdba = role.oid as "isDatabaseOwner",
      exists (
        select 1
        from pg_catalog.pg_namespace owned_namespace
        where owned_namespace.nspowner = role.oid
      ) as "ownsSchema",
      exists (
        select 1
        from pg_catalog.pg_class owned_relation
        where owned_relation.relowner = role.oid
      ) as "ownsRelation",
      exists (
        select 1
        from pg_catalog.pg_proc owned_routine
        where owned_routine.proowner = role.oid
      ) as "ownsRoutine",
      exists (
        select 1
        from pg_catalog.pg_type owned_type
        where owned_type.typowner = role.oid
      ) as "ownsType",
      exists (
        select 1
        from pg_catalog.pg_auth_members membership
        where membership.member = role.oid
      ) as "hasRoleMembership",
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
        select 1
        from required_read required
        left join pg_catalog.pg_class required_relation
          on required_relation.relnamespace = public_namespace.oid
          and required_relation.relname = required.relation_name
          and required_relation.relkind in ('r', 'p')
        where required_relation.oid is null
          or not pg_catalog.has_table_privilege(role.oid, required_relation.oid, 'SELECT')
      ) as "hasEveryRequiredRead",
      exists (
        select 1
        from pg_catalog.pg_class readable_relation
        where readable_relation.relnamespace = public_namespace.oid
          and readable_relation.relkind in ('r', 'p')
          and readable_relation.relname not in (select relation_name from required_read)
          and (
            pg_catalog.has_table_privilege(role.oid, readable_relation.oid, 'SELECT')
            or pg_catalog.has_any_column_privilege(role.oid, readable_relation.oid, 'SELECT')
          )
      ) as "hasUnexpectedRead",
      exists (
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
      ) as "hasUnexpectedMutation",
      pg_catalog.has_table_privilege(role.oid, acceptance_table.oid, 'SELECT')
        as "canReadAcceptance",
      pg_catalog.has_table_privilege(role.oid, acceptance_table.oid, 'INSERT')
        as "canInsertAcceptance",
      pg_catalog.has_table_privilege(role.oid, acceptance_table.oid, 'UPDATE')
        as "canUpdateAcceptance",
      pg_catalog.has_table_privilege(role.oid, acceptance_table.oid, 'DELETE')
        as "canDeleteAcceptance",
      pg_catalog.has_table_privilege(role.oid, acceptance_table.oid, 'TRUNCATE')
        as "canTruncateAcceptance",
      pg_catalog.has_table_privilege(role.oid, acceptance_table.oid, 'REFERENCES')
        as "canReferenceAcceptance",
      pg_catalog.has_table_privilege(role.oid, acceptance_table.oid, 'TRIGGER')
        as "canTriggerAcceptance",
      pg_catalog.has_any_column_privilege(role.oid, acceptance_table.oid, 'UPDATE')
        as "canUpdateAnyAcceptanceColumn",
      pg_catalog.has_any_column_privilege(role.oid, acceptance_table.oid, 'REFERENCES')
        as "canReferenceAnyAcceptanceColumn",
      exists (
        select 1
        from pg_catalog.pg_class sequence_relation
        where sequence_relation.relnamespace = public_namespace.oid
          and sequence_relation.relkind = 'S'
          and (
            pg_catalog.has_sequence_privilege(role.oid, sequence_relation.oid, 'USAGE')
            or pg_catalog.has_sequence_privilege(role.oid, sequence_relation.oid, 'SELECT')
            or pg_catalog.has_sequence_privilege(role.oid, sequence_relation.oid, 'UPDATE')
          )
      ) as "hasSequencePrivilege",
      exists (
        select 1
        from pg_catalog.pg_class temporary_relation
        where temporary_relation.relnamespace = pg_catalog.pg_my_temp_schema()
          and temporary_relation.relname in (select relation_name from required_read)
      ) as "hasProtectedTemporaryRelation"
    from pg_catalog.pg_roles role
    inner join pg_catalog.pg_database database
      on database.datname = pg_catalog.current_database()
    inner join pg_catalog.pg_namespace public_namespace
      on public_namespace.nspname = 'public'
    inner join pg_catalog.pg_class acceptance_table
      on acceptance_table.relnamespace = public_namespace.oid
      and acceptance_table.relname = 'live_acceptance_evidence'
      and acceptance_table.relkind in ('r', 'p')
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
    !snapshot.hasUnexpectedMutation &&
    snapshot.canReadAcceptance &&
    snapshot.canInsertAcceptance &&
    !snapshot.canUpdateAcceptance &&
    !snapshot.canDeleteAcceptance &&
    !snapshot.canTruncateAcceptance &&
    !snapshot.canReferenceAcceptance &&
    !snapshot.canTriggerAcceptance &&
    !snapshot.canUpdateAnyAcceptanceColumn &&
    !snapshot.canReferenceAnyAcceptanceColumn &&
    !snapshot.hasSequencePrivilege &&
    !snapshot.hasProtectedTemporaryRelation;
  if (!safe) {
    throw new AppError(
      'CONFIGURATION_INVALID',
      'The acceptance-writer database credential does not satisfy the OpenTab append-only boundary.',
    );
  }
}
