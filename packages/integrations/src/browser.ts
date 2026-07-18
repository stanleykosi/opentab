/**
 * Browser-only integration surface. Keep Admin SDKs, private signers, sponsor
 * transports, and server RPC adapters unreachable from this entrypoint.
 */

export * from './browser-operations.js';
export * from './evidence.js';
export * from './magic-client.js';
export * from './particle.js';
export * from './particle-certification.js';
export { mapMagicError, mapParticleError } from './vendor-errors.js';
