import { describe, expect, it } from 'vitest';
import { digestUnknown } from '../src/evidence-digest.js';

describe('stable evidence digest', () => {
  it('preserves the reviewed Keccak digest and ignores object key insertion order', () => {
    const expected = '0xb8ffb64722137f4b100665a52e3c943f8066e8ab8ba3b427e6f4b404defd82b0';
    expect(digestUnknown({ b: 2, a: 1 })).toBe(expected);
    expect(digestUnknown({ a: 1, b: 2 })).toBe(expected);
  });

  it('fails closed instead of hashing a truncated or cyclic payload', () => {
    expect(() => digestUnknown('x'.repeat(2_001))).toThrow(/reviewed bound/);
    expect(() => digestUnknown(Array.from({ length: 201 }, (_, index) => index))).toThrow(
      /reviewed bound/,
    );
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => digestUnknown(cyclic)).toThrow(/cycles/);
  });
});
