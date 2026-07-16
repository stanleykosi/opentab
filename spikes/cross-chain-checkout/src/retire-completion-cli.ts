import { z } from 'zod';
import { LIVE_ACCEPTANCE_RETIRE_CONFIRMATION, retireLiveRunCompletion } from './live-driver.js';

const EnvironmentSchema = z
  .object({
    LIVE_ACCEPTANCE_COMPLETION_PATH: z.string().min(1),
    LIVE_ACCEPTANCE_ATTESTATION_SECRET: z.string().min(32),
    LIVE_ACCEPTANCE_RETIRE_CONFIRMATION: z.literal(LIVE_ACCEPTANCE_RETIRE_CONFIRMATION),
  })
  .passthrough();

try {
  const environment = EnvironmentSchema.parse(process.env);
  const retired = retireLiveRunCompletion({
    path: environment.LIVE_ACCEPTANCE_COMPLETION_PATH,
    receiptSecret: environment.LIVE_ACCEPTANCE_ATTESTATION_SECRET,
    confirmation: environment.LIVE_ACCEPTANCE_RETIRE_CONFIRMATION,
  });
  process.stdout.write(
    `${JSON.stringify({ status: 'retired', scopeDigest: retired.scopeDigest, runId: retired.runId })}\n`,
  );
} catch (error) {
  const message = error instanceof Error ? error.message : 'Completion retirement failed.';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
