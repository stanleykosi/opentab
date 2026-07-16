import type {
  PaymentReconciliationStorePort,
  SponsorGrantReconciliationStorePort,
} from '@opentab/application';
import type { IndexerStore } from './types.js';

interface DatabaseHandleLike {
  readonly db: unknown;
  close(): Promise<void>;
}

interface DatabaseModuleLike {
  createDatabase(input: {
    url: string;
    applicationName: string;
    maxConnections: number;
  }): DatabaseHandleLike;
  assertIndexerDatabasePrivileges(db: unknown): Promise<void>;
  PostgresUnitOfWork: new (root: unknown) => unknown;
  PostgresIndexerStore: new (unitOfWork: unknown) => IndexerStore;
  PostgresPaymentReconciliationStore: new (unitOfWork: unknown) => PaymentReconciliationStorePort;
  PostgresSponsorGrantReconciliationStore: new (
    unitOfWork: unknown,
  ) => SponsorGrantReconciliationStorePort;
}

function databaseModule(value: unknown): DatabaseModuleLike {
  if (typeof value !== 'object' || value === null) {
    throw new Error('The database package did not expose a module object');
  }
  const record = value as Readonly<Record<string, unknown>>;
  if (
    typeof record['createDatabase'] !== 'function' ||
    typeof record['assertIndexerDatabasePrivileges'] !== 'function' ||
    typeof record['PostgresUnitOfWork'] !== 'function' ||
    typeof record['PostgresIndexerStore'] !== 'function' ||
    typeof record['PostgresPaymentReconciliationStore'] !== 'function' ||
    typeof record['PostgresSponsorGrantReconciliationStore'] !== 'function'
  ) {
    throw new Error('The database package is missing the indexer composition exports');
  }
  return record as unknown as DatabaseModuleLike;
}

/**
 * Loaded only after validated live startup. Keeping this behind a narrow
 * runtime boundary prevents Drizzle's optional-dialect declaration defects
 * from leaking into the otherwise strict worker compilation (QW-001 remains
 * scoped to packages/db).
 */
export async function createPostgresIndexerPersistence(databaseUrl: string): Promise<{
  readonly store: IndexerStore;
  readonly reconciliationStore: PaymentReconciliationStorePort;
  readonly sponsorReconciliationStore: SponsorGrantReconciliationStorePort;
  close(): Promise<void>;
}> {
  const runtimeModule = new URL('./db-runtime.js', import.meta.url).href;
  const module = databaseModule(await import(runtimeModule));
  const database = module.createDatabase({
    url: databaseUrl,
    applicationName: 'opentab-indexer',
    maxConnections: 8,
  });
  try {
    // This is intentionally the first database operation after opening the
    // pool. No cursor, workflow, or reconciliation table is touched before the
    // dedicated credential passes the exact pg_catalog audit.
    await module.assertIndexerDatabasePrivileges(database.db);
  } catch (error) {
    await database.close();
    throw error;
  }
  const unitOfWork = new module.PostgresUnitOfWork(database.db);
  const store = new module.PostgresIndexerStore(unitOfWork);
  const reconciliationStore = new module.PostgresPaymentReconciliationStore(unitOfWork);
  const sponsorReconciliationStore = new module.PostgresSponsorGrantReconciliationStore(unitOfWork);
  return { store, reconciliationStore, sponsorReconciliationStore, close: () => database.close() };
}
