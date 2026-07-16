import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CheckoutSnapshotView } from '../../client/view-models';
import { CheckoutWorkflow, type LiveCheckoutActions } from './checkout-workflow';
import { LiveCheckoutPage } from './live-checkout-page';

const snapshot: CheckoutSnapshotView = {
  checkoutSessionId: 'chk_live_http_checkout',
  supportReference: 'HTTPCHECK01',
  state: 'product_ready',
  product: {
    id: 'prd_live_http_offer',
    slug: 'rooftop-supper',
    merchant: {
      id: 'mer_live_http',
      slug: 'http-merchant',
      displayName: 'HTTP Merchant',
      monogram: 'HM',
      supportContact: 'support@example.com',
      verified: true,
    },
    title: 'Live-only Rooftop Supper',
    description: 'A live offer returned by the browser application boundary.',
    category: 'Experience',
    imagePath: '/images/sunday-table.svg',
    imageAlt: 'Rooftop supper',
    unitPriceBaseUnits: '18000000',
    currency: 'USDC',
    maxPerOrder: '4',
    availability: { state: 'available' },
    availabilityCheckedAt: '2026-07-14T01:00:00.000Z',
    projectionStale: false,
    refundTerms: 'Refundable for one day after payment.',
    startsAt: '2027-08-02T12:00:00.000Z',
    location: 'Provided by merchant',
    loyaltyPoints: '180',
  },
  quantity: '1',
  submissionPossible: false,
  updatedAt: '2026-07-14T01:00:00.000Z',
};

function liveCheckoutResponse() {
  const zeroId = '0'.repeat(26);
  const digest = `0x${'1'.repeat(64)}`;
  return {
    session: {
      id: `chk_${zeroId}`,
      productId: `prd_${zeroId}`,
      productVersion: '1',
      quantity: '1',
      amountBaseUnits: '18000000',
      orderKey: digest,
      status: 'active',
      expiresAt: '2027-07-14T02:00:00.000Z',
      createdAt: '2026-07-14T01:00:00.000Z',
      updatedAt: '2026-07-14T01:00:00.000Z',
    },
    product: {
      id: `prd_${zeroId}`,
      merchantId: `mer_${zeroId}`,
      version: '1',
      slug: 'rooftop-supper',
      title: 'Live-only Rooftop Supper',
      description: 'Loaded over the concrete checkout HTTP API.',
      unitPriceBaseUnits: '18000000',
      sold: '0',
      maxPerOrder: '4',
      startsAt: '2027-08-02T12:00:00.000Z',
      refundWindowSeconds: '86400',
      loyaltyPoints: '180',
      metadataHash: digest,
      status: 'active',
      createdAt: '2026-07-14T01:00:00.000Z',
      updatedAt: '2026-07-14T01:00:00.000Z',
    },
    merchant: {
      id: `mer_${zeroId}`,
      ownerUserId: `usr_${zeroId}`,
      slug: 'http-merchant',
      displayName: 'HTTP Merchant',
      supportContact: 'support@example.com',
      payoutAddress: '0x1111111111111111111111111111111111111111',
      status: 'active',
      createdAt: '2026-07-14T01:00:00.000Z',
      updatedAt: '2026-07-14T01:00:00.000Z',
    },
    requestId: 'req_checkout_http_test',
  };
}

describe('live checkout boundary', () => {
  it('renders the HTTP checkout record and never substitutes deterministic catalog data', async () => {
    const getCheckout = vi.fn(async () => liveCheckoutResponse());
    const service = {
      getCheckout,
      getPaymentWorkflow: vi.fn(),
      getSponsorChallengeConfig: vi.fn(async () => ({ siteKey: 'turnstile-test-site-key' })),
      beginGoogleSignIn: vi.fn(),
      bindCheckout: vi.fn(),
      checkWalletReadiness: vi.fn(),
      loadUnifiedBalance: vi.fn(),
      pollPaymentAttempt: vi.fn(),
      prepareCheckoutPayment: vi.fn(),
      prepareWalletAccount: vi.fn(),
      restoreSession: vi.fn(),
      signInWithEmail: vi.fn(),
      submitCheckoutPayment: vi.fn(),
    };

    render(
      <LiveCheckoutPage checkoutSessionId={`chk_${'0'.repeat(26)}`} service={service as never} />,
    );

    expect(await screen.findByText('Live-only Rooftop Supper')).toBeVisible();
    expect(screen.getByText('HTTP Merchant')).toBeVisible();
    expect(screen.queryByText('Sunday Table')).not.toBeInTheDocument();
    expect(screen.queryByText('Deterministic demo')).not.toBeInTheDocument();
    expect(getCheckout).toHaveBeenCalledWith(`chk_${'0'.repeat(26)}`);
  });

  it('drives the complete live UI from injected service effects and confirms only canonical proof', async () => {
    const finalProof = {
      eventName: 'OrderPaid' as const,
      canonical: true as const,
      confirmations: '3',
      requiredConfirmations: '2',
      transactionHash: `0x${'2'.repeat(64)}`,
      blockNumber: '351204118',
      observedAt: '2026-07-14T01:05:00.000Z',
    };
    const actions: LiveCheckoutActions = {
      restoreAndBind: vi.fn(async () => false),
      checkReadiness: vi.fn(async () => false),
      checkSponsorEligibility: vi.fn(async () => ({ grantRequired: true })),
      prepareAccount: vi.fn(async () => undefined),
      loadBalance: vi.fn(async (current) => ({
        ...current,
        state: 'ready_to_pay',
        balanceUsd: '64.28',
      })),
      preparePayment: vi.fn(async (current) => ({
        ...current,
        orderId: 'ord_live_http_order',
        state: 'preview_ready',
        quote: {
          productBaseUnits: '18000000',
          estimatedFeeUsd: '0.14',
          maximumTotalUsd: '18.14',
          availableUsd: '64.28',
          expiresAt: '2027-07-14T02:00:00.000Z',
          slippageLabel: 'Maximum route movement 0.5%',
          sources: [
            {
              id: '42161-USDC-0',
              label: 'Network 42161',
              symbol: 'USDC',
              amount: '18.14',
              amountUsd: '18.14',
            },
          ],
        },
      })),
      submitPayment: vi.fn(async (current) => ({
        snapshot: {
          ...current,
          state: 'waiting_for_particle',
          submissionPossible: true,
          providerOperationId: 'particle-operation-live-1',
        },
        status: 'submitted' as const,
      })),
      pollPayment: vi.fn(async (current) => ({
        kind: 'canonical' as const,
        snapshot: {
          ...current,
          state: 'confirmed',
          canonicalConfirmation: finalProof,
        },
        proof: finalProof,
      })),
    };
    const email = vi.fn(async () => undefined);
    window.turnstile = {
      render: vi.fn((_container, options) => {
        queueMicrotask(() => options.callback('turnstile_fresh_challenge_token_123456'));
        return `widget-${Math.random().toString(16)}`;
      }),
      remove: vi.fn(),
    };

    render(
      <CheckoutWorkflow
        authActions={{ google: vi.fn(), email }}
        initial={snapshot}
        liveActions={actions}
        mode="live"
        sponsorSiteKey="turnstile-test-site-key"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('heading', { name: 'Continue to checkout' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Continue with email' }));
    fireEvent.change(screen.getByRole('textbox', { name: /Email address/ }), {
      target: { value: 'buyer@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue with email' }));

    expect(
      await screen.findByRole('heading', { name: 'Prepare your account for one-tap payments' }),
    ).toBeVisible();
    const eligibility = await screen.findByRole('button', { name: 'Check setup eligibility' });
    await waitFor(() => expect(eligibility).toBeEnabled());
    fireEvent.click(eligibility);
    const prepare = await screen.findByRole('button', { name: 'Prepare account' });
    await waitFor(() => expect(prepare).toBeEnabled());
    fireEvent.click(prepare);
    expect(await screen.findByRole('heading', { name: 'Available to pay' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Review payment' }));
    expect(await screen.findByRole('heading', { name: 'Payment details' })).toBeVisible();
    expect(screen.getByText('Live-only Rooftop Supper × 1')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /Confirm and pay/ }));

    expect(await screen.findByRole('heading', { name: 'You’re in' })).toBeVisible();
    await waitFor(() => expect(actions.pollPayment).toHaveBeenCalled());
    expect(email).toHaveBeenCalledWith('buyer@example.com');
    expect(actions.prepareAccount).toHaveBeenCalledTimes(1);
    expect(actions.checkSponsorEligibility).toHaveBeenCalledTimes(1);
    expect(actions.loadBalance).toHaveBeenCalledTimes(1);
    expect(actions.preparePayment).toHaveBeenCalledTimes(1);
    expect(actions.submitPayment).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('Payment proof'));
    expect(screen.getByText('OrderPaid')).toBeVisible();
    expect(screen.getByText(/evidence after 3 confirmations/)).toBeVisible();
  });
});
