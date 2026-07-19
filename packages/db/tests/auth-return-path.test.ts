import { describe, expect, it } from 'vitest';
import { normalizeAuthReturnPath } from '../src/redis.js';

describe('authentication return-path policy', () => {
  it('accepts the exact Particle operator route', () => {
    expect(normalizeAuthReturnPath('/operator/particle')).toBe('/operator/particle');
  });

  it('keeps every other operator route outside the continuation allowlist', () => {
    for (const path of ['/operator', '/operator/other', '/operator/particle/extra']) {
      expect(() => normalizeAuthReturnPath(path)).toThrow(
        expect.objectContaining({ code: 'VALIDATION_FAILED' }),
      );
    }
  });

  it('continues to reject external and protocol-relative destinations', () => {
    for (const path of [
      'https://evil.example/operator/particle',
      '//evil.example/operator/particle',
    ]) {
      expect(() => normalizeAuthReturnPath(path)).toThrow(
        expect.objectContaining({ code: 'VALIDATION_FAILED' }),
      );
    }
  });
});
