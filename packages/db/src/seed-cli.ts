import { z } from 'zod';
import { createDatabase } from './client.js';
import { seedDeterministicDemo } from './seed.js';

const SeedEnvironmentSchema = z
  .object({
    APP_ENV: z.enum(['local', 'test']),
    PROVIDER_MODE: z.literal('deterministic'),
    DETERMINISTIC_DEMO_ENABLED: z.literal('true'),
    DEMO_SEED_CONFIRMATION: z.literal('seed-opentab-deterministic-demo'),
    DATABASE_URL: z
      .string()
      .url()
      .refine((value) => {
        const url = new URL(value);
        return ['postgres:', 'postgresql:'].includes(url.protocol);
      }),
    DEMO_SEED_SECRET_PEPPER: z.string().min(32).max(512),
  })
  .strict();

async function main(): Promise<void> {
  const environment = SeedEnvironmentSchema.parse({
    APP_ENV: process.env['APP_ENV'],
    PROVIDER_MODE: process.env['PROVIDER_MODE'],
    DETERMINISTIC_DEMO_ENABLED: process.env['DETERMINISTIC_DEMO_ENABLED'],
    DEMO_SEED_CONFIRMATION: process.env['DEMO_SEED_CONFIRMATION'],
    DATABASE_URL: process.env['DATABASE_URL'],
    DEMO_SEED_SECRET_PEPPER: process.env['DEMO_SEED_SECRET_PEPPER'],
  });
  const database = createDatabase({
    url: environment.DATABASE_URL,
    applicationName: 'opentab-demo-seed',
    maxConnections: 1,
  });
  try {
    const ids = await seedDeterministicDemo({
      db: database.db,
      environment: environment.APP_ENV,
      deterministicDemoEnabled: true,
      secretPepper: environment.DEMO_SEED_SECRET_PEPPER,
    });
    process.stdout.write(
      `${JSON.stringify({ seeded: true, environment: environment.APP_ENV, ids })}\n`,
    );
  } finally {
    await database.close();
  }
}

await main();
