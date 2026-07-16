import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}', 'app/api/_lib/**/*.test.ts'],
    // Each UI worker owns a full jsdom realm. Capping concurrency prevents
    // scheduler starvation on the supported four-core CI/device baseline.
    maxWorkers: 2,
  },
});
