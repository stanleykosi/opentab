import { describe, expect, it } from 'vitest';
import { PublicBrowserConfigSchema } from './schemas.js';

describe('public browser configuration schema', () => {
  it('accepts the server challenge projection when live providers are disabled', () => {
    expect(
      PublicBrowserConfigSchema.parse({
        applicationReleaseId: 'a'.repeat(40),
        magic: {
          publishableKey: 'pk_live_opentab',
          rpcUrl: 'https://arb1.arbitrum.io/rpc',
        },
        challenge: {},
        particle: { enabled: false },
        environment: 'production',
        media: { allowedOrigins: ['https://opentab-opal.vercel.app'] },
        features: {
          checkout: false,
          bootstrapGas: false,
          splits: false,
          loyalty: true,
          judgeMode: false,
        },
      }),
    ).toMatchObject({ challenge: {}, particle: { enabled: false } });
  });
});
