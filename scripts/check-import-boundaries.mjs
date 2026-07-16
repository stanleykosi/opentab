import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const sourceExtensions = new Set(['.js', '.jsx', '.mjs', '.ts', '.tsx']);
const vendorPattern = /^(?:magic-sdk|@magic-|@particle-network\/)/;
const findings = [];

function importsOf(file) {
  const source = fs.readFileSync(file, 'utf8');
  return [...source.matchAll(/(?:from\s+|import\s*\()\s*['"]([^'"]+)['"]/g)].map(
    (match) => match[1],
  );
}

function checkTree(relativeRoot, validate) {
  const absoluteRoot = path.join(root, relativeRoot);
  if (!fs.existsSync(absoluteRoot)) return;
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (['dist', 'node_modules', '.next', 'coverage'].includes(entry.name)) continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(target);
      else if (entry.isFile() && sourceExtensions.has(path.extname(entry.name))) {
        for (const imported of importsOf(target)) {
          const reason = validate(imported, path.relative(root, target).replaceAll(path.sep, '/'));
          if (reason)
            findings.push(`${path.relative(root, target)} imports ${imported}: ${reason}`);
        }
      }
    }
  };
  walk(absoluteRoot);
}

checkTree('packages/shared/src', (imported) => {
  if (imported.startsWith('@opentab/')) return 'shared must not depend on another OpenTab package';
  if (vendorPattern.test(imported)) return 'shared must not depend on a wallet/provider SDK';
});

checkTree('packages/application/src', (imported) => {
  if (imported.startsWith('@opentab/') && imported !== '@opentab/shared') {
    return 'application may depend only on shared';
  }
  if (vendorPattern.test(imported)) return 'application must remain vendor independent';
  if (/^(?:next|react|drizzle-orm|ioredis|bullmq|viem|ethers)(?:\/|$)/.test(imported)) {
    return 'application must remain framework and infrastructure independent';
  }
});

checkTree('packages/ui/src', (imported) => {
  if (imported.startsWith('@opentab/') && !['@opentab/shared'].includes(imported)) {
    return 'UI may depend only on shared domain primitives';
  }
  if (
    vendorPattern.test(imported) ||
    /^(?:next|drizzle-orm|ioredis|bullmq)(?:\/|$)/.test(imported)
  ) {
    return 'UI must not depend on vendors, routes, or persistence';
  }
});

for (const tree of ['apps/web/app', 'apps/web/src']) {
  checkTree(tree, (imported) => {
    if (vendorPattern.test(imported)) {
      return 'web must use packages/integrations rather than importing provider SDKs';
    }
  });
}

for (const tree of ['apps/indexer/src', 'packages/db/src', 'packages/config/src']) {
  checkTree(tree, (imported) => {
    if (vendorPattern.test(imported)) return 'vendor SDKs belong only in packages/integrations';
  });
}

if (findings.length > 0) {
  console.error(`Import boundary check failed:\n${findings.map((item) => `- ${item}`).join('\n')}`);
  process.exit(1);
}

console.log('OpenTab package and provider import boundaries are intact.');
