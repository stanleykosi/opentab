import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'FILE_INDEX.md');
const ignored = new Set([
  '.deploy-smoke',
  '.git',
  '.next',
  '.pnpm-store',
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

const rootPurposes = {
  'AGENTS.md':
    'Repository-wide Codex instructions, non-negotiable architecture rules, validation requirements, and instruction hierarchy.',
  'ARCHITECTURE.md':
    'Canonical system architecture, component boundaries, trust model, and end-to-end technical shape.',
  'BOOTSTRAP_REPOSITORY.md':
    'Implemented-repository setup for frozen install, contracts, environment, services, migrations, seed, and validation.',
  'CHANGELOG.md': 'Specification-pack and implementation change record.',
  'CODEX_START_PROMPT.md':
    'Historical ready-to-paste entry request for the autonomous implementation workflow.',
  'CONTRIBUTING.md':
    'Branch, commit, review, test, documentation, and evidence contribution rules.',
  'DECISIONS.md': 'Fast index of accepted architectural decisions and their ADRs.',
  'DEFINITION_OF_DONE.md':
    'Project, phase, feature, security, release, and submission completion gates.',
  'FILE_INDEX.md': 'Generated exhaustive file inventory with a purpose for every tracked artifact.',
  'IMPLEMENTATION_PLAN.md':
    'Start-to-finish phased delivery plan, sequencing, dependencies, gates, and evidence.',
  'LICENSE_NOTES.md':
    'Licensing and attribution rules for project code, dependencies, examples, and assets.',
  'MANIFEST.json': 'Generated machine-readable file inventory with byte sizes and SHA-256 hashes.',
  'PRODUCT_REQUIREMENTS.md':
    'Product goals, users, scope, behavior, requirements, success measures, and acceptance criteria.',
  'PRODUCTION_READINESS_CHECKLIST.md':
    'Pre-production operational, security, data, deployment, and rollback checklist.',
  'PROJECT_REQUEST.md':
    'Authoritative build request and project charter for Codex and human contributors.',
  'README.md':
    'Public product, architecture, local setup, safety, contract truth, and release navigation.',
  'REPOSITORY_BLUEPRINT.md':
    'Target monorepo layout, package responsibilities, import boundaries, and evolution rules.',
  'RISK_REGISTER.md':
    'Technical, product, security, vendor, schedule, and submission risks with mitigations.',
  'SECURITY.md':
    'Security policy, disclosure process, secret handling, and high-risk change rules.',
  'START_HERE.md':
    'Operational entry point for running, validating, and deploying the implemented release candidate.',
  'TASKS.md':
    'Traceable implementation ledger with prioritized work items and evidence requirements.',
  'TECHNICAL_SPECIFICATION.md':
    'Detailed end-to-end implementation contract across web, backend, chain, data, and operations.',
  'THIRD_PARTY_NOTICES.md':
    'Generated production dependency, Foundry library, asset, and license notice inventory.',
  'TRACEABILITY_MATRIX.md':
    'Mapping from requirements to components, tasks, tests, evidence, and judging criteria.',
  'VALIDATION_REPORT.md':
    'Terminal local release validation, exact disposition, repair history, and external acceptance gates.',
};

const exactPurposes = {
  '.env.example': 'Complete non-secret environment-variable template with safe disabled defaults.',
  '.editorconfig': 'Cross-editor whitespace, newline, and indentation defaults.',
  '.gitignore': 'Generated-output, dependency, secret, Foundry, and private-evidence exclusions.',
  '.node-version': 'Exact Node runtime selector for compatible version managers.',
  '.nvmrc': 'Exact Node runtime selector for nvm-compatible environments.',
  'biome.json': 'Repository formatting and linting configuration.',
  'docker-compose.yml': 'Local PostgreSQL and Redis development services.',
  'package.json': 'Root workspace metadata, exact tool versions, and canonical lifecycle commands.',
  'pnpm-workspace.yaml': 'pnpm workspace package discovery configuration.',
  'tsconfig.base.json': 'Strict shared TypeScript compiler configuration.',
  'turbo.json': 'Turborepo task graph, caching, outputs, and environment dependencies.',
  '.github/CODEOWNERS': 'Required reviewer ownership for sensitive paths.',
  '.github/dependabot.yml': 'Automated dependency and GitHub Actions update policy.',
  '.github/pull_request_template.md':
    'Required PR context, risk, test, evidence, and documentation checklist.',
  '.github/ISSUE_TEMPLATE/bug.yml': 'Structured bug report form.',
  '.github/ISSUE_TEMPLATE/feature.yml': 'Structured feature proposal form.',
  '.github/workflows/ci.yml':
    'Application/package documentation, lint, type, test, build, and browser CI.',
  '.github/workflows/contracts.yml':
    'Pinned Foundry formatting, build, test, size, and gas snapshot CI.',
  '.github/workflows/live-compatibility.yml':
    'Manually approved tiny-value mainnet vendor compatibility test workflow.',
  '.github/workflows/release.yml':
    'Manual release-readiness validation and evidence archival workflow.',
  '.github/workflows/security.yml':
    'CodeQL, dependency review, and pinned Slither security analysis.',
  '.vscode/extensions.json': 'Recommended editor extensions for this repository.',
  '.vscode/settings.json': 'Repository editor defaults consistent with Biome and TypeScript.',
  'openapi/opentab.openapi.yaml': 'Machine-readable HTTP API contract and schema baseline.',
  'openapi/README.md': 'OpenAPI authoring, generation, validation, and compatibility instructions.',
  'source/uxmaxx-hackathon-brief.txt':
    'Verbatim project-owner-supplied hackathon tracks, requirements, judging, and links.',
  'source/README.md': 'Provenance and handling rules for owner-supplied source material.',
  'deployments/README.md': 'Deployment record layout and required verified metadata.',
  'evidence/README.md': 'Evidence taxonomy, redaction policy, provenance, and submission handling.',
};

const sectionOrder = [
  'Root specifications and configuration',
  'Codex instructions and reusable skills',
  'Product and technical documentation',
  'Application and package source',
  'Contracts and deployment source',
  'API contract',
  'Automation and CI',
  'Build evidence',
  'Source material and evidence',
  'Other',
];

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(absolute, out);
    else if (entry.isFile()) out.push(path.relative(root, absolute).replaceAll(path.sep, '/'));
  }
}

function section(file) {
  if (!file.includes('/') || file.startsWith('.vscode/'))
    return 'Root specifications and configuration';
  if (file.startsWith('codex/') || file.startsWith('.agents/') || file.endsWith('/AGENTS.md'))
    return 'Codex instructions and reusable skills';
  if (file.startsWith('docs/')) return 'Product and technical documentation';
  if (file.startsWith('apps/') || file.startsWith('packages/') || file.startsWith('spikes/')) {
    if (file.startsWith('packages/contracts/')) return 'Contracts and deployment source';
    return 'Application and package source';
  }
  if (file.startsWith('deployments/')) return 'Contracts and deployment source';
  if (file.startsWith('openapi/')) return 'API contract';
  if (file.startsWith('.github/') || file.startsWith('scripts/')) return 'Automation and CI';
  if (file.startsWith('artifacts/autonomous-build/')) return 'Build evidence';
  if (file.startsWith('source/') || file.startsWith('evidence/'))
    return 'Source material and evidence';
  return 'Other';
}

function humanize(stem) {
  return stem
    .replace(/\.(md|json|ya?ml|mjs|ts|tsx|sol|toml|txt|sh)$/i, '')
    .replace(/^\d+[-_]/, '')
    .replaceAll(/[-_]/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function purpose(file) {
  if (rootPurposes[file]) return rootPurposes[file];
  if (exactPurposes[file]) return exactPurposes[file];
  const base = path.basename(file);
  const title = humanize(base);
  if (base === 'AGENTS.md') return `Directory-scoped Codex rules for \`${path.dirname(file)}\`.`;
  if (file.includes('/adr/')) return `Architecture decision record: ${title}.`;
  if (file.startsWith('.agents/skills/')) return `Reusable Codex skill playbook: ${title}.`;
  if (file.startsWith('codex/')) return `Codex execution aid: ${title}.`;
  if (file.startsWith('docs/')) return `Authoritative specification or operating guide: ${title}.`;
  if (file.startsWith('artifacts/autonomous-build/'))
    return `Sanitized autonomous-build evidence: ${title}.`;
  if (file.endsWith('package.json'))
    return `Workspace metadata, exact dependencies, and scripts for \`${path.dirname(file)}\`.`;
  if (base.startsWith('tsconfig'))
    return `TypeScript compiler configuration for \`${path.dirname(file)}\`.`;
  if (base.includes('vitest'))
    return `Vitest configuration for ${file.includes('live') ? 'protected live compatibility tests' : 'automated tests'}.`;
  if (base === 'playwright.config.ts')
    return 'Desktop/mobile browser E2E configuration and local server orchestration.';
  if (base === 'next.config.ts')
    return 'Next.js application configuration and typed route settings.';
  if (base === 'postcss.config.mjs') return 'PostCSS/Tailwind build configuration.';
  if (file.endsWith('.sol'))
    return `Solidity ${file.includes('/test/') ? 'test' : 'contract implementation'}: ${title}.`;
  if (file.endsWith('.t.sol')) return `Foundry Solidity test: ${title}.`;
  if (base === 'foundry.toml')
    return 'Pinned Solidity compiler, conservative Cancun opcode target, test, optimizer, and RPC configuration.';
  if (base === 'remappings.txt')
    return 'Foundry import remappings for pinned Solidity dependencies.';
  if (base === 'slither.config.json')
    return 'Slither detector scope and failure-threshold configuration.';
  if (file.endsWith('.mjs')) return `Node automation utility: ${title}.`;
  if (file.endsWith('.sh')) return `Shell automation utility: ${title}.`;
  if (file.endsWith('.ts') || file.endsWith('.tsx'))
    return `Typed ${file.includes('/test') ? 'test' : 'implementation'}: ${title}.`;
  if (base === '.gitkeep')
    return `Keeps the required empty evidence directory \`${path.dirname(file)}\` in version control.`;
  return `${title} project artifact.`;
}

const files = [];
walk(root, files);
if (!files.includes('FILE_INDEX.md')) files.push('FILE_INDEX.md');
files.sort((a, b) => a.localeCompare(b));
const groups = new Map(sectionOrder.map((name) => [name, []]));
for (const file of files) groups.get(section(file)).push(file);

let body = `# OpenTab File Index\n\n`;
body += `Generated by \`node scripts/generate-file-index.mjs\`. This is the exhaustive release-repository guide. Dependency and disposable build directories listed in \`.gitignore\` are intentionally excluded; the persistent sanitized autonomous-build evidence directory is included.\n\n`;
body += `**Indexed files:** ${files.length}\n\n`;
body += `Run the generator after adding, moving, or deleting tracked files, then regenerate \`MANIFEST.json\`.\n\n`;
for (const name of sectionOrder) {
  const entries = groups.get(name);
  if (!entries.length) continue;
  body += `## ${name}\n\n| Path | Purpose |\n|---|---|\n`;
  for (const file of entries) body += `| \`${file}\` | ${purpose(file)} |\n`;
  body += '\n';
}
fs.writeFileSync(output, body);
console.log(`Wrote FILE_INDEX.md with ${files.length} entries.`);
