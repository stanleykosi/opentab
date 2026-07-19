'use client';

import { Button, InlineAlert, TextField } from '@opentab/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  MerchantProductListResponse,
  ParticleCertificationStatus,
} from '../../application/browser-api-client';
import { BrowserApiError } from '../../application/browser-api-client';
import {
  type BrowserApplicationService,
  getBrowserApplicationService,
} from '../../application/browser-application-service';
import { AccountSetupPanel } from '../account-setup-panel';
import { AuthPanel } from '../auth-panel';
import { PageSkeleton } from '../states';

interface CanaryReference {
  readonly checkoutSessionId: string;
  readonly paymentAttemptId: string;
  readonly preparedFixtureDigest: string;
}

function readCanaryReference(): CanaryReference | undefined {
  try {
    const value = window.localStorage.getItem('opentab.particle-certification.preview');
    if (value === null) return undefined;
    const parsed = JSON.parse(value) as Partial<CanaryReference>;
    if (
      typeof parsed.checkoutSessionId !== 'string' ||
      typeof parsed.paymentAttemptId !== 'string' ||
      typeof parsed.preparedFixtureDigest !== 'string' ||
      !/^0x[0-9a-fA-F]{64}$/.test(parsed.preparedFixtureDigest)
    ) {
      return undefined;
    }
    return {
      checkoutSessionId: parsed.checkoutSessionId,
      paymentAttemptId: parsed.paymentAttemptId,
      preparedFixtureDigest: parsed.preparedFixtureDigest,
    };
  } catch {
    return undefined;
  }
}

function safeMessage(error: unknown): string {
  if (error instanceof BrowserApiError && error.requestId !== undefined) {
    return `${error.message} Reference: ${error.requestId}`;
  }
  return error instanceof Error
    ? error.message
    : 'Activation stopped safely before another provider action was started.';
}

function formatUsdcBaseUnits(value: string): string {
  const baseUnits = BigInt(value);
  const whole = baseUnits / 1_000_000n;
  const fraction = (baseUnits % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return fraction.length === 0 ? whole.toString() : `${whole}.${fraction}`;
}

export function ParticleCertificationConsole({
  service: providedService,
}: {
  service?: BrowserApplicationService;
}) {
  const service = useMemo(
    () => providedService ?? getBrowserApplicationService(),
    [providedService],
  );
  const [auth, setAuth] = useState<'loading' | 'required' | 'ready'>('loading');
  const [operatorToken, setOperatorToken] = useState('');
  const [walletAddress, setWalletAddress] = useState('');
  const [productId, setProductId] = useState('');
  const [products, setProducts] = useState<MerchantProductListResponse['items']>([]);
  const [status, setStatus] = useState<ParticleCertificationStatus>();
  const [canary, setCanary] = useState<CanaryReference>();
  const [walletReady, setWalletReady] = useState(false);
  const [pending, setPending] = useState<'unlock' | 'product' | 'prepare' | 'canary' | undefined>();
  const [progress, setProgress] = useState('');
  const [error, setError] = useState<string>();

  const loadAuthenticatedState = useCallback(async () => {
    try {
      await service.restoreSession();
      setWalletAddress(await service.getWalletOwner());
      const response = await service.listParticleCertificationProducts().catch(() => undefined);
      if (response !== undefined) {
        const candidates = response.items.filter(
          (product) =>
            product.status === 'active' &&
            product.onchainProductId !== undefined &&
            BigInt(product.unitPriceBaseUnits) <= 1_000_000n,
        );
        setProducts(candidates);
        setProductId((current) => current || candidates[0]?.id || '');
      }
      setCanary(readCanaryReference());
      setAuth('ready');
    } catch {
      setAuth('required');
    }
  }, [service]);

  useEffect(() => {
    void loadAuthenticatedState();
  }, [loadAuthenticatedState]);

  const run = async (
    action: Exclude<typeof pending, undefined>,
    operation: () => Promise<void>,
  ) => {
    setPending(action);
    setError(undefined);
    try {
      await operation();
    } catch (caught) {
      setError(safeMessage(caught));
    } finally {
      setPending(undefined);
    }
  };

  const markWalletReady = useCallback(() => {
    setWalletReady(true);
    setProgress('The embedded account is ready for the activation payment.');
  }, []);

  const prepareActivation = async () => {
    if (status === undefined || productId.length === 0) return;
    let nextStatus = status;
    if (nextStatus.certification.stage === 'uncertified') {
      if (!nextStatus.effectiveCapabilities.captureBootstrap) {
        throw new Error('The server has not enabled the reviewed Particle activation policy.');
      }
      setProgress('Verifying the embedded account and payment configuration…');
      nextStatus = await service.captureParticleCertificationBootstrap({
        operatorToken,
        productId,
      });
      setStatus(nextStatus);
    }
    if (nextStatus.certification.stage === 'bootstrap') {
      if (!nextStatus.effectiveCapabilities.captureCanaryPreview) {
        setProgress(
          'Configuration is recorded. Enable the reviewed live payment policy, reload, and resume.',
        );
        return;
      }
      setProgress('Binding the exact activation route and server-approved payment…');
      const result = await service.captureParticleCertificationCanaryPreview({
        operatorToken,
        productId,
      });
      setStatus(result.status);
      setCanary(result);
      setWalletReady(false);
      setProgress('Activation checks are complete. Review the exact payment to continue.');
    }
  };

  if (auth === 'loading') return <PageSkeleton label="Restoring secure operator session" />;
  if (auth === 'required') {
    return (
      <AuthPanel
        body="Use the Magic account that will activate payments for this OpenTab project. Customers do not repeat this step."
        deterministic={false}
        onAuthenticated={() => void loadAuthenticatedState()}
        onEmailSignIn={async (email) => {
          await service.signInWithEmail(email, '/operator/particle');
        }}
        onGoogleSignIn={() => service.beginGoogleSignIn('/operator/particle')}
        title="Authenticate the payment operator"
      />
    );
  }

  const stage = status?.certification.stage ?? 'locked';
  const canUseProduct = productId.length > 0;
  const selectedProduct = products.find((product) => product.id === productId);
  const canaryAmount =
    selectedProduct === undefined
      ? 'the selected product amount'
      : `${formatUsdcBaseUnits(selectedProduct.unitPriceBaseUnits)} USDC`;
  const activationState =
    stage === 'certified'
      ? 'Ready'
      : stage === 'canary_ready'
        ? 'Payment confirmation required'
        : 'Preparing';
  return (
    <div className="operator-certification">
      <header>
        <p className="eyebrow">One-time payment control</p>
        <h1>Activate payments</h1>
        <p>
          Complete one guided activation for this project. OpenTab enables customer checkout only
          after the final payment has confirmed settlement proof.
        </p>
      </header>

      <InlineAlert title="One activation for the whole project" tone="info">
        Customers only sign in and pay. OpenTab stores this project-level activation centrally in
        Supabase and reuses it for every customer across ordinary redeploys.
      </InlineAlert>

      <InlineAlert title="One explicit payment confirmation" tone="info">
        Funds move only at the final confirmation, which shows the selected amount and route fees.
        Creating the fixed activation item separately may use a small network setup fee.
      </InlineAlert>

      {error ? (
        <InlineAlert title="Activation stopped safely" tone="danger">
          {error}
        </InlineAlert>
      ) : null}
      {progress ? (
        <InlineAlert title="Activation progress" tone="info">
          <span aria-live="polite">{progress}</span>
        </InlineAlert>
      ) : null}

      <section className="settings-section" aria-labelledby="operator-access-title">
        <div>
          <p className="eyebrow">Secure access</p>
          <h2 id="operator-access-title">Authorize payment activation</h2>
          <p>The token stays in this tab and is never persisted by OpenTab.</p>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void run('unlock', async () => {
              const [nextStatus, owner] = await Promise.all([
                service.unlockParticleCertification(operatorToken),
                service.getWalletOwner(),
              ]);
              setStatus(nextStatus);
              setWalletAddress(owner);
              const certification = nextStatus.certification;
              if (certification.stage === 'canary_ready') {
                const boundProduct = products.find(
                  (product) => product.onchainProductId === certification.canaryProductId,
                );
                if (boundProduct === undefined) {
                  throw new Error(
                    'The bound activation item is unavailable. Refresh the page and resume safely.',
                  );
                }
                setProductId(boundProduct.id);
                setProgress('Recovering the durable activation record…');
                const recovered = await service.captureParticleCertificationCanaryPreview({
                  operatorToken,
                  productId: boundProduct.id,
                });
                setStatus(recovered.status);
                setCanary(recovered);
                setProgress('Activation record recovered. No duplicate payment was created.');
              }
            });
          }}
        >
          <TextField
            autoComplete="off"
            id="particle-certification-token"
            label="Operator token"
            onChange={(event) => setOperatorToken(event.currentTarget.value)}
            required
            type="password"
            value={operatorToken}
          />
          <Button
            disabled={operatorToken.length < 32}
            loading={pending === 'unlock'}
            loadingLabel="Verifying secure access"
            type="submit"
          >
            Continue
          </Button>
        </form>
      </section>

      {status ? (
        <section className="settings-section" aria-labelledby="payment-activation-title">
          <div>
            <p className="eyebrow">
              {stage === 'certified' ? 'Activation complete' : 'Activation in progress'}
            </p>
            <h2 id="payment-activation-title">Activate customer payments</h2>
            <p>
              Continue resumes the same durable activation record. OpenTab will not create a second
              payment when an earlier attempt already exists.
            </p>
          </div>
          <div className="operator-certification__actions">
            {stage !== 'certified' && products.length > 0 ? (
              <>
                <TextField
                  disabled={stage === 'canary_ready'}
                  id="particle-canary-product"
                  label="Activation item"
                  list="particle-canary-products"
                  onChange={(event) => setProductId(event.currentTarget.value)}
                  placeholder="prd_…"
                  required
                  value={productId}
                />
                <datalist id="particle-canary-products">
                  {products.map((product) => (
                    <option key={product.id} value={product.id}>
                      {product.title} — {formatUsdcBaseUnits(product.unitPriceBaseUnits)} USDC
                    </option>
                  ))}
                </datalist>
              </>
            ) : null}

            {stage !== 'certified' && products.length === 0 ? (
              <div className="operator-certification__bootstrap-product">
                <p>
                  OpenTab needs one fixed 0.10 USDC activation item. Creating it requires three
                  constrained Magic confirmations and the normal setup fee.
                </p>
                <Button
                  loading={pending === 'product'}
                  loadingLabel="Creating activation item"
                  onClick={() =>
                    void run('product', async () => {
                      setProgress('Creating the project activation item…');
                      const result = await service.bootstrapParticleCertificationCanary({
                        operatorToken,
                        onProgress: (message) => setProgress(message),
                      });
                      setWalletAddress(result.ownerAddress);
                      setProducts([result.product]);
                      setProductId(result.product.id);
                      setProgress('The 0.10 USDC activation item is selected.');
                    })
                  }
                >
                  Create activation item
                </Button>
              </div>
            ) : null}

            {stage === 'uncertified' || stage === 'bootstrap' ? (
              <Button
                disabled={
                  !canUseProduct ||
                  (stage === 'uncertified'
                    ? !status.effectiveCapabilities.captureBootstrap
                    : !status.effectiveCapabilities.captureCanaryPreview)
                }
                loading={pending === 'prepare'}
                loadingLabel="Continuing activation"
                onClick={() => void run('prepare', prepareActivation)}
              >
                Continue payment activation
              </Button>
            ) : null}

            {(stage === 'uncertified' && !status.effectiveCapabilities.captureBootstrap) ||
            (stage === 'bootstrap' && !status.effectiveCapabilities.captureCanaryPreview) ? (
              <InlineAlert title="Activation is temporarily paused" tone="warning">
                Enable the reviewed live payment policy on Vercel, then reload and continue.
                Customer checkout remains safely closed.
              </InlineAlert>
            ) : null}

            {stage === 'canary_ready' ? (
              <>
                <InlineAlert
                  title={`Final confirmation: ${canaryAmount} plus route fees`}
                  tone="warning"
                >
                  Confirm this payment once. OpenTab then waits for Railway to verify settlement and
                  issue the pass before enabling customer checkout.
                </InlineAlert>
                {canary === undefined ? (
                  <InlineAlert title="Activation record could not be recovered" tone="warning">
                    Refresh and continue. OpenTab uses the existing durable payment attempt and will
                    not submit a duplicate.
                  </InlineAlert>
                ) : null}
                {canary !== undefined && !walletReady ? (
                  <AccountSetupPanel onReady={markWalletReady} service={service} />
                ) : null}
                {walletReady ? (
                  <InlineAlert title="Account ready" tone="success">
                    The embedded account and independent readiness checks agree.
                  </InlineAlert>
                ) : null}
                <Button
                  disabled={
                    !status.effectiveCapabilities.runCanary || canary === undefined || !walletReady
                  }
                  loading={pending === 'canary'}
                  loadingLabel="Confirming activation payment"
                  onClick={() =>
                    void run('canary', async () => {
                      if (canary === undefined || !walletReady) return;
                      const next = await service.runAndCertifyParticleCanary({
                        operatorToken,
                        checkoutSessionId: canary.checkoutSessionId,
                        expectedPaymentAttemptId: canary.paymentAttemptId,
                        onProgress: () =>
                          setProgress('Activation payment is processing. Waiting for settlement…'),
                      });
                      setStatus(next);
                      setProgress('Activation is complete and the customer payment gate is open.');
                    })
                  }
                >
                  Confirm activation payment
                </Button>
              </>
            ) : null}

            {stage === 'certified' ? (
              <InlineAlert title="Customer payments are active" tone="success">
                New customers can now use the normal Magic + Particle checkout. Every payment still
                requires confirmed settlement proof before OpenTab marks it paid.
              </InlineAlert>
            ) : null}

            <details className="disclosure">
              <summary>Funding and technical details</summary>
              <p>
                This Magic address may need Arbitrum ETH for one-time account or item setup and a
                supported non-Arbitrum balance for the final routed payment.
              </p>
              <a
                href={`https://arbiscan.io/address/${walletAddress}`}
                rel="noreferrer"
                target="_blank"
              >
                {walletAddress || 'Loading embedded address…'}
              </a>
              <dl className="component-status-list">
                <div>
                  <dt>Particle profile</dt>
                  <dd>{status.profileScopeId.slice(0, 12)}</dd>
                </div>
                <div>
                  <dt>Activation status</dt>
                  <dd>{activationState}</dd>
                </div>
              </dl>
            </details>
          </div>
        </section>
      ) : null}
    </div>
  );
}
