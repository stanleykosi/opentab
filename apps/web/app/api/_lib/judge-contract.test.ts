import type {
  BackendApiCommandPort,
  BackendApiQueryPort,
  BackendApiResourceQueryPort,
} from '@opentab/application';
import { PublicJudgeProofSchema } from '@opentab/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { getJudgeProof } from './endpoints-split.js';
import {
  type BackendApiRegistry,
  installBackendApiRegistry,
  resetBackendApiRegistryForTests,
} from './registry.js';

function callableProxy<T extends object>(overrides: Partial<T> = {}): T {
  return new Proxy(overrides, {
    get: (target, property) => Reflect.get(target, property) ?? (async () => ({})),
  }) as T;
}

const orderId = `ord_01J00000000000000000000000`;
const proof = PublicJudgeProofSchema.parse({
  evidenceId: 'evd_01J00000000000000000000000',
  orderId,
  provenance: 'recorded_live',
  environment: 'demo-mainnet',
  capturedAt: '2026-07-14T12:00:10.000Z',
  refreshedAt: '2026-07-14T12:00:10.000Z',
  versions: {
    application: '1.0.0',
    particleSdk: '2.0.3',
    magicSdk: '33.9.0',
    contracts: '1.0.0',
  },
  account: {
    magicEoaBefore: `0x${'1'.repeat(40)}`,
    magicEoaAfter: `0x${'1'.repeat(40)}`,
    addressContinuous: true,
    continuityEvidence: 'evidenced',
    authMethod: 'google',
    delegationTarget: `0x${'2'.repeat(40)}`,
    delegationTransactionHash: `0x${'3'.repeat(64)}`,
  },
  particle: {
    eip7702Enabled: true,
    eip7702Evidence: 'evidenced',
    universalAccountAddress: `0x${'1'.repeat(40)}`,
    routeEvidence: 'evidenced',
    totalUsd: '0.011',
    sourceSummary: [{ chainId: '8453', symbol: 'USDC', amount: '0.01', amountUsd: '0.01' }],
    estimatedFeeUsd: '0.001',
    slippageBps: '100',
    quoteObservedAt: '2026-07-14T11:59:00.000Z',
    previewDigest: `0x${'4'.repeat(64)}`,
    operationId: 'particle-operation-1',
    activityUrl: 'https://universalx.app/activity/details?id=particle-operation-1',
  },
  settlement: {
    chainId: '42161',
    checkoutAddress: `0x${'5'.repeat(40)}`,
    passAddress: `0x${'6'.repeat(40)}`,
    tokenAddress: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    amountBaseUnits: '10000',
    receiptId: 'rcp_01J00000000000000000000000',
    passTokenId: '42',
    event: {
      eventName: 'OrderPaid',
      chainId: '42161',
      contractAddress: `0x${'5'.repeat(40)}`,
      transactionHash: `0x${'7'.repeat(64)}`,
      blockNumber: '100',
      blockHash: `0x${'8'.repeat(64)}`,
      logIndex: '3',
      confirmations: '12',
      canonical: true,
      observedAt: '2026-07-14T12:00:00.000Z',
      fields: {
        orderKey: `0x${'9'.repeat(64)}`,
        merchantOnchainId: '1',
        productOnchainId: '2',
        payer: `0x${'1'.repeat(40)}`,
        recipient: `0x${'1'.repeat(40)}`,
        token: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
        quantity: '1',
        amountBaseUnits: '10000',
        platformFeeBaseUnits: '100',
        intentDigest: `0x${'a'.repeat(64)}`,
        passTokenId: '42',
        refundDeadline: '1784034300',
      },
    },
  },
  recovery: {
    submissionPersistedBeforeWait: true,
    submissionPersistenceEvidence: 'evidenced',
    reloadRecovered: true,
    reloadRecoveryEvidence: 'evidenced',
    duplicatePrevented: true,
    duplicatePreventionEvidence: 'evidenced',
    timing: { totalDurationMs: '10000' },
  },
});

function judgeQueryMock() {
  return vi.fn<BackendApiQueryPort['getJudgeProof']>(async () => proof);
}

function install(query: BackendApiQueryPort['getJudgeProof']): void {
  installBackendApiRegistry({
    sessions: callableProxy<BackendApiRegistry['sessions']>(),
    authContinuations: callableProxy<BackendApiRegistry['authContinuations']>(),
    exchangeSession: callableProxy<BackendApiRegistry['exchangeSession']>(),
    refreshSession: callableProxy<BackendApiRegistry['refreshSession']>(),
    logoutSession: callableProxy<BackendApiRegistry['logoutSession']>(),
    queries: callableProxy<BackendApiQueryPort>({ getJudgeProof: query }),
    resourceQueries: callableProxy<BackendApiResourceQueryPort>(),
    commands: callableProxy<BackendApiCommandPort>(),
    featureFlags: { enabled: async () => true },
    rateLimits: { consume: async () => ({ allowed: true }) },
    requestLog: { info: vi.fn(), error: vi.fn() },
    allowedOrigin: 'https://opentab.example',
    sessionCookieName: '__Host-opentab_session',
    authContinuationCookieName: '__Host-opentab_auth_state',
    sessionCookieSecure: true,
    digestSecret: () => 'a'.repeat(64),
    networkSubject: () => '198.51.100.10',
  });
}

describe('Judge proof HTTP contract', () => {
  beforeEach(() => resetBackendApiRegistryForTests());

  it('uses the optional header capability and returns the shared proof envelope', async () => {
    const query = judgeQueryMock();
    install(query);
    const token = 'a'.repeat(43);
    const response = await getJudgeProof(
      new Request(`https://opentab.example/api/v1/judge/orders/${orderId}/proof`, {
        headers: { 'X-OpenTab-Judge-Token': token },
      }),
      { params: Promise.resolve({ orderId }) },
    );
    expect(response.status).toBe(200);
    expect(query).toHaveBeenCalledWith(orderId, token);
    expect(
      z
        .object({ proof: PublicJudgeProofSchema, requestId: z.string().startsWith('req_') })
        .strict()
        .parse(await response.json()).proof,
    ).toEqual(proof);
  });

  it.each([
    'shareToken',
    'proof',
    'token',
    'judgeCapability',
    'utm_source',
  ])('rejects the %s query string before reading evidence', async (key) => {
    const query = judgeQueryMock();
    install(query);
    const response = await getJudgeProof(
      new Request(
        `https://opentab.example/api/v1/judge/orders/${orderId}/proof?${key}=${'a'.repeat(43)}`,
      ),
      { params: Promise.resolve({ orderId }) },
    );
    expect(response.status).toBe(422);
    expect(query).not.toHaveBeenCalled();
  });
});
