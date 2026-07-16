import { AppError } from '@opentab/shared';
import { sql } from 'drizzle-orm';
import type { OpenTabDatabase } from './client.js';

interface RuntimePrivilegeSnapshot extends Record<string, unknown> {
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
  readonly canCreateDatabaseObjects: boolean;
  readonly canCreatePublicSchemaObjects: boolean;
  readonly canCreateTemporaryTables: boolean;
  readonly canReadOrders: boolean;
  readonly canInsertOrderId: boolean;
  readonly canUpdateOrderStatus: boolean;
  readonly canInsertOrderPaidProof: boolean;
  readonly canUpdateOrderPaidProof: boolean;
  readonly canReadCanonicalLogs: boolean;
  readonly canMutateCanonicalLogs: boolean;
  readonly canReadIndexedBlocks: boolean;
  readonly canMutateIndexedBlocks: boolean;
  readonly canReadReceipts: boolean;
  readonly canMutateReceipts: boolean;
  readonly canReadJudgeEvidence: boolean;
  readonly canInsertJudgeEvidence: boolean;
  readonly canUpdateJudgeEvidence: boolean;
  readonly canDeleteJudgeEvidence: boolean;
  readonly canUpdateJudgePublication: boolean;
  readonly canUpdateJudgeProof: boolean;
  readonly canUpdateJudgeProofDigest: boolean;
  readonly canReadAuditLogs: boolean;
  readonly canInsertAuditLogs: boolean;
  readonly canMutateAuditLogs: boolean;
  readonly canReadAcceptance: boolean;
  readonly canInsertAcceptance: boolean;
  readonly canUpdateAcceptance: boolean;
  readonly canDeleteAcceptance: boolean;
  readonly canTruncateAcceptance: boolean;
  readonly canReferenceAcceptance: boolean;
  readonly canTriggerAcceptance: boolean;
  readonly canInsertAnyAcceptanceColumn: boolean;
  readonly canUpdateAnyAcceptanceColumn: boolean;
  readonly canReferenceAnyAcceptanceColumn: boolean;
}

/**
 * Fail-closed production gate for the ordinary web/API database credential.
 * Every catalog object is schema-qualified so this check remains trustworthy
 * before the application touches any workflow relation.
 */
export async function assertRuntimeDatabasePrivileges(db: OpenTabDatabase): Promise<void> {
  const rows = await db.execute<RuntimePrivilegeSnapshot>(sql`
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
      exists(
        select 1
        from pg_catalog.pg_namespace owned_namespace
        where owned_namespace.nspowner = role.oid
      ) as "ownsSchema",
      exists(
        select 1
        from pg_catalog.pg_class owned_relation
        where owned_relation.relowner = role.oid
      ) as "ownsRelation",
      exists(
        select 1
        from pg_catalog.pg_proc owned_routine
        where owned_routine.proowner = role.oid
      ) as "ownsRoutine",
      exists(
        select 1
        from pg_catalog.pg_type owned_type
        where owned_type.typowner = role.oid
      ) as "ownsType",
      exists(
        select 1
        from pg_catalog.pg_auth_members membership
        where membership.member = role.oid
      ) as "hasRoleMembership",
      pg_catalog.has_database_privilege(
        role.oid,
        database.oid,
        'CREATE'
      ) as "canCreateDatabaseObjects",
      pg_catalog.has_schema_privilege(
        role.oid,
        public_namespace.oid,
        'CREATE'
      ) as "canCreatePublicSchemaObjects",
      pg_catalog.has_database_privilege(
        role.oid,
        database.oid,
        'TEMP'
      ) as "canCreateTemporaryTables",
      pg_catalog.has_table_privilege(role.oid, orders_table.oid, 'SELECT') as "canReadOrders",
      pg_catalog.has_column_privilege(
        role.oid,
        orders_table.oid,
        'id',
        'INSERT'
      ) as "canInsertOrderId",
      pg_catalog.has_column_privilege(
        role.oid,
        orders_table.oid,
        'status',
        'UPDATE'
      ) as "canUpdateOrderStatus",
      pg_catalog.has_column_privilege(
        role.oid,
        orders_table.oid,
        'transaction_hash',
        'INSERT'
      ) as "canInsertOrderPaidProof",
      pg_catalog.has_column_privilege(
        role.oid,
        orders_table.oid,
        'transaction_hash',
        'UPDATE'
      ) as "canUpdateOrderPaidProof",
      pg_catalog.has_table_privilege(
        role.oid,
        canonical_logs_table.oid,
        'SELECT'
      ) as "canReadCanonicalLogs",
      (
        pg_catalog.has_table_privilege(role.oid, canonical_logs_table.oid, 'INSERT')
        or pg_catalog.has_table_privilege(role.oid, canonical_logs_table.oid, 'UPDATE')
        or pg_catalog.has_table_privilege(role.oid, canonical_logs_table.oid, 'DELETE')
        or pg_catalog.has_any_column_privilege(role.oid, canonical_logs_table.oid, 'INSERT')
        or pg_catalog.has_any_column_privilege(role.oid, canonical_logs_table.oid, 'UPDATE')
      ) as "canMutateCanonicalLogs",
      pg_catalog.has_table_privilege(
        role.oid,
        indexed_blocks_table.oid,
        'SELECT'
      ) as "canReadIndexedBlocks",
      (
        pg_catalog.has_table_privilege(role.oid, indexed_blocks_table.oid, 'INSERT')
        or pg_catalog.has_table_privilege(role.oid, indexed_blocks_table.oid, 'UPDATE')
        or pg_catalog.has_table_privilege(role.oid, indexed_blocks_table.oid, 'DELETE')
        or pg_catalog.has_any_column_privilege(role.oid, indexed_blocks_table.oid, 'INSERT')
        or pg_catalog.has_any_column_privilege(role.oid, indexed_blocks_table.oid, 'UPDATE')
      ) as "canMutateIndexedBlocks",
      pg_catalog.has_table_privilege(role.oid, receipts_table.oid, 'SELECT') as "canReadReceipts",
      (
        pg_catalog.has_table_privilege(role.oid, receipts_table.oid, 'INSERT')
        or pg_catalog.has_table_privilege(role.oid, receipts_table.oid, 'UPDATE')
        or pg_catalog.has_table_privilege(role.oid, receipts_table.oid, 'DELETE')
        or pg_catalog.has_any_column_privilege(role.oid, receipts_table.oid, 'INSERT')
        or pg_catalog.has_any_column_privilege(role.oid, receipts_table.oid, 'UPDATE')
      ) as "canMutateReceipts",
      pg_catalog.has_table_privilege(
        role.oid,
        judge_table.oid,
        'SELECT'
      ) as "canReadJudgeEvidence",
      pg_catalog.has_table_privilege(
        role.oid,
        judge_table.oid,
        'INSERT'
      ) as "canInsertJudgeEvidence",
      pg_catalog.has_table_privilege(
        role.oid,
        judge_table.oid,
        'UPDATE'
      ) as "canUpdateJudgeEvidence",
      pg_catalog.has_table_privilege(
        role.oid,
        judge_table.oid,
        'DELETE'
      ) as "canDeleteJudgeEvidence",
      pg_catalog.has_column_privilege(
        role.oid,
        judge_table.oid,
        'published',
        'UPDATE'
      ) as "canUpdateJudgePublication",
      pg_catalog.has_column_privilege(
        role.oid,
        judge_table.oid,
        'public_proof',
        'UPDATE'
      ) as "canUpdateJudgeProof",
      pg_catalog.has_column_privilege(
        role.oid,
        judge_table.oid,
        'public_proof_digest',
        'UPDATE'
      ) as "canUpdateJudgeProofDigest",
      pg_catalog.has_table_privilege(role.oid, audit_table.oid, 'SELECT')
        as "canReadAuditLogs",
      pg_catalog.has_table_privilege(role.oid, audit_table.oid, 'INSERT')
        as "canInsertAuditLogs",
      (
        pg_catalog.has_table_privilege(role.oid, audit_table.oid, 'UPDATE')
        or pg_catalog.has_table_privilege(role.oid, audit_table.oid, 'DELETE')
        or pg_catalog.has_table_privilege(role.oid, audit_table.oid, 'TRUNCATE')
        or pg_catalog.has_table_privilege(role.oid, audit_table.oid, 'REFERENCES')
        or pg_catalog.has_table_privilege(role.oid, audit_table.oid, 'TRIGGER')
        or pg_catalog.has_any_column_privilege(role.oid, audit_table.oid, 'UPDATE')
        or pg_catalog.has_any_column_privilege(role.oid, audit_table.oid, 'REFERENCES')
      ) as "canMutateAuditLogs",
      pg_catalog.has_table_privilege(
        role.oid,
        acceptance_table.oid,
        'SELECT'
      ) as "canReadAcceptance",
      pg_catalog.has_table_privilege(
        role.oid,
        acceptance_table.oid,
        'INSERT'
      ) as "canInsertAcceptance",
      pg_catalog.has_table_privilege(
        role.oid,
        acceptance_table.oid,
        'UPDATE'
      ) as "canUpdateAcceptance",
      pg_catalog.has_table_privilege(
        role.oid,
        acceptance_table.oid,
        'DELETE'
      ) as "canDeleteAcceptance",
      pg_catalog.has_table_privilege(
        role.oid,
        acceptance_table.oid,
        'TRUNCATE'
      ) as "canTruncateAcceptance",
      pg_catalog.has_table_privilege(
        role.oid,
        acceptance_table.oid,
        'REFERENCES'
      ) as "canReferenceAcceptance",
      pg_catalog.has_table_privilege(
        role.oid,
        acceptance_table.oid,
        'TRIGGER'
      ) as "canTriggerAcceptance",
      pg_catalog.has_any_column_privilege(
        role.oid,
        acceptance_table.oid,
        'INSERT'
      ) as "canInsertAnyAcceptanceColumn",
      pg_catalog.has_any_column_privilege(
        role.oid,
        acceptance_table.oid,
        'UPDATE'
      ) as "canUpdateAnyAcceptanceColumn",
      pg_catalog.has_any_column_privilege(
        role.oid,
        acceptance_table.oid,
        'REFERENCES'
      ) as "canReferenceAnyAcceptanceColumn"
    from pg_catalog.pg_roles role
    inner join pg_catalog.pg_database database
      on database.datname = pg_catalog.current_database()
    inner join pg_catalog.pg_namespace public_namespace
      on public_namespace.nspname = 'public'
    inner join pg_catalog.pg_class orders_table
      on orders_table.relnamespace = public_namespace.oid
      and orders_table.relname = 'orders'
      and orders_table.relkind in ('r', 'p')
    inner join pg_catalog.pg_class judge_table
      on judge_table.relnamespace = public_namespace.oid
      and judge_table.relname = 'judge_evidence'
      and judge_table.relkind in ('r', 'p')
    inner join pg_catalog.pg_class canonical_logs_table
      on canonical_logs_table.relnamespace = public_namespace.oid
      and canonical_logs_table.relname = 'canonical_logs'
      and canonical_logs_table.relkind in ('r', 'p')
    inner join pg_catalog.pg_class indexed_blocks_table
      on indexed_blocks_table.relnamespace = public_namespace.oid
      and indexed_blocks_table.relname = 'indexed_blocks'
      and indexed_blocks_table.relkind in ('r', 'p')
    inner join pg_catalog.pg_class receipts_table
      on receipts_table.relnamespace = public_namespace.oid
      and receipts_table.relname = 'receipts'
      and receipts_table.relkind in ('r', 'p')
    inner join pg_catalog.pg_class acceptance_table
      on acceptance_table.relnamespace = public_namespace.oid
      and acceptance_table.relname = 'live_acceptance_evidence'
      and acceptance_table.relkind in ('r', 'p')
    inner join pg_catalog.pg_class audit_table
      on audit_table.relnamespace = public_namespace.oid
      and audit_table.relname = 'audit_logs'
      and audit_table.relkind in ('r', 'p')
    where role.rolname = current_user
  `);
  const snapshot = rows[0];
  if (snapshot === undefined) {
    throw new AppError(
      'CONFIGURATION_INVALID',
      'The web database credential does not satisfy the OpenTab runtime-role boundary.',
    );
  }
  const safe =
    snapshot.directLogin &&
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
    !snapshot.canCreateDatabaseObjects &&
    !snapshot.canCreatePublicSchemaObjects &&
    !snapshot.canCreateTemporaryTables &&
    snapshot.canReadOrders &&
    snapshot.canInsertOrderId &&
    snapshot.canUpdateOrderStatus &&
    !snapshot.canInsertOrderPaidProof &&
    !snapshot.canUpdateOrderPaidProof &&
    snapshot.canReadCanonicalLogs &&
    !snapshot.canMutateCanonicalLogs &&
    snapshot.canReadIndexedBlocks &&
    !snapshot.canMutateIndexedBlocks &&
    snapshot.canReadReceipts &&
    !snapshot.canMutateReceipts &&
    snapshot.canReadJudgeEvidence &&
    snapshot.canInsertJudgeEvidence &&
    !snapshot.canUpdateJudgeEvidence &&
    !snapshot.canDeleteJudgeEvidence &&
    snapshot.canUpdateJudgePublication &&
    !snapshot.canUpdateJudgeProof &&
    !snapshot.canUpdateJudgeProofDigest &&
    snapshot.canReadAuditLogs &&
    snapshot.canInsertAuditLogs &&
    !snapshot.canMutateAuditLogs &&
    snapshot.canReadAcceptance &&
    !snapshot.canInsertAcceptance &&
    !snapshot.canUpdateAcceptance &&
    !snapshot.canDeleteAcceptance &&
    !snapshot.canTruncateAcceptance &&
    !snapshot.canReferenceAcceptance &&
    !snapshot.canTriggerAcceptance &&
    !snapshot.canInsertAnyAcceptanceColumn &&
    !snapshot.canUpdateAnyAcceptanceColumn &&
    !snapshot.canReferenceAnyAcceptanceColumn;
  if (!safe) {
    throw new AppError(
      'CONFIGURATION_INVALID',
      'The web database credential does not satisfy the OpenTab runtime-role boundary.',
    );
  }
}
