import { describe, expect, it } from 'vitest';
import { assessLiveAcceptanceGate } from '../src/index.js';
import { createLiveAcceptanceDependencies, runManagedLiveAcceptance } from '../src/live-driver.js';

function externalBlocker(message: string): Error {
  return new Error(`EXTERNAL_BLOCKER: ${message}`);
}

describe('credentialed Particle + Magic + Arbitrum acceptance', () => {
  it(
    'produces canonical sanitized evidence or exits nonzero as EXTERNAL_BLOCKER',
    async () => {
      const environment = {
        ...((globalThis as { process?: { env?: Record<string, string | undefined> } }).process
          ?.env ?? {}),
      };
      const gate = assessLiveAcceptanceGate(environment);
      if (gate.status === 'EXTERNAL_BLOCKER') {
        throw externalBlocker(`${gate.reason} Missing: ${gate.missing.join(', ')}`);
      }

      let dependencies: Awaited<ReturnType<typeof createLiveAcceptanceDependencies>> | undefined;
      try {
        dependencies = await createLiveAcceptanceDependencies(environment);
        const result = await runManagedLiveAcceptance(environment, dependencies);
        if (result.status !== 'LIVE_ACCEPTANCE_EVIDENCED') {
          throw externalBlocker(
            result.status === 'EXTERNAL_BLOCKER'
              ? result.reason
              : 'The harness did not produce canonical live evidence.',
          );
        }
        expect(result.status).toBe('LIVE_ACCEPTANCE_EVIDENCED');
        expect(result.arbitrum.event.canonical).toBe(true);
        expect(result.recovery.submissionCount).toBe(1);
        expect(result.recovery.receiptCount).toBe(1);
      } finally {
        await dependencies?.close();
      }
    },
    15 * 60_000,
  );
});
