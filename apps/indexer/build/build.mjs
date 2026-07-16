import { rm } from 'node:fs/promises';
import { build } from 'esbuild';

const nodeEsmRequireBanner = [
  "import { createRequire as __opentabCreateRequire } from 'node:module';",
  'const require = __opentabCreateRequire(import.meta.url);',
].join('\n');

const common = {
  bundle: true,
  format: 'esm',
  logLevel: 'info',
  platform: 'node',
  sourcemap: true,
  target: 'node25',
};

await rm(new URL('../dist', import.meta.url), { recursive: true, force: true });

const indexerBuild = await build({
  ...common,
  entryPoints: [new URL('../src/index.ts', import.meta.url).pathname],
  outfile: new URL('../dist/index.js', import.meta.url).pathname,
  external: ['pino', 'viem', 'zod'],
  metafile: true,
  // Particle's reviewed SDK graph currently includes CommonJS form-data.
  // Supplying Node's native require bridge keeps built-ins native while the
  // application itself remains an ESM bundle.
  banner: { js: nodeEsmRequireBanner },
});

const forbiddenWorkerModules = [
  '/integrations/src/aws-kms.ts',
  '/integrations/src/magic-admin.ts',
  '/integrations/src/magic-client.ts',
  '/integrations/src/server.ts',
  '/integrations/src/sponsor.ts',
  '/integrations/src/turnstile.ts',
];
const bundledForbiddenModules = Object.keys(indexerBuild.metafile.inputs).filter((path) =>
  forbiddenWorkerModules.some((modulePath) => path.endsWith(modulePath)),
);
if (bundledForbiddenModules.length > 0) {
  throw new Error(
    `Indexer bundle crossed its least-privilege integration boundary: ${bundledForbiddenModules.join(', ')}`,
  );
}

await build({
  ...common,
  entryPoints: [new URL('./db-runtime-entry.mjs', import.meta.url).pathname],
  outfile: new URL('../dist/db-runtime.js', import.meta.url).pathname,
});
