import { Writable } from 'node:stream';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { REDACTED, sanitizeError, sanitizeTelemetry } from '../src/index.js';

describe('telemetry redaction', () => {
  it('redacts sensitive keys recursively', () => {
    expect(
      sanitizeTelemetry({
        requestId: 'req_safe',
        nested: { didToken: 'secret-proof', signature: '0xsig', email: 'a@example.invalid' },
      }),
    ).toEqual({
      requestId: 'req_safe',
      nested: { didToken: REDACTED, signature: REDACTED, email: REDACTED },
    });
  });

  it('removes credentials and sensitive query values from URLs', () => {
    expect(sanitizeTelemetry('https://user:pass@rpc.example/path?apiKey=secret')).toBe(
      'https://rpc.example',
    );
  });

  it('removes provider path credentials from messages and every stack line', () => {
    const canary = 'SENSITIVE_CANARY_123';
    const error = new Error(
      `RPC failed at https://arb-mainnet.g.alchemy.com/v2/${canary}?apiKey=${canary}`,
    );
    error.stack = `${error.name}: ${error.message}\n    at https://rpc.example/v3/${canary}:1:2`;

    const serialized = JSON.stringify(sanitizeError(error, true));
    expect(serialized).not.toContain(canary);
    expect(serialized).not.toContain('/v2/');
    expect(serialized).not.toContain('/v3/');
    expect(serialized).toContain('https://arb-mainnet.g.alchemy.com');
  });

  it('omits stack traces outside local diagnostics', () => {
    expect(sanitizeError(new Error('safe failure'), false)).not.toHaveProperty('stack');
  });

  it('redacts embedded private keys, root hashes, signatures, JWTs, and bearer credentials', () => {
    const privateKey = `0x${'a'.repeat(64)}`;
    const signature = `0x${'b'.repeat(130)}`;
    const jwt = `eyJ${'c'.repeat(12)}.${'d'.repeat(12)}.${'e'.repeat(12)}`;
    const bearer = `Bearer token_${'f'.repeat(40)}`;
    const error = new Error(
      `provider echoed ${privateKey} then ${signature}; ${jwt}; ${bearer} trailing`,
    );
    error.stack = `Error: ${error.message}\n    at signer (${privateKey}:1:2)`;

    const serialized = JSON.stringify(sanitizeError(error, true));
    for (const canary of [privateKey, signature, jwt, bearer]) {
      expect(serialized).not.toContain(canary);
    }
    expect(serialized.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it('keeps embedded secret canaries out of direct Pino error serialization', async () => {
    let output = '';
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });
    const privateKey = `0x${'1'.repeat(64)}`;
    const signature = `0x${'2'.repeat(130)}`;
    const logger = pino({ serializers: { err: (error) => sanitizeError(error, true) } }, sink);
    logger.error({ err: new Error(`prefix ${privateKey} ${signature} suffix`) }, 'failed safely');
    await new Promise<void>((resolve) => sink.end(resolve));

    expect(output).not.toContain(privateKey);
    expect(output).not.toContain(signature);
    expect(output).toContain(REDACTED);
  });

  it('serializes bigint as a decimal string', () => {
    expect(sanitizeTelemetry({ amount: 12345678901234567890n })).toEqual({
      amount: '12345678901234567890',
    });
  });
});
