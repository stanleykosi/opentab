import { keccak_256 } from '@noble/hashes/sha3';
import { type EvidenceDigest, EvidenceDigestSchema } from './ids.js';

const MAX_DIGEST_DEPTH = 12;
const MAX_ARRAY_ITEMS = 200;
const MAX_OBJECT_KEYS = 200;
const MAX_STRING_LENGTH = 2_000;

function normalizeForDigest(value: unknown, depth = 0, ancestors = new WeakSet<object>()): unknown {
  if (depth > MAX_DIGEST_DEPTH) throw new RangeError('Evidence digest input is too deeply nested');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new RangeError('Evidence digest numbers must be finite');
    return value;
  }
  if (typeof value === 'bigint') return `${value.toString()}n`;
  if (typeof value === 'string') {
    if (value.length > MAX_STRING_LENGTH) {
      throw new RangeError('Evidence digest string exceeds the reviewed bound');
    }
    return value;
  }
  if (typeof value === 'undefined') return '[undefined]';
  if (typeof value === 'symbol' || typeof value === 'function') {
    throw new TypeError(`Evidence digest does not support ${typeof value} values`);
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new RangeError('Evidence digest date is invalid');
    return value.toISOString();
  }
  if (ancestors.has(value)) throw new TypeError('Evidence digest input must not contain cycles');
  ancestors.add(value);
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_ITEMS) {
      throw new RangeError('Evidence digest array exceeds the reviewed bound');
    }
    const normalized = value.map((entry) => normalizeForDigest(entry, depth + 1, ancestors));
    ancestors.delete(value);
    return normalized;
  }

  const source = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(source).sort();
  if (keys.length > MAX_OBJECT_KEYS) {
    throw new RangeError('Evidence digest object exceeds the reviewed bound');
  }
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    result[key] = normalizeForDigest(source[key], depth + 1, ancestors);
  }
  ancestors.delete(value);
  return result;
}

function hex(bytes: Uint8Array): `0x${string}` {
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Stable, bounded Keccak digest shared by provider adapters and server-side
 * evidence verification. Raw payloads are never returned or logged.
 */
export function digestUnknown(value: unknown): EvidenceDigest {
  const stable = JSON.stringify(normalizeForDigest(value));
  return EvidenceDigestSchema.parse(hex(keccak_256(new TextEncoder().encode(stable))));
}
