import { describe, expect, it } from 'vitest';
import { mapParticleError } from '../src/vendor-errors.js';

describe('Particle error normalization', () => {
  it('classifies an insufficient-balance cause nested under a generic RPC error', () => {
    const mapped = mapParticleError(
      Object.assign(new Error('Server error'), {
        code: -32603,
        data: { code: 40104, message: 'Insufficient funds' },
      }),
      'UA_PROVIDER_SCHEMA_INVALID',
    );

    expect(mapped).toMatchObject({
      code: 'UA_INSUFFICIENT_BALANCE',
      message: 'The unified balance does not cover the payment and route fees.',
      retryable: false,
      submissionPossible: false,
      safeDetails: expect.objectContaining({
        vendor: 'particle',
        vendorCode: '-32603',
        vendorCauseCode: '40104',
        vendorReason: 'insufficient_funds',
      }),
    });
  });

  it('classifies invalid parameters without returning the raw provider payload', () => {
    const secretMarker = 'sensitive-provider-payload';
    const mapped = mapParticleError(
      Object.assign(new Error(`Invalid parameters ${secretMarker}`), {
        code: -32602,
        data: { request: secretMarker },
      }),
      'UA_PROVIDER_SCHEMA_INVALID',
    );

    expect(mapped).toMatchObject({
      code: 'UA_PROVIDER_SCHEMA_INVALID',
      message: 'Particle rejected the prepared operation parameters.',
      retryable: false,
      safeDetails: expect.objectContaining({
        vendorCode: '-32602',
        vendorReason: 'invalid_parameters',
      }),
    });
    expect(JSON.stringify(mapped.safeDetails)).not.toContain(secretMarker);
    expect(mapped.message).not.toContain(secretMarker);
  });

  it('finds a bounded cause inside an Axios-shaped response', () => {
    const mapped = mapParticleError(
      Object.assign(new Error('Request failed'), {
        code: 'ERR_BAD_RESPONSE',
        response: {
          data: {
            error: { code: -32005, message: 'Estimate gas failed' },
          },
        },
      }),
      'UA_PROVIDER_SCHEMA_INVALID',
    );

    expect(mapped).toMatchObject({
      code: 'UA_ROUTE_UNAVAILABLE',
      message: 'Particle could not simulate a valid route for this operation.',
      retryable: false,
      safeDetails: expect.objectContaining({
        vendorCode: 'ERR_BAD_RESPONSE',
        vendorCauseCode: '-32005',
        vendorReason: 'simulation_failed',
      }),
    });
  });
});
