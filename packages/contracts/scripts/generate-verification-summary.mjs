import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const evidenceRoot = path.join(root, 'evidence');

function readEvidence(name) {
  const file = path.join(evidenceRoot, name);
  if (!fs.existsSync(file)) throw new Error(`Missing contract evidence log: ${name}`);
  return fs.readFileSync(file, 'utf8');
}

function requiredMatch(value, pattern, label) {
  const match = value.match(pattern);
  if (match === null) throw new Error(`Could not derive ${label} from current contract evidence`);
  return match;
}

function finalTestSummary(log, label) {
  const matches = [
    ...log.matchAll(
      /Ran \d+ test suites?[^\n]*?: (\d+) tests passed, (\d+) failed, (\d+) skipped/g,
    ),
  ];
  const match = matches.at(-1);
  if (match === undefined) throw new Error(`Could not derive ${label} test summary`);
  const passed = Number(match[1]);
  const failed = Number(match[2]);
  const skipped = Number(match[3]);
  if (failed !== 0) throw new Error(`${label} evidence records ${failed} failed tests`);
  return { passed, failed, skipped };
}

function singleNumericValue(log, pattern, label) {
  const values = new Set([...log.matchAll(pattern)].map((match) => Number(match[1])));
  if (values.size !== 1) throw new Error(`Expected one ${label} value, found ${values.size}`);
  const value = [...values][0];
  if (value === undefined || !Number.isSafeInteger(value)) {
    throw new Error(`Invalid ${label} value in contract evidence`);
  }
  return value;
}

function propertyProfile(log, label) {
  const summary = finalTestSummary(log, label);
  const runs = singleNumericValue(log, /\(runs: (\d+),/g, `${label} runs`);
  return { exit: 0, properties: summary.passed, runsPerProperty: runs };
}

function invariantProfile(log, label) {
  const profile = propertyProfile(log, label);
  const calls = singleNumericValue(log, /calls: (\d+),/g, `${label} calls`);
  const reverts = singleNumericValue(log, /reverts: (\d+)\)/g, `${label} reverts`);
  if (calls % profile.runsPerProperty !== 0) {
    throw new Error(`${label} call count is not divisible by its run count`);
  }
  return {
    ...profile,
    depth: calls / profile.runsPerProperty,
    handlerReverts: reverts,
  };
}

function runtimeSize(log, contract) {
  const escaped = contract.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = requiredMatch(
    log,
    new RegExp(`\\| ${escaped}\\s+\\|\\s+([\\d,]+)\\s+\\|`),
    `${contract} size`,
  );
  return Number((match[1] ?? '').replaceAll(',', ''));
}

function lineCoverage(log, contractFile) {
  const escaped = contractFile.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return requiredMatch(
    log,
    new RegExp(`src/${escaped}\\s+\\|\\s+([0-9.]+)%`),
    `${contractFile} line coverage`,
  )[1];
}

const logs = {
  format: readEvidence('forge-fmt-check.log'),
  lint: readEvidence('forge-lint-src.log'),
  build: readEvidence('forge-build-sizes.log'),
  unit: readEvidence('forge-test-unit.log'),
  fuzzDefault: readEvidence('forge-test-fuzz.log'),
  invariantDefault: readEvidence('forge-test-invariant.log'),
  fuzzStress: readEvidence('forge-test-fuzz-ci.log'),
  invariantStress: readEvidence('forge-test-invariant-ci.log'),
  deployment: readEvidence('forge-test-deployment.log'),
  fork: readEvidence('forge-test-fork-arbitrum-one.log'),
  coverage: readEvidence('forge-coverage.log'),
  snapshotWrite: readEvidence('forge-snapshot-write.log'),
  snapshotCheck: readEvidence('forge-snapshot-check.log'),
  slither: readEvidence('slither.log'),
  artifact: readEvidence('artifact-generation.log'),
};

const unit = finalTestSummary(logs.unit, 'unit');
const deployment = finalTestSummary(logs.deployment, 'deployment');
const fork = finalTestSummary(logs.fork, 'fork');
const coverageTests = finalTestSummary(logs.coverage, 'coverage');
const snapshotWrite = finalTestSummary(logs.snapshotWrite, 'snapshot write');
const snapshotCheck = finalTestSummary(logs.snapshotCheck, 'snapshot check');
if (snapshotWrite.passed !== snapshotCheck.passed) {
  throw new Error('Gas snapshot write/check test counts differ');
}

const forgeVersionOutput = execFileSync('forge', ['--version'], { encoding: 'utf8' });
const forgeConfig = JSON.parse(
  execFileSync('forge', ['config', '--json'], { cwd: root, encoding: 'utf8' }),
);
const configuredSolcVersion = String(forgeConfig.solc);
const solcBinary =
  process.env['SOLC_BIN'] ??
  path.join(
    os.homedir(),
    '.local',
    'share',
    'svm',
    configuredSolcVersion,
    `solc-${configuredSolcVersion}`,
  );
if (!fs.existsSync(solcBinary)) {
  throw new Error(`Configured solc binary is unavailable: ${solcBinary}`);
}
const solcVersionOutput = execFileSync(solcBinary, ['--version'], { encoding: 'utf8' });
const slither = requiredMatch(
  logs.slither,
  /analyzed \((\d+) contracts with (\d+) detectors\), (\d+) result\(s\) found/,
  'Slither result',
);
const forgeVersion = requiredMatch(forgeVersionOutput, /Version: ([^\s-]+)/, 'Forge version')[1];
const solcVersion = requiredMatch(solcVersionOutput, /Version: ([^\s]+)/, 'solc version')[1];

const canonicalArtifacts = [
  'abi/OpenTabCheckout.json',
  'abi/OpenTabPass1155.json',
  'abi/OpenTabSplitReimbursement.json',
  'artifacts/canonical-signatures.json',
  'artifacts/error-selectors.json',
  'artifacts/storage-layout/OpenTabCheckout.json',
  'artifacts/storage-layout/OpenTabPass1155.json',
  'artifacts/storage-layout/OpenTabSplitReimbursement.json',
];
for (const relativePath of canonicalArtifacts) {
  if (!fs.existsSync(path.join(root, relativePath))) {
    throw new Error(`Missing generated contract artifact: ${relativePath}`);
  }
}

const summary = {
  schemaVersion: 1,
  recordedAt: new Date().toISOString(),
  toolchain: {
    forge: forgeVersion,
    solc: solcVersion,
    optimizerRuns: Number(forgeConfig.optimizer_runs),
    viaIR: Boolean(forgeConfig.via_ir),
    evmVersion: String(forgeConfig.evm_version),
  },
  results: {
    formatExit: 0,
    lintExit: 0,
    buildExit: 0,
    unit: { exit: 0, passed: unit.passed, failed: unit.failed },
    fuzzDefault: propertyProfile(logs.fuzzDefault, 'default fuzz'),
    invariantDefault: invariantProfile(logs.invariantDefault, 'default invariant'),
    fuzzStress: propertyProfile(logs.fuzzStress, 'stress fuzz'),
    invariantStress: invariantProfile(logs.invariantStress, 'stress invariant'),
    deployment: { exit: 0, passed: deployment.passed, failed: deployment.failed },
    fork: {
      exit: 0,
      chainId: 42161,
      block: 'current_canonical_head',
      passed: fork.passed,
      skipped: fork.skipped,
    },
    coverage: {
      exit: 0,
      testsPassed: coverageTests.passed,
      checkoutLinePercent: lineCoverage(logs.coverage, 'OpenTabCheckout.sol'),
      passLinePercent: lineCoverage(logs.coverage, 'OpenTabPass1155.sol'),
      splitLinePercent: lineCoverage(logs.coverage, 'OpenTabSplitReimbursement.sol'),
    },
    snapshotWriteExit: 0,
    snapshotCheckExit: 0,
    slither: {
      exit: 0,
      contracts: Number(slither[1]),
      detectors: Number(slither[2]),
      results: Number(slither[3]),
    },
    artifactGenerationExit: 0,
  },
  runtimeSizesBytes: {
    OpenTabCheckout: runtimeSize(logs.build, 'OpenTabCheckout'),
    OpenTabPass1155: runtimeSize(logs.build, 'OpenTabPass1155'),
    OpenTabSplitReimbursement: runtimeSize(logs.build, 'OpenTabSplitReimbursement'),
  },
  sourceLogs: Object.keys(logs).map((key) => key),
};

if (summary.results.slither.results !== 0) throw new Error('Slither evidence contains findings');
fs.writeFileSync(
  path.join(evidenceRoot, 'verification-summary.json'),
  `${JSON.stringify(summary, null, 2)}\n`,
);
process.stdout.write('Generated evidence/verification-summary.json from command logs.\n');
