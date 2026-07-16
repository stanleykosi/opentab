import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

const root = process.cwd();
const routesRoot = join(root, 'apps', 'web', 'app', 'api', 'v1');
const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

async function routeFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return routeFiles(path);
      return entry.isFile() && entry.name === 'route.ts' ? [path] : [];
    }),
  );
  return nested.flat();
}

function routePath(file) {
  const directory = relative(routesRoot, file.slice(0, -'/route.ts'.length));
  const segments = directory === '' ? [] : directory.split(sep);
  return `/${segments.map((segment) => segment.replace(/^\[([^\]]+)\]$/, '{$1}')).join('/')}`;
}

function routeMethods(source) {
  const found = new Set();
  for (const method of methods) {
    if (
      new RegExp(`\\bas\\s+${method}\\b`).test(source) ||
      new RegExp(`export\\s+(?:async\\s+function|const)\\s+${method}\\b`).test(source)
    ) {
      found.add(method.toLowerCase());
    }
  }
  return found;
}

function openApiOperations(source) {
  const result = new Map();
  let inPaths = false;
  let current;
  for (const line of source.split(/\r?\n/)) {
    if (line === 'paths:') {
      inPaths = true;
      continue;
    }
    if (inPaths && /^[^ ]/.test(line) && line !== '') break;
    const path = /^ {2}(\/[^:]+):$/.exec(line)?.[1];
    if (path !== undefined) {
      current = path;
      result.set(path, new Set());
      continue;
    }
    const method = /^ {4}(get|post|put|patch|delete):$/.exec(line)?.[1];
    if (current !== undefined && method !== undefined) result.get(current)?.add(method);
  }
  return result;
}

const actual = new Map();
for (const file of await routeFiles(routesRoot)) {
  actual.set(routePath(file), routeMethods(await readFile(file, 'utf8')));
}
const documented = openApiOperations(
  await readFile(join(root, 'openapi', 'opentab.openapi.yaml'), 'utf8'),
);
const errors = [];
for (const [path, routeOperationSet] of actual) {
  const documentedSet = documented.get(path);
  if (documentedSet === undefined) {
    errors.push(`Missing OpenAPI path: ${path}`);
    continue;
  }
  for (const method of routeOperationSet) {
    if (!documentedSet.has(method))
      errors.push(`Missing OpenAPI operation: ${method.toUpperCase()} ${path}`);
  }
  for (const method of documentedSet) {
    if (!routeOperationSet.has(method))
      errors.push(`Stale OpenAPI operation: ${method.toUpperCase()} ${path}`);
  }
}
for (const path of documented.keys()) {
  if (!actual.has(path)) errors.push(`Stale OpenAPI path: ${path}`);
}
if (errors.length > 0) {
  process.stderr.write(`${errors.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`OpenAPI parity verified for ${actual.size} route paths.\n`);
}
