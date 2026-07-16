import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const ignored = new Set([
  'node_modules',
  '.git',
  '.next',
  'dist',
  'coverage',
  'lib',
  'out',
  'cache',
  'artifacts',
  'vendor-cache',
]);
const files = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(p);
  }
}
walk(root);
const errors = [];
const regex = /(?<!!)\[[^\]]*\]\(([^)]+)\)/g;
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  for (const match of text.matchAll(regex)) {
    let target = match[1].trim().replace(/^<|>$/g, '');
    if (!target || target.startsWith('#') || /^(https?:|mailto:|tel:|sandbox:)/.test(target))
      continue;
    target = target.split('#')[0].split('?')[0];
    if (!target) continue;
    const resolved = path.resolve(path.dirname(file), decodeURIComponent(target));
    if (!fs.existsSync(resolved)) errors.push(`${path.relative(root, file)} -> ${target}`);
  }
}
if (errors.length) {
  console.error(
    `Broken local Markdown links (${errors.length}):\n${errors.map((x) => `- ${x}`).join('\n')}`,
  );
  process.exit(1);
}
console.log(`Checked local Markdown links in ${files.length} files.`);
