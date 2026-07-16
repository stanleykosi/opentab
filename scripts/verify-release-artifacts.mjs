import fs from 'node:fs';
import path from 'node:path';

import { computeReleaseSourceFingerprint } from './lib/release-source-fingerprint.mjs';

const root = path.resolve(import.meta.dirname, '..');
const failures = [];

function read(relativePath) {
  const absolutePath = path.join(root, relativePath);
  if (!fs.existsSync(absolutePath)) {
    failures.push(`Missing required release artifact: ${relativePath}`);
    return '';
  }
  return fs.readFileSync(absolutePath, 'utf8');
}

function expect(condition, message) {
  if (!condition) failures.push(message);
}

const report = read('FINAL_BUILD_REPORT.md');
expect(
  /Final status: `(READY FOR DEPLOYMENT|BUILD COMPLETE WITH EXTERNAL BLOCKERS)`/.test(report),
  'FINAL_BUILD_REPORT.md must use an allowed terminal status.',
);
expect(
  !/\bNOT_STARTED\b|^Pending\.$/m.test(report),
  'Final report still contains pending markers.',
);

const state = read('AUTONOMOUS_BUILD_STATE.md');
expect(
  /Status: `(RELEASE_CANDIDATE|BUILD_COMPLETE_WITH_EXTERNAL_BLOCKERS)`/.test(state),
  'AUTONOMOUS_BUILD_STATE.md must record a terminal release-candidate state.',
);

const blockers = read('BLOCKERS.md');
expect(
  blockers.includes('No external blockers remain.') || /^## BLK-[0-9]{3}/m.test(blockers),
  'BLOCKERS.md must either declare no external blockers or contain a structured blocker.',
);
if (/^## BLK-[0-9]{3}/m.test(blockers)) {
  for (const field of [
    'Severity:',
    'Affected feature or test:',
    'Work already completed:',
    'Verification procedure:',
    'Continue command:',
    'Deployment impact:',
  ]) {
    expect(blockers.includes(field), `BLOCKERS.md is missing required field ${field}`);
  }
}

const deployment = read('03_DEPLOYMENT_AFTER_BUILD.md');
expect(
  !/handoff template|YOUR_ORG|REPLACE_ME|final implementation should/i.test(deployment),
  'Deployment handoff still contains template language.',
);
for (const heading of [
  '1. GitHub',
  '2. Supabase PostgreSQL and shared Redis',
  '3. Railway indexer',
  '4. Vercel web/API',
  '5. Magic and Particle',
  '6. Arbitrum contracts',
  '7. Environment variables',
  '8. Migrations',
  '9. Canary flags',
  '10. Tiny live transaction',
  '11. Production enablement',
  '12. Rollback',
]) {
  expect(deployment.includes(heading), `Deployment handoff is missing ordered section: ${heading}`);
}

const readme = read('README.md');
expect(readme.startsWith('# OpenTab\n'), 'README.md must be the public OpenTab README.');
expect(!readme.includes('Codex Build Pack'), 'README.md still describes a specification seed.');
read('THIRD_PARTY_NOTICES.md');

for (const reportPath of [
  'artifacts/autonomous-build/agent-reports/qa-final.md',
  'artifacts/autonomous-build/agent-reports/security-final.md',
  'artifacts/autonomous-build/agent-reports/performance-accessibility-final.md',
  'artifacts/autonomous-build/agent-reports/release-engineering.md',
  'artifacts/autonomous-build/agent-reports/final-review.md',
]) {
  read(reportPath);
}

const summaryPath = 'artifacts/autonomous-build/test-results/release-validation-summary.json';
const summary = read(summaryPath);
if (summary.length > 0) {
  try {
    const parsed = JSON.parse(summary);
    expect(parsed.schemaVersion === 1, `${summaryPath} has an unsupported schemaVersion.`);
    expect(parsed.toolchain?.node === 'v25.0.0', `${summaryPath} must record Node v25.0.0.`);
    expect(parsed.toolchain?.pnpm === '9.15.1', `${summaryPath} must record pnpm 9.15.1.`);
    expect(
      Array.isArray(parsed.commands) && parsed.commands.length > 0,
      `${summaryPath} has no command results.`,
    );
    expect(
      parsed.commands?.every(
        (command) =>
          typeof command?.command === 'string' &&
          Number.isInteger(command?.exitCode) &&
          ['passed', 'failed', 'external_blocker', 'tool_unavailable'].includes(command?.status),
      ),
      `${summaryPath} contains malformed command results.`,
    );
    const commands = Array.isArray(parsed.commands) ? parsed.commands : [];
    expect(
      commands.every(
        (command) =>
          command.status !== 'failed' && (command.status !== 'passed' || command.exitCode === 0),
      ),
      `${summaryPath} contains a failed command or a passed command with a nonzero exit code.`,
    );
    const requiredCommandPatterns = [
      /pnpm install --frozen-lockfile/,
      /pnpm docs:check/,
      /pnpm format:check/,
      /pnpm lint/,
      /pnpm typecheck/,
      /pnpm test:unit/,
      /pnpm test:integration/,
      /pnpm test:e2e/,
      /pnpm build/,
      /pnpm contracts:test/,
      /pnpm contracts:coverage/,
      /pnpm contracts:slither/,
      /pnpm security:audit/,
      /pnpm security:licenses/,
      /pnpm smoke:demo/,
      /pnpm verify$/,
    ];
    for (const pattern of requiredCommandPatterns) {
      expect(
        commands.some((command) => pattern.test(command.command)),
        `${summaryPath} does not record required gate ${pattern}.`,
      );
    }

    const currentFingerprint = computeReleaseSourceFingerprint(root);
    expect(
      parsed.sourceFingerprint?.algorithm === 'sha256' &&
        parsed.sourceFingerprint?.version === 1 &&
        parsed.sourceFingerprint?.fileCount === currentFingerprint.fileCount &&
        parsed.sourceFingerprint?.sha256 === currentFingerprint.sha256,
      `${summaryPath} is stale for the current release source tree.`,
    );

    const counts = parsed.counts;
    if (counts && commands.length > 0) {
      const statusCount = (status) =>
        commands.filter((command) => command.status === status).length;
      expect(
        counts.passed === statusCount('passed'),
        `${summaryPath} passed count is inconsistent.`,
      );
      expect(
        counts.failed === statusCount('failed'),
        `${summaryPath} failed count is inconsistent.`,
      );
      expect(
        counts.externalBlocker === statusCount('external_blocker'),
        `${summaryPath} external-blocker count is inconsistent.`,
      );
      expect(
        counts.toolUnavailable === statusCount('tool_unavailable'),
        `${summaryPath} tool-unavailable count is inconsistent.`,
      );
      expect(counts.total === commands.length, `${summaryPath} total count is inconsistent.`);
    }
  } catch (error) {
    failures.push(`${summaryPath} is not valid JSON: ${String(error)}`);
  }
}

if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`ERROR ${failure}\n`);
  process.exit(1);
}

process.stdout.write('Release artifacts are complete and internally consistent.\n');
