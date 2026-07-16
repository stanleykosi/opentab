import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createLiveAcceptanceReceipt,
  digestLiveAcceptanceDeploymentConfig,
  digestLiveAcceptanceFile,
  digestUnknown,
  LiveAcceptanceArtifactSchema,
  serializeLiveAcceptanceArtifact,
} from '@opentab/shared';
import { describe, expect, it } from 'vitest';
import {
  createLiveAcceptanceDependencies,
  createLiveRunCompletion,
  ensureProtectedEvidenceFile,
  LIVE_ACCEPTANCE_RETIRE_CONFIRMATION,
  type ManagedLiveAcceptanceDependencies,
  parseCredentialFreeCdpUrl,
  promotePendingLiveEvidence,
  releaseLiveAcceptanceRun,
  reserveLiveAcceptanceRun,
  resolveProtectedEvidencePath,
  retireLiveRunCompletion,
  runManagedLiveAcceptance,
  serializeLiveRunCompletion,
  updateLiveAcceptanceRun,
  verifyLiveRunCompletion,
  writeProtectedEvidenceFileExclusive,
} from '../src/live-driver.js';

const root = path.resolve(import.meta.dirname, '..', '..', '..');
const evidenceDirectory = path.join(root, 'artifacts', 'autonomous-build', 'evidence');
const receiptSecret = 'acceptance-receipt-test-secret-over-32-bytes';
const releaseId = 'b'.repeat(40);

function liveScope(applicationReleaseId = releaseId) {
  const deployment = {
    domain: 'opentab/live-acceptance-deployment-config' as const,
    releaseId: applicationReleaseId,
    environment: 'demo-mainnet' as const,
    chainId: '42161' as const,
    checkoutAddress: `0x${'11'.repeat(20)}`,
    passAddress: `0x${'22'.repeat(20)}`,
    tokenAddress: `0x${'33'.repeat(20)}`,
    expectedDelegationImplementation: `0x${'44'.repeat(20)}`,
    expectedDelegationCodeHash: `0x${'55'.repeat(32)}`,
    particleSdkVersion: '2.0.3' as const,
    particleResponseProfileId: 'particle-2.0.3-live-v1',
    particleFixtureSetDigest: `0x${'66'.repeat(32)}`,
    particleSourceCallProfilesDigest: `0x${'77'.repeat(32)}`,
    confirmationDepth: '2',
    maximumSlippageBps: '100',
    allowedSourceChainIds: ['8453'],
    allowedSourceAssets: ['USDC' as const],
  };
  return {
    domain: 'opentab/live-acceptance-run' as const,
    environment: deployment.environment,
    chainId: deployment.chainId,
    productId: 'prd_01J00000000000000000000000',
    sourceChainId: '8453',
    checkoutAddress: deployment.checkoutAddress,
    passAddress: deployment.passAddress,
    tokenAddress: deployment.tokenAddress,
    expectedDelegationImplementation: deployment.expectedDelegationImplementation,
    expectedDelegationCodeHash: deployment.expectedDelegationCodeHash,
    applicationReleaseId,
    particleSdkVersion: deployment.particleSdkVersion,
    particleResponseProfileId: deployment.particleResponseProfileId,
    particleFixtureSetDigest: deployment.particleFixtureSetDigest,
    particleSourceCallProfilesDigest: deployment.particleSourceCallProfilesDigest,
    deploymentConfigDigest: digestLiveAcceptanceDeploymentConfig(deployment),
    confirmationDepth: deployment.confirmationDepth,
    maximumSlippageBps: deployment.maximumSlippageBps,
    allowedSourceChainIds: deployment.allowedSourceChainIds,
    allowedSourceAssets: deployment.allowedSourceAssets,
  };
}

describe('in-repository protected live driver', () => {
  it('fails before opening a browser or database when live authorization is absent', async () => {
    await expect(createLiveAcceptanceDependencies({})).rejects.toThrow(/^EXTERNAL_BLOCKER:/);
  });

  it('allows only credential-free encrypted CDP endpoints from non-secret CI variables', () => {
    expect(parseCredentialFreeCdpUrl('https://browser.example/devtools/browser/session')).toBe(
      'https://browser.example/devtools/browser/session',
    );
    expect(parseCredentialFreeCdpUrl('wss://browser.example/devtools/browser/session')).toBe(
      'wss://browser.example/devtools/browser/session',
    );
    for (const endpoint of [
      'http://browser.example:9222',
      'ws://browser.example/devtools/browser/session',
      'https://user:password@browser.example/devtools/browser/session',
      'https://browser.example/devtools/browser/session?token=secret',
      'wss://browser.example/devtools/browser/session#token',
    ]) {
      expect(() => parseCredentialFreeCdpUrl(endpoint)).toThrow(/credential-free HTTPS or WSS/);
    }
  });

  it('writes protected evidence exclusively and refuses symlinks or nested escapes', () => {
    const suffix = randomUUID();
    const relativeTarget = path.join(
      'artifacts',
      'autonomous-build',
      'evidence',
      `driver-path-${suffix}.json`,
    );
    const target = resolveProtectedEvidencePath(relativeTarget);
    writeProtectedEvidenceFileExclusive(target, '{"safe":true}\n');
    try {
      expect(fs.readFileSync(target, 'utf8')).toBe('{"safe":true}\n');
      if (process.platform !== 'win32') {
        expect(fs.statSync(target).mode & 0o077).toBe(0);
      }
      expect(() => writeProtectedEvidenceFileExclusive(target, '{}\n')).toThrow();
    } finally {
      fs.rmSync(target, { force: true });
    }

    const symlink = path.join(evidenceDirectory, `driver-symlink-${suffix}.json`);
    fs.symlinkSync(path.join(root, `outside-${suffix}.json`), symlink);
    try {
      expect(() => writeProtectedEvidenceFileExclusive(symlink, '{}\n')).toThrow();
    } finally {
      fs.rmSync(symlink, { force: true });
    }

    expect(() =>
      resolveProtectedEvidencePath(
        path.join('artifacts', 'autonomous-build', 'evidence', 'nested', `${suffix}.json`),
      ),
    ).toThrow(/protected evidence directory/);
  });

  it('uses one stable scope journal across a real child-process restart', () => {
    const suffix = randomUUID();
    const scope = liveScope(`${suffix.replaceAll('-', '')}00000000`);
    const parentArtifact = path.join(
      'artifacts',
      'autonomous-build',
      'evidence',
      `child-restart-parent-${suffix}.json`,
    );
    const parent = reserveLiveAcceptanceRun({ scope, artifactTarget: parentArtifact });
    expect(parent.status).toBe('reserved');
    const checkout = {
      orderId: 'ord_01J00000000000000000000010',
      attemptId: 'pay_01J00000000000000000000010',
      orderKey: `0x${'a1'.repeat(32)}`,
      ownerAddress: `0x${'aa'.repeat(20)}`,
      recipientAddress: `0x${'aa'.repeat(20)}`,
      checkoutAddress: scope.checkoutAddress,
      tokenAddress: scope.tokenAddress,
      merchantOnchainId: '1',
      productOnchainId: '1',
      amountBaseUnits: '10000',
      platformFeeBaseUnits: '100',
      quantity: '1',
      intentDigest: `0x${'a2'.repeat(32)}`,
      refundDeadline: '1900000000',
      bindingDigest: `0x${'a3'.repeat(32)}`,
    };
    const prepared = {
      providerOperationId: 'particle-restart-operation-1',
      ownerAddress: checkout.ownerAddress,
      chainId: '42161' as const,
      checkoutAddress: scope.checkoutAddress,
      tokenAddress: scope.tokenAddress,
      amountBaseUnits: checkout.amountBaseUnits,
      exactCallTemplateVerified: true as const,
      sources: [
        {
          chainId: scope.sourceChainId,
          symbol: 'USDC' as const,
          amount: '0.01',
          amountUsd: '0.01',
        },
      ],
      totalUsd: '0.011',
      estimatedFeeUsd: '0.001',
      slippageBps: '100',
      quotedAt: '2026-07-14T12:00:00.000Z',
      expiresAt: '2030-07-14T12:05:00.000Z',
      previewDigest: `0x${'a4'.repeat(32)}`,
      preparedEvidenceDigest: `0x${'a5'.repeat(32)}`,
      activityUrl: 'https://universalx.app/activity/details?id=particle-restart-operation-1',
    };
    const submissionStartedAt = new Date(
      new Date(parent.journal.startedAt).getTime() + 1_000,
    ).toISOString();
    updateLiveAcceptanceRun(parent.path, parent.journal.runId, (current) => ({
      ...current,
      stage: 'submission_started',
      updatedAt: submissionStartedAt,
      submissionStartedAt,
      checkout,
      context: {
        ownerAddress: checkout.ownerAddress,
        authMethod: 'google',
        activationPath: 'self_funded_type4',
        delegationTransactionHash: `0x${'a6'.repeat(32)}`,
        particleProtocolVersion: '2.0.3',
        checkout,
        prepared,
      },
    }));
    const moduleUrl = pathToFileURL(
      path.join(root, 'spikes', 'cross-chain-checkout', 'src', 'live-driver.ts'),
    ).href;
    const script = `
      import { reserveLiveAcceptanceRun } from ${JSON.stringify(moduleUrl)};
      const scope = JSON.parse(process.env.OPENTAB_TEST_SCOPE);
      const result = reserveLiveAcceptanceRun({
        scope,
        artifactTarget: process.env.OPENTAB_TEST_ARTIFACT,
        now: new Date('2030-01-01T00:00:00.000Z')
      });
      process.stdout.write(JSON.stringify({
        status: result.status,
        stage: result.journal.stage,
        runId: result.journal.runId,
        artifactFileName: result.journal.artifactFileName,
        providerOperationId: result.journal.context?.prepared.providerOperationId
      }));
    `;
    try {
      const output = execFileSync(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '--eval', script],
        {
          cwd: root,
          encoding: 'utf8',
          env: {
            ...process.env,
            OPENTAB_TEST_SCOPE: JSON.stringify(scope),
            OPENTAB_TEST_ARTIFACT: path.join(
              'artifacts',
              'autonomous-build',
              'evidence',
              `child-restart-second-${suffix}.json`,
            ),
          },
        },
      );
      expect(JSON.parse(output)).toEqual({
        status: 'recovery_required',
        stage: 'submission_started',
        runId: parent.journal.runId,
        artifactFileName: path.basename(parentArtifact),
        providerOperationId: prepared.providerOperationId,
      });
      expect(
        fs.existsSync(
          resolveProtectedEvidencePath(
            path.join(
              'artifacts',
              'autonomous-build',
              'evidence',
              `child-restart-second-${suffix}.json`,
            ),
          ),
        ),
      ).toBe(false);
    } finally {
      releaseLiveAcceptanceRun(parent.path, parent.journal.runId);
    }
  }, 30_000);

  it('keeps exact recovery inputs until an accepted pending artifact is promoted', async () => {
    const suffix = randomUUID();
    const pending = resolveProtectedEvidencePath(
      path.join(
        'artifacts',
        'autonomous-build',
        'evidence',
        `live-recovery-${suffix}.pending.json`,
      ),
    );
    const ingestion = pending.replace(/\.pending\.json$/, '.ingest.json');
    const target = pending.replace(/\.pending\.json$/, '.json');
    const acceptedReceipt = pending.replace(/\.pending\.json$/, '.accepted.json');
    const ingestionContent = '{"exact":"attested-input"}\n';
    const artifact = {
      status: 'LIVE_ACCEPTANCE_EVIDENCED',
      schemaVersion: 1,
      environment: 'demo-mainnet',
      releaseId,
      deploymentConfigDigest: liveScope().deploymentConfigDigest,
      orderId: 'ord_01J00000000000000000000000',
      paymentAttemptId: 'pay_01J00000000000000000000000',
      startedAt: '2026-07-14T12:00:00.000Z',
      capturedAt: '2026-07-14T12:02:00.000Z',
      ownerAddressBefore: `0x${'11'.repeat(20)}`,
      ownerAddressAfter: `0x${'11'.repeat(20)}`,
      authMethod: 'google',
      activationPath: 'self_funded_type4',
      delegationTransactionHash: `0x${'22'.repeat(32)}`,
      providerOperation: {
        id: 'particle-operation-1',
        status: 'succeeded',
        submissionPossible: true,
        destinationTransactionHash: `0x${'33'.repeat(32)}`,
        activityUrl: 'https://universalx.app/activity/details?id=particle-operation-1',
        updatedAt: '2026-07-14T12:01:00.000Z',
        evidence: {
          adapter: 'particle-get-transaction',
          packageVersion: '2.0.3',
          schemaVersion: 1,
          environment: 'demo-mainnet',
          observedAt: '2026-07-14T12:01:00.000Z',
          evidenceDigest: `0x${'44'.repeat(32)}`,
          provenance: 'recorded_live',
        },
      },
      particle: {
        protocolVersion: '2.0.3',
        useEIP7702: true,
        safeAccountIdentifiers: [`0x${'11'.repeat(20)}`],
        providerOperationId: 'particle-operation-1',
        activityUrl: 'https://universalx.app/activity/details?id=particle-operation-1',
        sources: [{ chainId: '8453', symbol: 'USDC', amount: '0.01', amountUsd: '0.01' }],
        totalUsd: '0.011',
        estimatedFeeUsd: '0.001',
        slippageBps: '100',
        quotedAt: '2026-07-14T12:00:10.000Z',
        expiresAt: '2026-07-14T12:05:10.000Z',
        previewDigest: `0x${'55'.repeat(32)}`,
      },
      arbitrum: {
        event: {
          eventName: 'OrderPaid',
          chainId: '42161',
          contractAddress: liveScope().checkoutAddress,
          transactionHash: `0x${'33'.repeat(32)}`,
          blockNumber: '1',
          blockHash: `0x${'77'.repeat(32)}`,
          logIndex: '0',
          confirmations: '2',
          canonical: true,
          observedAt: '2026-07-14T12:01:30.000Z',
          fields: {
            orderKey: `0x${'88'.repeat(32)}`,
            merchantOnchainId: '1',
            productOnchainId: '1',
            payer: `0x${'11'.repeat(20)}`,
            recipient: `0x${'11'.repeat(20)}`,
            token: liveScope().tokenAddress,
            quantity: '1',
            amountBaseUnits: '10000',
            platformFeeBaseUnits: '100',
            intentDigest: `0x${'aa'.repeat(32)}`,
            passTokenId: '1',
            refundDeadline: '1784034300',
          },
        },
        receiptId: 'rcp_01J00000000000000000000000',
        passTokenId: '1',
      },
      recovery: {
        providerOperationId: 'particle-operation-1',
        finalOrderStatus: 'paid',
        sponsorGrantCount: 0,
        delegationCount: 1,
        orderCount: 1,
        paymentAttemptCount: 1,
        providerOperationCount: 1,
        submissionCount: 1,
        receiptCount: 1,
        browserReloadObserved: true,
        observedAt: '2026-07-14T12:01:45.000Z',
      },
      timingMs: { payment: 1 },
    } as const;
    const pendingContent = serializeLiveAcceptanceArtifact(artifact);
    expect(() =>
      serializeLiveAcceptanceArtifact({ ...artifact, delegationTransactionHash: undefined }),
    ).toThrow();
    expect(() =>
      serializeLiveAcceptanceArtifact({
        ...artifact,
        sponsorGrantTransactionHash: `0x${'23'.repeat(32)}`,
      }),
    ).toThrow(/Sponsor evidence/);
    expect(() =>
      serializeLiveAcceptanceArtifact({
        ...artifact,
        particle: {
          ...artifact.particle,
          safeAccountIdentifiers: [`0x${'12'.repeat(20)}`],
        },
      }),
    ).toThrow(/continuity/);
    expect(() =>
      serializeLiveAcceptanceArtifact({ ...artifact, restoredMagicSession: true }),
    ).toThrow();
    writeProtectedEvidenceFileExclusive(ingestion, ingestionContent);
    writeProtectedEvidenceFileExclusive(pending, pendingContent);

    expect(fs.existsSync(ingestion)).toBe(true);
    expect(fs.existsSync(pending)).toBe(true);
    expect(fs.existsSync(target)).toBe(false);
    expect(() => promotePendingLiveEvidence(pending, receiptSecret)).toThrow();
    expect(fs.existsSync(pending)).toBe(true);
    const accepted = createLiveAcceptanceReceipt(receiptSecret, {
      schemaVersion: 1,
      status: 'accepted',
      evidenceId: '018f0000-0000-7000-8000-000000000001',
      releaseId,
      deploymentConfigDigest: artifact.deploymentConfigDigest,
      orderId: 'ord_01J00000000000000000000000',
      paymentAttemptId: 'pay_01J00000000000000000000000',
      providerOperationId: 'particle-operation-1',
      payloadDigest: `0x${'ab'.repeat(32)}`,
      ingestionFileDigest: digestLiveAcceptanceFile(ingestionContent),
      artifactFileDigest: digestLiveAcceptanceFile(pendingContent),
      acceptedAt: '2026-07-14T12:00:00.000Z',
    });
    const acceptedReceiptContent = `${JSON.stringify(accepted)}\n`;
    const completionScope = liveScope();
    const completion = createLiveRunCompletion(receiptSecret, {
      schemaVersion: 1 as const,
      domain: 'opentab/live-acceptance-completion' as const,
      scopeDigest: digestUnknown(completionScope),
      scope: completionScope,
      runId: '018f0000-0000-7000-8000-000000000002',
      startedAt: artifact.startedAt,
      artifactFileName: path.basename(target),
      artifactFileDigest: digestLiveAcceptanceFile(pendingContent),
      orderId: artifact.orderId,
      paymentAttemptId: artifact.paymentAttemptId,
      providerOperationId: artifact.particle.providerOperationId,
      evidenceId: accepted.evidenceId,
      payloadDigest: accepted.payloadDigest,
      completedAt: accepted.acceptedAt,
      receipt: accepted,
    });
    expect(() => serializeLiveRunCompletion(completion)).not.toThrow();
    const wrongReleaseScope = liveScope('c'.repeat(40));
    expect(() =>
      verifyLiveRunCompletion(receiptSecret, {
        ...completion,
        scope: wrongReleaseScope,
        scopeDigest: digestUnknown(wrongReleaseScope),
      }),
    ).toThrow(/binding/);
    const wrongSourceScope = { ...completionScope, sourceChainId: '10' };
    expect(() =>
      verifyLiveRunCompletion(receiptSecret, {
        ...completion,
        scope: wrongSourceScope,
        scopeDigest: digestUnknown(wrongSourceScope),
      }),
    ).toThrow(/MAC/);
    writeProtectedEvidenceFileExclusive(acceptedReceipt, acceptedReceiptContent);

    fs.writeFileSync(
      pending,
      serializeLiveAcceptanceArtifact({
        ...artifact,
        particle: { ...artifact.particle, totalUsd: '9.99' },
      }),
    );
    expect(() => promotePendingLiveEvidence(pending, receiptSecret)).toThrow(
      /accepted receipt does not match/,
    );
    fs.writeFileSync(pending, `${JSON.stringify({ ...artifact, oauthToken: 'must-not-leak' })}\n`);
    expect(() => promotePendingLiveEvidence(pending, receiptSecret)).toThrow();
    fs.writeFileSync(pending, pendingContent);
    fs.writeFileSync(acceptedReceipt, acceptedReceiptContent);
    expect(
      promotePendingLiveEvidence(pending, receiptSecret, { retainAcceptedReceipt: true }),
    ).toBe(target);
    try {
      expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toMatchObject({
        status: 'LIVE_ACCEPTANCE_EVIDENCED',
      });
      expect(fs.existsSync(ingestion)).toBe(false);
      expect(fs.existsSync(pending)).toBe(false);
      expect(fs.existsSync(acceptedReceipt)).toBe(true);
      const completionPath = resolveProtectedEvidencePath(
        path.join(
          'artifacts',
          'autonomous-build',
          'evidence',
          `completion-retire-${suffix}.complete.json`,
        ),
      );
      writeProtectedEvidenceFileExclusive(completionPath, serializeLiveRunCompletion(completion));
      expect(() =>
        retireLiveRunCompletion({
          path: completionPath,
          receiptSecret,
          confirmation: 'not-reviewed',
        }),
      ).toThrow(/confirmation/);
      expect(fs.existsSync(completionPath)).toBe(true);
      expect(
        retireLiveRunCompletion({
          path: completionPath,
          receiptSecret,
          confirmation: LIVE_ACCEPTANCE_RETIRE_CONFIRMATION,
        }),
      ).toMatchObject({ artifactFileName: path.basename(target) });
      expect(fs.existsSync(completionPath)).toBe(false);
      ensureProtectedEvidenceFile(ingestion, ingestionContent);
      ensureProtectedEvidenceFile(pending, pendingContent);
      expect(
        promotePendingLiveEvidence(pending, receiptSecret, { retainAcceptedReceipt: true }),
      ).toBe(target);
      expect(fs.existsSync(target)).toBe(true);
      expect(fs.existsSync(acceptedReceipt)).toBe(true);

      let normalCalls = 0;
      let recoveryCalls = 0;
      const normalPath = async (): Promise<never> => {
        normalCalls += 1;
        throw new Error('normal live path must not run');
      };
      const managed = {
        recoveryMode: true,
        acceptanceStartedAt: artifact.startedAt,
        acceptanceDeploymentConfigDigest: artifact.deploymentConfigDigest,
        authenticateAndExchangeMagicProof: normalPath,
        signMagicAddressChallenge: normalPath,
        inspectEip7702Readiness: normalPath,
        activateDelegation: normalPath,
        verifyDelegationOnchain: normalPath,
        initializeParticleEip7702: normalPath,
        readPreflightBalances: normalPath,
        assertDelegatedPassReceiver: normalPath,
        createServerBoundCheckout: normalPath,
        prepareAndValidateParticleOperation: normalPath,
        signParticleRoot: normalPath,
        persistProviderOperationBeforeSubmission: normalPath,
        submitParticleOperationOnce: normalPath,
        awaitCanonicalArbitrumPayment: normalPath,
        readFinalProviderOperation: normalPath,
        reloadAndReconcile: normalPath,
        persistSanitizedEvidence: normalPath,
        async resumeInterruptedAcceptance() {
          recoveryCalls += 1;
          return LiveAcceptanceArtifactSchema.parse(artifact);
        },
        async close() {},
      } satisfies ManagedLiveAcceptanceDependencies;
      expect(await runManagedLiveAcceptance({}, managed)).toEqual(artifact);
      expect(recoveryCalls).toBe(1);
      expect(normalCalls).toBe(0);
    } finally {
      fs.rmSync(target, { force: true });
      fs.rmSync(ingestion, { force: true });
      fs.rmSync(pending, { force: true });
      fs.rmSync(acceptedReceipt, { force: true });
    }
  });
});
