import { z } from 'zod';

const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Particle's EIP-7702 authorization endpoint has returned chain IDs as both
 * JSON numbers and JSON-RPC-style strings. Normalize those bounded encodings
 * at the vendor boundary; downstream code still compares the resulting value
 * to the exact requested chain before any signature or submission.
 */
export const ParticleResponseChainIdSchema = z
  .union([
    z.number().int().positive().safe(),
    z.string().regex(/^(?:[1-9][0-9]*|0[xX][0-9a-fA-F]+)$/),
  ])
  .transform((value, context): number => {
    if (typeof value === 'number') return value;

    const normalized = value.startsWith('0X') ? `0x${value.slice(2)}` : value;
    const parsed = BigInt(normalized);
    if (parsed <= 0n || parsed > MAX_SAFE_INTEGER_BIGINT) {
      context.addIssue({
        code: 'custom',
        message: 'Chain ID must be a positive safe integer.',
      });
      return z.NEVER;
    }
    return Number(parsed);
  });
