import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const sourceRoots = ['apps', 'packages'].map((directory) => path.join(root, directory));
const ignoredDirectories = new Set([
  '.next',
  'artifacts',
  'cache',
  'coverage',
  'dist',
  'fixtures',
  'lib',
  'node_modules',
  'out',
  'test',
  'tests',
  '__tests__',
]);
const sourceExtensions = new Set(['.cjs', '.js', '.jsx', '.mjs', '.sol', '.ts', '.tsx']);
const forbidden = [
  { label: 'unresolved TODO', expression: /\bTODO\b/ },
  { label: 'unresolved FIXME', expression: /\bFIXME\b/ },
  {
    label: 'explicit unimplemented throw',
    expression: /throw\s+new\s+Error\s*\(\s*['"`](?:not implemented|unimplemented)/i,
  },
  {
    label: 'placeholder success response',
    expression: /(?:fake|placeholder)\s+success/i,
  },
];

const findings = [];

function inspectFile(file) {
  const relative = path.relative(root, file).replaceAll(path.sep, '/');
  if (/\.(?:test|spec)\.[^.]+$/.test(relative)) return;
  const contents = fs.readFileSync(file, 'utf8');
  for (const [index, line] of contents.split(/\r?\n/u).entries()) {
    for (const rule of forbidden) {
      if (rule.expression.test(line)) findings.push(`${relative}:${index + 1}: ${rule.label}`);
    }
  }
}

function walk(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(target);
    else if (entry.isFile() && sourceExtensions.has(path.extname(entry.name))) inspectFile(target);
  }
}

for (const sourceRoot of sourceRoots) walk(sourceRoot);

if (findings.length > 0) {
  console.error(
    `Production placeholder check failed:\n${findings.map((item) => `- ${item}`).join('\n')}`,
  );
  process.exit(1);
}

console.log('Production source contains no unresolved placeholder markers.');
