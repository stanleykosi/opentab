import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const ignored = new Set([
  '.deploy-smoke',
  '.git',
  '.next',
  '.turbo',
  'cache',
  'coverage',
  'dist',
  'lib',
  'node_modules',
  'out',
  'playwright-report',
  'test-results',
  'vendor-cache',
]);
const allowed = new Set(['.env.example', 'scripts/verify-no-obvious-secrets.mjs']);
const textExtensions = new Set([
  '',
  '.css',
  '.env',
  '.html',
  '.js',
  '.json',
  '.jsonl',
  '.jsx',
  '.md',
  '.mjs',
  '.sh',
  '.sol',
  '.sql',
  '.svg',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.yaml',
  '.yml',
]);
const patterns = [
  {
    name: 'private key-like source assignment',
    re: /(?:private[_-]?key|secret[_-]?key)\s*[:=]\s*['"]?0x[a-fA-F0-9]{64}\b/i,
  },
  { name: 'Magic secret-like value', re: /\bsk_(?:live|test)_[A-Za-z0-9_-]{16,}\b/ },
  {
    name: 'generic private key environment assignment',
    re: /(?:PRIVATE_KEY|SECRET_KEY)\s*=\s*(?!REPLACE|$)[^\s#]{16,}/i,
  },
  { name: 'GitHub token-like value', re: /\b(?:ghp|github_pat)_[A-Za-z0-9_]{30,}\b/ },
  { name: 'AWS access key-like value', re: /\bAKIA[0-9A-Z]{16}\b/ },
  {
    name: 'bearer token-like value',
    re: /\bBearer\s+[A-Za-z0-9._~-]{32,}\b/i,
  },
  {
    name: 'JWT-like value',
    re: /\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/,
  },
];
const findings = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (entry.isFile()) {
      const relativePath = path.relative(root, p);
      const basename = path.basename(relativePath);
      if (basename.startsWith('.env') && basename !== '.env.example') continue;
      if (allowed.has(relativePath)) continue;
      if (['.key', '.pem', '.p12', '.pfx'].includes(path.extname(entry.name).toLowerCase())) {
        findings.push(`${relativePath}: private key or certificate container file`);
        continue;
      }
      const maximumBytes = relativePath.startsWith(
        `artifacts${path.sep}autonomous-build${path.sep}`,
      )
        ? 10_000_000
        : 2_000_000;
      if (
        fs.statSync(p).size >= maximumBytes ||
        !textExtensions.has(path.extname(entry.name).toLowerCase())
      ) {
        continue;
      }
      let text;
      try {
        text = fs.readFileSync(p, 'utf8');
      } catch {
        continue;
      }
      for (const pattern of patterns) {
        if (pattern.re.test(text)) findings.push(`${relativePath}: ${pattern.name}`);
      }
    }
  }
}
walk(root);
if (findings.length) {
  console.error(
    `Potential secrets require manual review:\n${[...new Set(findings)].map((item) => `- ${item}`).join('\n')}`,
  );
  process.exit(1);
}
console.log('No obvious committed secret pattern found. Run platform secret scanning as well.');
