import { sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { assertRuntimeDatabasePrivileges } from './runtime-privileges.js';
import * as schema from './schema/index.js';

export type OpenTabDatabase = PostgresJsDatabase<typeof schema>;

export interface DatabaseHandle {
  readonly db: OpenTabDatabase;
  close(): Promise<void>;
}

export function createDatabase(input: {
  url: string;
  maxConnections?: number;
  applicationName?: string;
  idleTimeoutSeconds?: number;
}): DatabaseHandle {
  if (input.url.trim().length === 0) throw new Error('Database URL is required');

  const client = postgres(input.url, {
    max: input.maxConnections ?? 10,
    idle_timeout: input.idleTimeoutSeconds ?? 20,
    connect_timeout: 10,
    prepare: false,
    connection: {
      application_name: input.applicationName ?? 'opentab',
      timezone: 'UTC',
    },
    transform: { undefined: null },
  });
  const db = drizzle(client, { schema, casing: 'snake_case' });

  return {
    db,
    async close() {
      await client.end({ timeout: 5 });
    },
  };
}

export async function checkDatabaseHealth(
  db: OpenTabDatabase,
  options: { readonly requireLeastPrivilegeRuntime?: boolean } = {},
): Promise<void> {
  await db.execute(sql`select 1`);
  if (options.requireLeastPrivilegeRuntime === true) {
    await assertRuntimeDatabasePrivileges(db);
  }
}
