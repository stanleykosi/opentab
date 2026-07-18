import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ParticleCertificationStatus } from '../../application/browser-api-client';
import type { BrowserApplicationService } from '../../application/browser-application-service';
import { ParticleCertificationConsole } from './particle-certification-console';

const owner = '0x1111111111111111111111111111111111111111';
const product = {
  id: `prd_${'0'.repeat(26)}`,
  merchantId: `mer_${'0'.repeat(26)}`,
  title: 'Payment activation',
  unitPriceBaseUnits: '100000',
  status: 'active',
  onchainProductId: '1',
};

function certificationStatus(
  stage: 'uncertified' | 'bootstrap' | 'canary_ready' | 'certified',
  capabilities: Partial<ParticleCertificationStatus['effectiveCapabilities']> = {},
): ParticleCertificationStatus {
  return {
    environment: 'production',
    profileScopeId: 'a'.repeat(40),
    chainId: '42161',
    captureConfig: {},
    certification:
      stage === 'uncertified'
        ? { stage, subjectMatches: false }
        : {
            stage,
            profileId: 'opentab-live-profile',
            profileDigest: `0x${'1'.repeat(64)}`,
            subjectMatches: true,
            canaryProductId: '1',
            canaryMaxBaseUnits: '100000',
            boundAt: '2026-07-18T20:00:00.000Z',
          },
    effectiveCapabilities: {
      captureBootstrap: false,
      captureCanaryPreview: false,
      runCanary: false,
      payments: false,
      ...capabilities,
    },
    requestId: `req_${stage}`,
  } as unknown as ParticleCertificationStatus;
}

function serviceFixture(initialStatus: ParticleCertificationStatus) {
  const methods = {
    restoreSession: vi.fn().mockResolvedValue(undefined),
    getWalletOwner: vi.fn().mockResolvedValue(owner),
    listParticleCertificationProducts: vi.fn().mockResolvedValue({
      items: [product],
      requestId: 'req_products',
    }),
    unlockParticleCertification: vi.fn().mockResolvedValue(initialStatus),
    captureParticleCertificationBootstrap: vi.fn(),
    captureParticleCertificationCanaryPreview: vi.fn(),
    runAndCertifyParticleCanary: vi.fn(),
    checkWalletReadiness: vi.fn().mockResolvedValue({ ready: true, blockers: [] }),
    getSponsorChallengeConfig: vi.fn().mockResolvedValue({}),
    evaluateWalletPreparation: vi.fn(),
    prepareWalletAccount: vi.fn(),
    prepareSelfFundedWalletAccount: vi.fn(),
    beginGoogleSignIn: vi.fn(),
    signInWithEmail: vi.fn(),
    bootstrapParticleCertificationCanary: vi.fn(),
  };
  return {
    methods,
    service: methods as unknown as BrowserApplicationService,
  };
}

async function unlockConsole(service: BrowserApplicationService) {
  render(<ParticleCertificationConsole service={service} />);
  fireEvent.change(await screen.findByLabelText(/Operator token/), {
    target: { value: 'o'.repeat(32) },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await screen.findByRole('heading', { name: 'Activate customer payments' });
  await waitFor(() => expect(screen.getByLabelText(/Activation item/)).toHaveValue(product.id));
}

describe('ParticleCertificationConsole', () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        clear: () => values.clear(),
        getItem: (key: string) => values.get(key) ?? null,
        key: (index: number) => [...values.keys()][index] ?? null,
        get length() {
          return values.size;
        },
        removeItem: (key: string) => {
          values.delete(key);
        },
        setItem: (key: string, value: string) => {
          values.set(key, value);
        },
      } satisfies Storage,
    });
  });

  it('uses server capabilities to keep preparation disabled when activation policy is closed', async () => {
    const { methods, service } = serviceFixture(certificationStatus('bootstrap'));

    await unlockConsole(service);

    expect(screen.getByRole('button', { name: 'Continue payment activation' })).toBeDisabled();
    expect(screen.getByText('Activation is temporarily paused')).toBeVisible();
    expect(methods.captureParticleCertificationBootstrap).not.toHaveBeenCalled();
    expect(methods.captureParticleCertificationCanaryPreview).not.toHaveBeenCalled();
  });

  it('advances bootstrap and bound preparation behind one resumable production action', async () => {
    const initial = certificationStatus('uncertified', { captureBootstrap: true });
    const bootstrap = certificationStatus('bootstrap', { captureCanaryPreview: true });
    const canaryReady = certificationStatus('canary_ready', { runCanary: true });
    const { methods, service } = serviceFixture(initial);
    methods.captureParticleCertificationBootstrap.mockResolvedValue(bootstrap);
    methods.captureParticleCertificationCanaryPreview.mockResolvedValue({
      status: canaryReady,
      checkoutSessionId: `chk_${'2'.repeat(26)}`,
      paymentAttemptId: `pay_${'3'.repeat(26)}`,
      preparedFixtureDigest: `0x${'4'.repeat(64)}`,
    });

    await unlockConsole(service);
    fireEvent.click(screen.getByRole('button', { name: 'Continue payment activation' }));

    expect(await screen.findByText('Account ready')).toBeVisible();
    expect(methods.captureParticleCertificationBootstrap).toHaveBeenCalledOnce();
    expect(methods.captureParticleCertificationCanaryPreview).toHaveBeenCalledOnce();
    const bootstrapCall = methods.captureParticleCertificationBootstrap.mock.invocationCallOrder[0];
    const preparationCall =
      methods.captureParticleCertificationCanaryPreview.mock.invocationCallOrder[0];
    expect(bootstrapCall).toBeDefined();
    expect(preparationCall).toBeDefined();
    if (bootstrapCall === undefined || preparationCall === undefined) return;
    expect(bootstrapCall).toBeLessThan(preparationCall);
    expect(screen.getByRole('button', { name: 'Confirm activation payment' })).toBeEnabled();
  });

  it('recovers the durable server attempt and never asks for another preparation', async () => {
    const canaryReady = certificationStatus('canary_ready', { runCanary: true });
    const certified = certificationStatus('certified', { payments: true });
    const reference = {
      checkoutSessionId: `chk_${'5'.repeat(26)}`,
      paymentAttemptId: `pay_${'6'.repeat(26)}`,
      preparedFixtureDigest: `0x${'7'.repeat(64)}`,
    };
    const { methods, service } = serviceFixture(canaryReady);
    methods.captureParticleCertificationCanaryPreview.mockResolvedValue({
      status: canaryReady,
      ...reference,
    });
    methods.runAndCertifyParticleCanary.mockResolvedValue(certified);

    await unlockConsole(service);
    expect(await screen.findByText('Account ready')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Continue payment activation' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm activation payment' }));
    await screen.findByText('Customer payments are active');

    expect(methods.runAndCertifyParticleCanary).toHaveBeenCalledWith(
      expect.objectContaining({
        checkoutSessionId: reference.checkoutSessionId,
        expectedPaymentAttemptId: reference.paymentAttemptId,
      }),
    );
    expect(methods.captureParticleCertificationCanaryPreview).toHaveBeenCalledOnce();
  });
});
