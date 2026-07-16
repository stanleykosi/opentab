import { AsyncLocalStorage } from 'node:async_hooks';
import type { UnitOfWorkPort } from '@opentab/application';
import type { OpenTabDatabase } from './client.js';

export class PostgresUnitOfWork implements UnitOfWorkPort {
  readonly #storage = new AsyncLocalStorage<OpenTabDatabase>();

  constructor(readonly root: OpenTabDatabase) {}

  current(): OpenTabDatabase {
    return this.#storage.getStore() ?? this.root;
  }

  async transaction<T>(operation: () => Promise<T>): Promise<T> {
    const active = this.#storage.getStore();
    if (active !== undefined) return operation();

    return this.root.transaction(async (transaction) =>
      this.#storage.run(transaction as unknown as OpenTabDatabase, operation),
    );
  }

  /**
   * Runs a top-level serializable transaction and retries only database
   * serialization/deadlock aborts. This is intentionally separate from the
   * general application transaction contract so security-sensitive readers
   * do not need SELECT FOR UPDATE privileges to obtain a stable validation
   * snapshot before an append-only insert.
   */
  async serializableTransaction<T>(operation: () => Promise<T>, maxAttempts = 3): Promise<T> {
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) {
      throw new RangeError('Serializable transaction retry count is invalid');
    }
    if (this.#storage.getStore() !== undefined) {
      throw new Error('A serializable transaction must be the top-level database operation');
    }
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.root.transaction(
          async (transaction) =>
            this.#storage.run(transaction as unknown as OpenTabDatabase, operation),
          { isolationLevel: 'serializable', accessMode: 'read write' },
        );
      } catch (error) {
        if (!isRetryableTransactionAbort(error) || attempt === maxAttempts) throw error;
        await new Promise((resolve) => setTimeout(resolve, attempt * 20));
      }
    }
    throw new Error('Serializable transaction retry loop exhausted unexpectedly');
  }
}

function isRetryableTransactionAbort(value: unknown): boolean {
  let candidate: unknown = value;
  for (
    let depth = 0;
    depth < 6 && candidate !== null && typeof candidate === 'object';
    depth += 1
  ) {
    const record = candidate as { readonly code?: unknown; readonly cause?: unknown };
    if (record.code === '40001' || record.code === '40P01') return true;
    candidate = record.cause;
  }
  return false;
}
