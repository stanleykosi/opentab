import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const failures = [];

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function json(relativePath) {
  return JSON.parse(read(relativePath));
}

const activeWorkflowDirectory = path.join(root, '.github', 'workflows');
const parkedWorkflowDirectory = path.join(root, '.github', 'workflows-disabled');
const workflowDirectory = fs.existsSync(activeWorkflowDirectory)
  ? fs.readdirSync(activeWorkflowDirectory).some((name) => name.endsWith('.yml'))
    ? activeWorkflowDirectory
    : parkedWorkflowDirectory
  : parkedWorkflowDirectory;
const workflowRelativeDirectory = path.relative(root, workflowDirectory);

function readWorkflow(name) {
  return read(path.join(workflowRelativeDirectory, name));
}

function expect(condition, message) {
  if (!condition) failures.push(message);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function expectKeys(value, allowed, required, label) {
  if (!isRecord(value)) {
    failures.push(`${label} must be an object.`);
    return false;
  }
  for (const key of required) expect(key in value, `${label} is missing ${key}.`);
  for (const key of Object.keys(value)) {
    expect(allowed.includes(key), `${label} contains unsupported property ${key}.`);
  }
  return true;
}

const packageJson = json('package.json');
expect(packageJson.packageManager === 'pnpm@9.15.1', 'packageManager must be pnpm@9.15.1.');
expect(packageJson.engines?.node === '25.0.0', 'engines.node must be exactly 25.0.0.');
expect(packageJson.engines?.pnpm === '9.15.1', 'engines.pnpm must be exactly 9.15.1.');
expect(read('.nvmrc').trim() === '25.0.0', '.nvmrc must pin 25.0.0.');
expect(read('.node-version').trim() === '25.0.0', '.node-version must pin 25.0.0.');

const dockerfile = read('apps/indexer/Dockerfile');
expect(dockerfile.includes('ARG NODE_VERSION=25.0.0'), 'Indexer Dockerfile must pin Node 25.0.0.');
expect(dockerfile.includes('ARG PNPM_VERSION=9.15.1'), 'Indexer Dockerfile must pin pnpm 9.15.1.');
expect(
  !dockerfile.includes('--mount=type=cache'),
  'Railway Dockerfile cache mounts require a deployment-specific service ID and must stay disabled.',
);
expect(
  dockerfile.includes('pnpm --offline --package-import-method=hardlink') &&
    dockerfile.includes('--filter @opentab/indexer deploy --prod'),
  'Indexer Docker packaging must consume the frozen local store without registry resolution.',
);
expect(dockerfile.includes('USER node'), 'Indexer runtime must run as the non-root node user.');
expect(dockerfile.includes('ENV PORT=3002'), 'Indexer image must expose Railway health port 3002.');
expect(
  !dockerfile.includes('ENV INDEXER_HEALTH_PORT='),
  'Indexer image must not override Railway PORT with a baked application health port.',
);
expect(
  dockerfile.includes('process.env.PORT'),
  'Indexer container healthcheck must follow the Railway PORT variable.',
);
expect(
  !dockerfile.includes('/workspace/.deploy/indexer/ ./'),
  'Indexer runtime stage must not copy deployed source, tests, or build metadata wholesale.',
);
for (const runtimeInput of ['package.json', 'dist/', 'node_modules/']) {
  expect(
    dockerfile.includes(`/workspace/.deploy/indexer/${runtimeInput}`),
    `Indexer runtime stage must copy ${runtimeInput}.`,
  );
}
expect(
  dockerfile.includes('/health/live'),
  'Indexer container liveness check must use /health/live.',
);
const dockerignore = read('.dockerignore');
for (const ignoredPath of ['**/node_modules', '**/.next', '.deploy-smoke', '.env.*']) {
  expect(
    dockerignore.includes(ignoredPath),
    `.dockerignore must exclude ${ignoredPath} from the Railway build context.`,
  );
}

const contractArtifactGenerator = read('scripts/generate-contract-artifacts.mjs');
expect(
  contractArtifactGenerator.includes("'OpenTabSplitReimbursement'") &&
    contractArtifactGenerator.includes("'generate-artifacts.sh'"),
  'Root contract artifact generation must use the canonical three-contract pipeline.',
);

const railway = json('railway.indexer.json');
expect(railway.build?.builder === 'DOCKERFILE', 'Railway indexer must use the Dockerfile builder.');
expect(
  railway.build?.dockerfilePath === 'apps/indexer/Dockerfile',
  'Railway must use apps/indexer/Dockerfile.',
);
expect(
  railway.deploy?.healthcheckPath === '/health/ready',
  'Railway deploy health must use indexer readiness.',
);
expect(
  railway.deploy?.restartPolicyType === 'ON_FAILURE',
  'Railway indexer restart policy must be ON_FAILURE.',
);
expect(
  railway.deploy?.sleepApplication === false,
  'Railway indexer must not sleep in live service.',
);
expect(
  Number(railway.deploy?.drainingSeconds) >= 30,
  'Railway indexer needs at least 30 seconds to drain after SIGTERM.',
);
for (const watchedReleaseInput of ['/.dockerignore', '/railway.indexer.json']) {
  expect(
    railway.build?.watchPatterns?.includes(watchedReleaseInput),
    `Railway must redeploy when ${watchedReleaseInput} changes.`,
  );
}

const vercel = json('apps/web/vercel.json');
const webPackage = json('apps/web/package.json');
expect(vercel.framework === 'nextjs', 'Vercel framework must be nextjs.');
expect(
  vercel.installCommand ===
    'cd ../.. && pnpm install --frozen-lockfile --config.engine-strict=false',
  'Vercel must install the frozen root lockfile under its isolated Node 24 profile.',
);
expect(
  vercel.buildCommand === 'cd ../.. && pnpm --filter @opentab/web build',
  'Vercel must build only the web workspace from the monorepo root.',
);
expect(
  !JSON.stringify(vercel).includes('nodejs25'),
  'Vercel config must not claim an unsupported Node 25 function runtime.',
);
expect(
  webPackage.engines?.node === '24.x',
  'The Vercel web project must declare the supported Node 24.x runtime profile.',
);
expect(
  webPackage.engines?.pnpm === '9.15.1' && webPackage.packageManager === 'pnpm@9.15.1',
  'The Vercel web project must preserve pnpm 9.15.1.',
);

expect(
  vercel.headers === undefined,
  'Vercel config must defer security headers to the single reviewed Next.js policy.',
);

const deploymentHandoff = read('03_DEPLOYMENT_AFTER_BUILD.md');
for (const requiredSupabaseControl of [
  'docs/07-operations/SUPABASE_POSTGRES.md',
  'Supavisor transaction pooler',
  'pnpm supabase:check:target',
  'Data API',
]) {
  expect(
    deploymentHandoff.includes(requiredSupabaseControl),
    `Deployment handoff is missing Supabase control ${requiredSupabaseControl}.`,
  );
}
for (const requiredOidcControl of [
  'VERCEL_AWS_ROLE_ARN',
  'sts:AssumeRoleWithWebIdentity',
  'kms:GetPublicKey',
  'kms:Sign',
  'owner:[TEAM_SLUG]:project:[PROJECT_NAME]:environment:production',
]) {
  expect(
    deploymentHandoff.includes(requiredOidcControl),
    `Deployment handoff is missing Vercel OIDC control ${requiredOidcControl}.`,
  );
}
expect(
  deploymentHandoff.includes('AWS_ACCESS_KEY_ID') &&
    deploymentHandoff.includes('AWS_SECRET_ACCESS_KEY') &&
    deploymentHandoff.includes('Never configure'),
  'Deployment handoff must explicitly forbid static AWS credentials in Vercel.',
);

const integrationPackage = json('packages/integrations/package.json');
expect(
  integrationPackage.dependencies?.['@vercel/oidc-aws-credentials-provider'] === '3.3.0',
  'The official Vercel AWS OIDC provider must remain pinned to 3.3.0.',
);
const awsKmsSource = read('packages/integrations/src/aws-kms.ts');
for (const requiredOidcHelperSurface of [
  "import('@vercel/oidc-aws-credentials-provider')",
  'createVercelOidcAwsKmsClient',
  'module.awsCredentialsProvider({ roleArn: config.roleArn })',
  'credentials: config.credentials',
]) {
  expect(
    awsKmsSource.includes(requiredOidcHelperSurface),
    `Managed KMS integration is missing ${requiredOidcHelperSurface}.`,
  );
}
for (const forbiddenStaticAwsCredential of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']) {
  expect(
    !awsKmsSource.includes(forbiddenStaticAwsCredential),
    `Managed KMS integration must not read ${forbiddenStaticAwsCredential}.`,
  );
}
const webComposition = read('apps/web/app/api/_lib/composition.ts');
for (const managedFactory of [
  'createAwsKmsOrderIntentSigner',
  'createAwsKmsSplitIntentSigner',
  'createAwsKmsSplitRevocationSender',
  'createAwsKmsSponsorTransferAdapter',
]) {
  const factoryPosition = webComposition.indexOf(`${managedFactory}({`);
  expect(factoryPosition >= 0, `Web composition is missing ${managedFactory}.`);
  const factoryBlock = webComposition.slice(factoryPosition, factoryPosition + 1_800);
  expect(
    factoryBlock.includes("client: requireRuntimeValue(kmsClient, 'Vercel OIDC AWS KMS client')"),
    `${managedFactory} must receive the Vercel OIDC KMS client explicitly.`,
  );
}
expect(
  webComposition.includes('createVercelOidcAwsKmsClient({') &&
    webComposition.includes("config.VERCEL_AWS_ROLE_ARN, 'VERCEL_AWS_ROLE_ARN'"),
  'Web composition must create its managed signer client from the validated Vercel role ARN.',
);
const environmentSource = read('packages/config/src/index.ts');
expect(
  environmentSource.includes("config.ORDER_SIGNER_MODE === 'kms'") &&
    environmentSource.includes("config.SPLIT_SIGNER_MODE === 'kms'") &&
    environmentSource.includes("config.SPONSOR_SIGNER_MODE === 'kms'") &&
    environmentSource.includes("requireConfigured(\n      'VERCEL_AWS_ROLE_ARN'"),
  'Every KMS signer mode must require VERCEL_AWS_ROLE_ARN during environment validation.',
);

const example = read('.env.example');
const environmentDocumentation = read('docs/07-operations/ENVIRONMENT_VARIABLES.md');
for (const match of example.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)) {
  const name = match[1];
  expect(
    environmentDocumentation.includes(`\`${name}\``),
    `.env.example variable ${name} must be documented in the operations catalog.`,
  );
}
expect(
  /^VERCEL_AWS_ROLE_ARN=$/m.test(example),
  '.env.example must expose the Vercel OIDC role boundary without a value.',
);
for (const forbiddenStaticAwsCredential of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']) {
  expect(
    !new RegExp(`^${forbiddenStaticAwsCredential}=`, 'm').test(example),
    `.env.example must not offer static ${forbiddenStaticAwsCredential} credentials.`,
  );
}
for (const [name, expected] of Object.entries({
  PAYMENTS_ENABLED: 'false',
  PARTICLE_LIVE_ENABLED: 'false',
  BOOTSTRAP_SPONSOR_ENABLED: 'false',
  BOOTSTRAP_SPONSOR_ALLOWLIST_ONLY: 'true',
  JUDGE_MODE_ENABLED: 'false',
  REFUNDS_ENABLED: 'false',
  WITHDRAWALS_ENABLED: 'false',
  SPLITS_ENABLED: 'false',
})) {
  expect(
    environmentSource.includes(`${name}: strictBoolean.default(${expected})`),
    `The validated environment schema must default ${name}=${expected}.`,
  );
}

for (const name of fs.readdirSync(workflowDirectory).filter((file) => file.endsWith('.yml'))) {
  const workflow = readWorkflow(name);
  for (const match of workflow.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)(?:\s+#.*)?$/gm)) {
    const action = match[1] ?? '';
    if (action.startsWith('./') || action.startsWith('docker://')) continue;
    expect(
      /@[0-9a-f]{40}$/.test(action),
      `.github/workflows/${name} must pin ${action} to a full commit SHA.`,
    );
  }
}

const liveWorkflow = readWorkflow('live-compatibility.yml');
expect(
  liveWorkflow.includes('I_ACKNOWLEDGE_TINY_ARBITRUM_MAINNET_SPEND'),
  'Live workflow must require the exact spend acknowledgement.',
);
expect(
  liveWorkflow.includes('LIVE_ACCEPTANCE_MAX_USDC_BASE_UNITS'),
  'Live workflow must pass an explicit base-unit spend ceiling.',
);
expect(
  liveWorkflow.includes('environment: demo-mainnet'),
  'Live workflow must use the protected demo-mainnet environment.',
);
for (const requiredLiveControl of [
  'id-token: write',
  'aws-actions/configure-aws-credentials@',
  'PARTICLE_ALLOWED_SOURCE_TOKENS',
  'PLATFORM_FEE_BPS',
  'AWS_KMS_REGION',
  'SPONSOR_SIGNER_ADDRESS',
  'SPONSOR_MAX_FEE_PER_GAS_WEI',
  'TURNSTILE_SECRET_KEY',
  'LIVE_ACCEPTANCE_PRODUCT_ID',
  'LIVE_ACCEPTANCE_AUTH_METHOD',
]) {
  expect(
    liveWorkflow.includes(requiredLiveControl),
    `Live workflow is missing required managed acceptance control ${requiredLiveControl}.`,
  );
}
const liveJobEnvironmentStart = liveWorkflow.indexOf('    env:');
const liveStepsStart = liveWorkflow.indexOf('    steps:');
const liveJobEnvironment = liveWorkflow.slice(liveJobEnvironmentStart, liveStepsStart);
expect(
  !liveJobEnvironment.includes('${{ secrets.'),
  'Live workflow must not expose secrets to dependency installation through job-level env.',
);
const frozenInstallPosition = liveWorkflow.indexOf('pnpm install --frozen-lockfile');
const oidcPosition = liveWorkflow.indexOf('aws-actions/configure-aws-credentials@');
expect(
  frozenInstallPosition >= 0 && oidcPosition > frozenInstallPosition,
  'Live workflow must install the frozen dependency graph before obtaining AWS credentials.',
);
expect(
  liveWorkflow.includes('env: &live-secrets') && liveWorkflow.includes('env: *live-secrets'),
  'Live provider secrets must be scoped only to the guarded validation and execution steps.',
);

const releaseWorkflow = readWorkflow('release.yml');
expect(
  releaseWorkflow.includes('[[ "$RELEASE_REF" =~ ^[0-9a-f]{40}$ ]]') &&
    releaseWorkflow.includes('test "$(git rev-parse HEAD)" = "$RELEASE_REF"'),
  'Release workflow must accept and verify only an immutable full commit SHA.',
);
expect(
  !releaseWorkflow.includes('default: main'),
  'Release qualification must not default to a mutable branch.',
);
expect(
  releaseWorkflow.includes('OPENTAB_BASE_URL=http://127.0.0.1:3000 pnpm smoke:demo'),
  'Release workflow must smoke the built web application without a mutation.',
);
expect(
  releaseWorkflow.includes('pnpm --filter @opentab/indexer test:packaged'),
  'Release workflow must execute the assembled indexer runtime.',
);

const ciWorkflow = readWorkflow('ci.yml');
expect(
  ciWorkflow.includes('docker build --file apps/indexer/Dockerfile'),
  'CI must build the exact Railway indexer image.',
);
expect(
  ciWorkflow.includes('docker inspect') && ciWorkflow.includes('--entrypoint node'),
  'CI must inspect the indexer image and verify its runtime pin.',
);
expect(
  ciWorkflow.includes('--env APP_ENV=production') &&
    ciWorkflow.includes('--env INDEXER_ENABLED=false') &&
    ciWorkflow.includes('--env INDEXER_WRITES_ENABLED=false'),
  'CI must execute the packaged indexer entrypoint to catch bundle/runtime failures.',
);

const securityWorkflow = readWorkflow('security.yml');
expect(
  securityWorkflow.includes('node scripts/verify-dependency-audit.mjs'),
  'Security CI must use the patch- and waiver-aware dependency audit gate.',
);
expect(
  securityWorkflow.includes('allow-ghsas: GHSA-3gc7-fjrx-p6mg'),
  'Dependency review may allow only the exact QW-002 GHSA.',
);
for (const [name, workflow] of [
  ['Security', securityWorkflow],
  ['Release', releaseWorkflow],
]) {
  expect(
    workflow.includes(
      'git diff --exit-code -- THIRD_PARTY_NOTICES.md artifacts/autonomous-build/evidence/dependency-licenses.json',
    ),
    `${name} workflow must reject stale deterministic license evidence.`,
  );
}

const deploymentSchema = json('deployments/arbitrum-deployment.schema.json');
expect(
  deploymentSchema.properties?.chain?.properties?.id?.const === '42161',
  'Deployment schema must bind Arbitrum One chain ID 42161.',
);
expect(
  deploymentSchema.properties?.chain?.properties?.rpcProviders?.minItems >= 2,
  'Deployment schema must require two named RPC providers.',
);
expect(
  deploymentSchema.properties?.settlementToken?.const ===
    '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  'Deployment schema must bind native Arbitrum One USDC.',
);
expect(
  deploymentSchema.properties?.contracts?.required?.includes('split'),
  'Deployment schema must require the split reimbursement contract.',
);
for (const role of [
  'deployer',
  'defaultAdmin',
  'pauser',
  'feeManager',
  'merchantManager',
  'orderSigner',
  'splitSigner',
  'sponsorSigner',
  'feeRecipient',
]) {
  expect(
    deploymentSchema.properties?.roles?.required?.includes(role),
    `Deployment schema must require ${role}.`,
  );
}
expect(
  deploymentSchema.properties?.verification?.properties?.compilerVersion?.const === '0.8.36' &&
    deploymentSchema.properties?.verification?.properties?.optimizerRuns?.const === 200,
  'Deployment schema must bind the reviewed Solidity compiler settings.',
);
expect(
  deploymentSchema.properties?.foundryReceipt?.properties?.path?.const ===
    'packages/contracts/deployments/42161.json',
  'Deployment attestation schema must bind the canonical Foundry receipt path.',
);

const deploymentDirectory = path.join(root, 'deployments');
const releaseAttestations = fs
  .readdirSync(deploymentDirectory)
  .filter((name) => name.endsWith('.json') && name !== 'arbitrum-deployment.schema.json');
for (const name of releaseAttestations) {
  const relativeAttestationPath = path.join('deployments', name);
  const attestation = json(relativeAttestationPath);
  const topLevelKeys = [
    'schemaVersion',
    'applicationVersion',
    'gitCommit',
    'deployedAt',
    'chain',
    'deploymentBlock',
    'settlementToken',
    'contracts',
    'roles',
    'configuration',
    'foundryReceipt',
    'verification',
  ];
  expectKeys(attestation, topLevelKeys, topLevelKeys, relativeAttestationPath);
  expect(attestation.schemaVersion === 1, `${relativeAttestationPath} must use schema version 1.`);
  expect(
    typeof attestation.applicationVersion === 'string' &&
      attestation.applicationVersion.length >= 1 &&
      attestation.applicationVersion.length <= 80,
    `${relativeAttestationPath} has an invalid application version.`,
  );
  expect(
    /^[0-9a-f]{40}$/.test(attestation.gitCommit ?? ''),
    `${relativeAttestationPath} must bind a lowercase immutable Git commit.`,
  );
  expect(
    typeof attestation.deployedAt === 'string' &&
      Number.isFinite(Date.parse(attestation.deployedAt)),
    `${relativeAttestationPath} has an invalid deployment timestamp.`,
  );
  expectKeys(
    attestation.chain,
    ['id', 'name', 'explorerBaseUrl', 'rpcProviders'],
    ['id', 'name', 'explorerBaseUrl', 'rpcProviders'],
    `${relativeAttestationPath} chain`,
  );
  expect(
    attestation.chain?.id === '42161' &&
      attestation.chain?.name === 'Arbitrum One' &&
      attestation.chain?.explorerBaseUrl === 'https://arbiscan.io',
    `${relativeAttestationPath} must identify canonical Arbitrum One.`,
  );
  const rpcProviders = attestation.chain?.rpcProviders;
  expect(
    Array.isArray(rpcProviders) &&
      rpcProviders.length >= 2 &&
      rpcProviders.every(
        (provider) =>
          typeof provider === 'string' && /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/.test(provider),
      ) &&
      new Set(rpcProviders.map((provider) => provider.toLowerCase())).size === rpcProviders.length,
    `${relativeAttestationPath} must name two distinct providers without recording RPC URLs.`,
  );
  expect(
    /^[1-9][0-9]*$/.test(attestation.deploymentBlock ?? ''),
    `${relativeAttestationPath} requires a nonzero deployment block.`,
  );
  expect(
    attestation.settlementToken === '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    `${relativeAttestationPath} must use native Arbitrum One USDC.`,
  );
  const addressPattern = /^0x(?!0{40}$)[0-9a-fA-F]{40}$/;
  const hashPattern = /^0x[0-9a-fA-F]{64}$/;
  expectKeys(
    attestation.contracts,
    ['checkout', 'pass', 'split'],
    ['checkout', 'pass', 'split'],
    `${relativeAttestationPath} contracts`,
  );
  const contractAddresses = [];
  for (const contractName of ['checkout', 'pass', 'split']) {
    const contract = attestation.contracts?.[contractName];
    expectKeys(
      contract,
      ['address', 'deploymentTransaction', 'bytecodeHash', 'verificationUrl'],
      ['address', 'deploymentTransaction', 'bytecodeHash', 'verificationUrl'],
      `${relativeAttestationPath} ${contractName} contract`,
    );
    expect(
      addressPattern.test(contract?.address ?? ''),
      `${relativeAttestationPath} ${contractName} address is invalid.`,
    );
    if (typeof contract?.address === 'string')
      contractAddresses.push(contract.address.toLowerCase());
    for (const field of ['deploymentTransaction', 'bytecodeHash']) {
      expect(
        hashPattern.test(contract?.[field] ?? ''),
        `${relativeAttestationPath} ${contractName} ${field} is invalid.`,
      );
    }
    try {
      const verificationUrl = new URL(contract?.verificationUrl);
      expect(
        verificationUrl.protocol === 'https:' &&
          verificationUrl.hostname === 'repo.sourcify.dev' &&
          verificationUrl.pathname.toLowerCase() === `/42161/${contract.address}`.toLowerCase() &&
          !verificationUrl.username &&
          !verificationUrl.password,
        `${relativeAttestationPath} ${contractName} verification URL must be the exact public Sourcify contract URL.`,
      );
    } catch {
      expect(false, `${relativeAttestationPath} ${contractName} verification URL is invalid.`);
    }
  }
  expect(
    new Set(contractAddresses).size === contractAddresses.length,
    `${relativeAttestationPath} contract addresses must be distinct.`,
  );
  const requiredRoles = [
    'deployer',
    'defaultAdmin',
    'pauser',
    'feeManager',
    'merchantManager',
    'orderSigner',
    'splitSigner',
    'sponsorSigner',
    'feeRecipient',
  ];
  expectKeys(
    attestation.roles,
    Object.keys(attestation.roles ?? {}),
    requiredRoles,
    `${relativeAttestationPath} roles`,
  );
  const roleHolders = [];
  for (const [roleName, role] of Object.entries(attestation.roles ?? {})) {
    expectKeys(
      role,
      ['holder', 'purpose'],
      ['holder', 'purpose'],
      `${relativeAttestationPath} ${roleName} role`,
    );
    expect(
      addressPattern.test(role?.holder ?? ''),
      `${relativeAttestationPath} ${roleName} role holder is invalid.`,
    );
    expect(
      typeof role?.purpose === 'string' && role.purpose.length >= 1 && role.purpose.length <= 200,
      `${relativeAttestationPath} ${roleName} role purpose is invalid.`,
    );
    if (requiredRoles.includes(roleName) && typeof role?.holder === 'string') {
      roleHolders.push(role.holder.toLowerCase());
    }
  }
  expect(
    new Set(roleHolders).size === requiredRoles.length,
    `${relativeAttestationPath} deployer, sponsor, and operational roles must use separate holders.`,
  );
  const configurationKeys = [
    'platformFeeBps',
    'adminDelaySeconds',
    'pendingDefaultAdminTransfers',
    'pendingDefaultAdminDelayChanges',
    'checkoutPaused',
    'splitPaused',
    'passBoundToCheckout',
    'passBindingTransaction',
  ];
  expectKeys(
    attestation.configuration,
    configurationKeys,
    configurationKeys,
    `${relativeAttestationPath} configuration`,
  );
  expect(
    Number.isInteger(attestation.configuration?.platformFeeBps) &&
      attestation.configuration.platformFeeBps >= 0 &&
      attestation.configuration.platformFeeBps <= 500,
    `${relativeAttestationPath} platform fee is outside the permanent cap.`,
  );
  expect(
    /^[1-9][0-9]*$/.test(attestation.configuration?.adminDelaySeconds ?? ''),
    `${relativeAttestationPath} admin delay must be a positive integer string.`,
  );
  expect(
    attestation.configuration?.pendingDefaultAdminTransfers === false &&
      attestation.configuration?.pendingDefaultAdminDelayChanges === false &&
      attestation.configuration?.checkoutPaused === false &&
      attestation.configuration?.splitPaused === false &&
      attestation.configuration?.passBoundToCheckout === true &&
      hashPattern.test(attestation.configuration?.passBindingTransaction ?? ''),
    `${relativeAttestationPath} has invalid launch or pending-admin configuration.`,
  );
  expectKeys(
    attestation.foundryReceipt,
    ['path', 'sha256'],
    ['path', 'sha256'],
    `${relativeAttestationPath} Foundry receipt`,
  );
  expect(
    /^[0-9a-f]{64}$/.test(attestation.foundryReceipt?.sha256 ?? ''),
    `${relativeAttestationPath} Foundry receipt digest is invalid.`,
  );
  const verificationKeys = [
    'compilerVersion',
    'optimizerRuns',
    'viaIR',
    'evmVersion',
    'foundryVersion',
  ];
  expectKeys(
    attestation.verification,
    verificationKeys,
    verificationKeys,
    `${relativeAttestationPath} verification`,
  );
  expect(
    attestation.verification?.compilerVersion === '0.8.36' &&
      attestation.verification?.optimizerRuns === 200 &&
      attestation.verification?.viaIR === true &&
      attestation.verification?.evmVersion === 'cancun' &&
      /(^|[^0-9])1\.7\.1([^0-9]|$)/.test(attestation.verification?.foundryVersion ?? ''),
    `${relativeAttestationPath} must record the pinned contract toolchain.`,
  );
  const receiptPath = attestation.foundryReceipt?.path;
  expect(
    receiptPath === 'packages/contracts/deployments/42161.json',
    `${relativeAttestationPath} must reference the fixed Arbitrum One Foundry receipt.`,
  );
  if (receiptPath !== 'packages/contracts/deployments/42161.json') continue;
  const absoluteReceiptPath = path.join(root, receiptPath);
  expect(
    fs.existsSync(absoluteReceiptPath),
    `${relativeAttestationPath} references a missing Foundry receipt.`,
  );
  if (!fs.existsSync(absoluteReceiptPath)) continue;
  const receiptSource = fs.readFileSync(absoluteReceiptPath, 'utf8');
  const receipt = JSON.parse(receiptSource);
  const receiptDigest = createHash('sha256').update(receiptSource).digest('hex');
  expect(
    attestation.foundryReceipt?.sha256 === receiptDigest,
    `${relativeAttestationPath} does not match the Foundry receipt SHA-256.`,
  );
  for (const [label, attested, recorded] of [
    ['repository commit', attestation.gitCommit, receipt.repositoryCommit],
    ['deployment block', attestation.deploymentBlock, receipt.deploymentBlock],
    ['deployment timestamp', attestation.deployedAt, receipt.deploymentTimestamp],
    ['settlement token', attestation.settlementToken, receipt.addresses?.usdc],
    ['checkout address', attestation.contracts?.checkout?.address, receipt.addresses?.checkout],
    ['pass address', attestation.contracts?.pass?.address, receipt.addresses?.pass],
    ['split address', attestation.contracts?.split?.address, receipt.addresses?.splitReimbursement],
    [
      'checkout deployment transaction',
      attestation.contracts?.checkout?.deploymentTransaction,
      receipt.transactions?.checkoutDeployment,
    ],
    [
      'pass deployment transaction',
      attestation.contracts?.pass?.deploymentTransaction,
      receipt.transactions?.passDeployment,
    ],
    [
      'split deployment transaction',
      attestation.contracts?.split?.deploymentTransaction,
      receipt.transactions?.splitDeployment,
    ],
    [
      'pass binding transaction',
      attestation.configuration?.passBindingTransaction,
      receipt.transactions?.passBinding,
    ],
    [
      'checkout runtime code hash',
      attestation.contracts?.checkout?.bytecodeHash,
      receipt.runtimeCodeHashes?.checkout,
    ],
    [
      'pass runtime code hash',
      attestation.contracts?.pass?.bytecodeHash,
      receipt.runtimeCodeHashes?.pass,
    ],
    [
      'split runtime code hash',
      attestation.contracts?.split?.bytecodeHash,
      receipt.runtimeCodeHashes?.splitReimbursement,
    ],
    ['compiler version', attestation.verification?.compilerVersion, receipt.compiler?.solc],
    ['optimizer runs', attestation.verification?.optimizerRuns, receipt.compiler?.optimizerRuns],
    ['via-IR setting', attestation.verification?.viaIR, receipt.compiler?.viaIR],
    ['EVM version', attestation.verification?.evmVersion, receipt.compiler?.evmVersion],
  ]) {
    expect(
      attested !== undefined && attested === recorded,
      `${relativeAttestationPath} ${label} disagrees with the Foundry receipt.`,
    );
  }
  expect(
    receipt.chainId === 42161 && receipt.network === 'arbitrum-one',
    `${receiptPath} must be an Arbitrum One receipt.`,
  );
  expect(
    receipt.verified?.checkout === true &&
      receipt.verified?.pass === true &&
      receipt.verified?.splitReimbursement === true,
    `${receiptPath} must record explorer verification for all three contracts.`,
  );
}

if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`ERROR ${failure}\n`);
  process.exit(1);
}

process.stdout.write('Release configuration checks passed.\n');
