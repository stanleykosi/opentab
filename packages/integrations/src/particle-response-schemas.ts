import { z } from 'zod';

const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Particle's EIP-7702 authorization endpoint returns chain IDs as JSON
 * numbers or JSON-RPC-style strings and may deliberately return zero for a
 * chain-agnostic authorization. Normalize those bounded encodings here. The
 * caller must replace zero with—and independently enforce—the exact chain it
 * requested before any wallet signature or transaction submission.
 */
export const ParticleAuthorizationChainIdSchema = z
  .union([
    z.number().int().nonnegative().safe(),
    z.string().regex(/^(?:0|[1-9][0-9]*|0[xX][0-9a-fA-F]+)$/),
  ])
  .transform((value, context): number => {
    if (typeof value === 'number') return value;

    const normalized = value.startsWith('0X') ? `0x${value.slice(2)}` : value;
    const parsed = BigInt(normalized);
    if (parsed < 0n || parsed > MAX_SAFE_INTEGER_BIGINT) {
      context.addIssue({
        code: 'custom',
        message: 'Authorization chain ID must be a non-negative safe integer.',
      });
      return z.NEVER;
    }
    return Number(parsed);
  });
