import { describe, expect, it } from 'vitest';
import { hashOpaqueSecret, safeHashEquals } from '../src/crypto.js';

describe('opaque secret hashing', () => {
  const pepper = 'p'.repeat(32);

  it('uses deterministic domain-separated keyed digests', () => {
    const session = hashOpaqueSecret({ domain: 'session-token', pepper, value: 'opaque-value' });
    const csrf = hashOpaqueSecret({ domain: 'csrf-token', pepper, value: 'opaque-value' });

    expect(session).toMatch(/^[a-f0-9]{64}$/);
    expect(session).not.toBe(csrf);
    expect(session).not.toContain('opaque-value');
    expect(safeHashEquals(session, session)).toBe(true);
    expect(safeHashEquals(session, csrf)).toBe(false);
  });

  it('rejects weak peppers and ambiguous domains', () => {
    expect(() =>
      hashOpaqueSecret({ domain: 'session-token', pepper: 'too-short', value: 'opaque-value' }),
    ).toThrow(/pepper/);
    expect(() =>
      hashOpaqueSecret({ domain: 'session/token', pepper, value: 'opaque-value' }),
    ).toThrow(/domain/);
  });
});
