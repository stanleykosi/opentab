import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const browserModules = [
  './browser-operations.js',
  './evidence.js',
  './magic-client.js',
  './particle.js',
] as const;

const serverModules = [
  './arbitrum.js',
  './aws-kms.js',
  './deterministic.js',
  './eip712-signers.js',
  './evidence.js',
  './magic-admin.js',
  './managed-contract.js',
  './operation-templates.js',
  './particle.js',
  './sponsor.js',
  './turnstile.js',
  './vendor-errors.js',
] as const;

async function source(relativePath: string): Promise<string> {
  return readFile(new URL(relativePath, import.meta.url), 'utf8');
}

function wildcardExports(entrypoint: string): string[] {
  return [...entrypoint.matchAll(/^export \* from '([^']+)';$/gm)].map((match) => match[1] ?? '');
}

function declaresExport(moduleSource: string, symbol: string): boolean {
  const declaration = new RegExp(
    `\\bexport\\s+(?:declare\\s+)?(?:class|function|const|let|var|type|interface)\\s+${symbol}\\b`,
  );
  const namedExport = new RegExp(`\\bexport\\s*\\{[^}]*\\b${symbol}\\b[^}]*\\}`, 's');
  return declaration.test(moduleSource) || namedExport.test(moduleSource);
}

describe('integration entrypoint boundaries', () => {
  it('keeps server adapters unreachable from the browser entrypoint', async () => {
    const browser = await source('../src/browser.ts');
    expect(wildcardExports(browser)).toEqual(browserModules);
    expect(browser).toContain(
      "export { mapMagicError, mapParticleError } from './vendor-errors.js';",
    );

    const browserModuleSources = await Promise.all(
      browserModules.map((modulePath) => source(`../src/${modulePath.slice(2, -3)}.ts`)),
    );
    for (const serverOnly of [
      'MagicAdminIdentityVerifier',
      'PolicyBoundSponsorTransferAdapter',
      'ViemArbitrumReadAdapter',
      'ViemOrderIntentSigner',
      'createPrivateKeyIntentSigners',
      'createDeterministicIntentSigners',
      'AwsKmsSecp256k1Signer',
      'createAwsKmsSponsorTransferAdapter',
      'createAwsKmsSplitRevocationSender',
    ]) {
      expect(
        browserModuleSources.some((moduleSource) => declaresExport(moduleSource, serverOnly)),
      ).toBe(false);
    }
  });

  it('exposes trusted adapters from the explicit server entrypoint', async () => {
    const server = await source('../src/server.ts');
    expect(wildcardExports(server)).toEqual(serverModules);
  });
});
