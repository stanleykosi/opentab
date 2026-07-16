import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function hashOpaqueSecret(input: { domain: string; pepper: string; value: string }): string {
  if (input.pepper.length < 16)
    throw new Error('Secret hash pepper must be at least 16 characters');
  if (!/^[a-z][a-z0-9-]{1,63}$/.test(input.domain)) {
    throw new Error('Secret hash domain must be a bounded identifier');
  }
  return createHmac('sha256', input.pepper)
    .update(`opentab:${input.domain}:v1\0`, 'utf8')
    .update(input.value, 'utf8')
    .digest('hex');
}

export function hashSplitInvitationCapability(input: {
  invitationId: string;
  pepper: string;
  capabilityToken: string;
}): string {
  return hashOpaqueSecret({
    domain: 'split-invitation-capability',
    pepper: input.pepper,
    value: `${input.invitationId}\0${input.capabilityToken}`,
  });
}

export function safeHashEquals(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  if (leftBytes.length !== rightBytes.length) return false;
  return timingSafeEqual(leftBytes, rightBytes);
}

export function randomSecret(bytes = 32): string {
  if (!Number.isSafeInteger(bytes) || bytes < 16 || bytes > 128) {
    throw new RangeError('Secret size must be an integer between 16 and 128 bytes');
  }
  return randomBytes(bytes).toString('base64url');
}

function encodeCrockford(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let encoded = '';
  for (let position = 0; position < 26; position += 1) {
    encoded = `${CROCKFORD[Number(value & 31n)]}${encoded}`;
    value >>= 5n;
  }
  return encoded;
}

export function opaqueId(prefix: string): string {
  if (!/^[a-z]{3}$/.test(prefix))
    throw new Error('Opaque ID prefix must be three lowercase letters');
  return `${prefix}_${encodeCrockford(randomBytes(16))}`;
}
