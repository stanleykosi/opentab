import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // PostgreSQL DDL migrations are intentionally serialized. Test cases still
    // exercise application-level concurrency within each integration suite.
    fileParallelism: false,
  },
});
