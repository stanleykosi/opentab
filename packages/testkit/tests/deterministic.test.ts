import { describe, expect, it } from 'vitest';
import {
  DETERMINISTIC_DEMO_SCENARIO,
  DETERMINISTIC_PROVENANCE_LABEL,
  DeterministicRandom,
  InMemoryDistributedLock,
} from '../src/index.js';

describe('deterministic testkit', () => {
  it('labels demo data so it cannot be mistaken for live evidence', () => {
    expect(DETERMINISTIC_DEMO_SCENARIO.provenanceLabel).toBe(DETERMINISTIC_PROVENANCE_LABEL);
  });

  it('produces stable distinct identifiers', () => {
    const random = new DeterministicRandom();
    expect(random.opaqueId('ord')).not.toBe(random.opaqueId('ord'));
    expect(random.bytes32()).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('serializes concurrent work for the same key', async () => {
    const locks = new InMemoryDistributedLock();
    await locks.withLock('same', 1000, async (signal) => {
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal.aborted).toBe(false);
      await expect(locks.withLock('same', 1000, async () => 'unexpected')).rejects.toThrow(
        'LOCK_BUSY',
      );
    });
  });
});
