'use client';

import { Button, InlineAlert, TextField } from '@opentab/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  MerchantProductListResponse,
  ParticleCertificationStatus,
} from '../../application/browser-api-client';
import {
  type BrowserApplicationService,
  getBrowserApplicationService,
} from '../../application/browser-application-service';
import { AuthPanel } from '../auth-panel';
import { PageSkeleton } from '../states';

interface CanaryReference {
  readonly checkoutSessionId: string;
  readonly paymentAttemptId: string;
  readonly preparedFixtureDigest: string;
}

function readCanaryReference(): CanaryReference | undefined {
  try {
    const value = window.sessionStorage.getItem('opentab.particle-certification.preview');
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
  return error instanceof Error
    ? error.message
    : 'Certification stopped safely before another provider action was started.';
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
  const [pending, setPending] = useState<
    'unlock' | 'product' | 'bootstrap' | 'preview' | 'canary' | undefined
  >();
  const [progress, setProgress] = useState('');
  const [error, setError] = useState<string>();

  const loadAuthenticatedState = useCallback(async () => {
    try {
      await service.restoreSession();
      setAuth('ready');
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

  if (auth === 'loading') return <PageSkeleton label="Restoring secure operator session" />;
  if (auth === 'required') {
    return (
      <AuthPanel
        body="Use the Magic account that will run OpenTab’s single Particle canary. This is not repeated for customers."
        deterministic={false}
        onAuthenticated={() => void loadAuthenticatedState()}
        onEmailSignIn={async (email) => {
          await service.signInWithEmail(email, '/operator/particle');
        }}
        onGoogleSignIn={() => service.beginGoogleSignIn('/operator/particle')}
        title="Authenticate the certification operator"
      />
    );
  }

  const stage = status?.certification.stage ?? 'locked';
  const canUseProduct = productId.length > 0;
  return (
    <div className="operator-certification">
      <header>
        <p className="eyebrow">One-time Particle control</p>
        <h1>Certify Particle checkout</h1>
        <p>
          Capture SDK compatibility once for this Particle project and contract deployment,
          constrain one tiny canary, then unlock normal payments only after Railway confirms the
          canonical Arbitrum event.
        </p>
      </header>

      <InlineAlert title="Not a customer step" tone="info">
        Customers only sign in and pay. The delegate profile and response schemas are reusable
        project-level evidence stored centrally in Supabase, not copied into Vercel or Railway
        variables.
      </InlineAlert>

      {error ? (
        <InlineAlert title="Certification stopped safely" tone="danger">
          {error}
        </InlineAlert>
      ) : null}
      {progress ? (
        <InlineAlert title="Live canary progress" tone="info">
          <span aria-live="polite">{progress}</span>
        </InlineAlert>
      ) : null}

      <section className="settings-section" aria-labelledby="operator-access-title">
        <div>
          <p className="eyebrow">Step 1</p>
          <h2 id="operator-access-title">Unlock operator controls</h2>
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
            });
          }}
        >
          <TextField
            autoComplete="off"
            id="particle-certification-token"
            label="Certification token"
            onChange={(event) => setOperatorToken(event.currentTarget.value)}
            required
            type="password"
            value={operatorToken}
          />
          <Button
            disabled={operatorToken.length < 32}
            loading={pending === 'unlock'}
            loadingLabel="Verifying operator access"
            type="submit"
          >
            Unlock certification
          </Button>
        </form>
      </section>

      {status ? (
        <section className="settings-section" aria-labelledby="canary-product-title">
          <div>
            <p className="eyebrow">Step 2</p>
            <h2 id="canary-product-title">Bind the tiny canary</h2>
            <p>Choose one active onchain product priced at 1 USDC or less.</p>
          </div>
          <div className="operator-certification__actions">
            <InlineAlert title="Fund this Magic EOA once" tone="info">
              <p>
                Send a small amount of ETH on Arbitrum One to pay gas for merchant and product
                setup. This is the same authenticated Magic address—not a new operator wallet.
              </p>
              <a
                href={`https://arbiscan.io/address/${walletAddress}`}
                rel="noreferrer"
                target="_blank"
              >
                {walletAddress || 'Loading Magic EOA…'}
              </a>
            </InlineAlert>
            <TextField
              id="particle-canary-product"
              label="OpenTab product ID"
              list="particle-canary-products"
              onChange={(event) => setProductId(event.currentTarget.value)}
              placeholder="prd_…"
              required
              value={productId}
            />
            <datalist id="particle-canary-products">
              {products.map((product) => (
                <option key={product.id} value={product.id}>
                  {product.title} — {product.unitPriceBaseUnits} base units
                </option>
              ))}
            </datalist>
            <dl className="component-status-list">
              <div>
                <dt>Particle profile</dt>
                <dd>{status.profileScopeId.slice(0, 12)}</dd>
              </div>
              <div>
                <dt>Stage</dt>
                <dd>{stage.replace('_', ' ')}</dd>
              </div>
            </dl>
            {products.length === 0 ? (
              <div className="operator-certification__bootstrap-product">
                <p>
                  No eligible onchain product exists. OpenTab can create and activate the fixed 0.10
                  USDC release canary with three constrained Magic confirmations.
                </p>
                <Button
                  loading={pending === 'product'}
                  loadingLabel="Creating canonical canary"
                  onClick={() =>
                    void run('product', async () => {
                      setProgress('Checking the certification merchant and canary product…');
                      const result = await service.bootstrapParticleCertificationCanary({
                        operatorToken,
                        onProgress: setProgress,
                      });
                      setWalletAddress(result.ownerAddress);
                      setProducts([result.product]);
                      setProductId(result.product.id);
                      setProgress('The fixed 0.10 USDC canary is active and selected.');
                    })
                  }
                >
                  Create 0.10 USDC canary
                </Button>
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      {status ? (
        <section className="operator-certification__rail" aria-label="Certification actions">
          <Button
            disabled={stage !== 'uncertified' || !canUseProduct}
            loading={pending === 'bootstrap'}
            loadingLabel="Capturing bootstrap compatibility"
            onClick={() =>
              void run('bootstrap', async () => {
                setProgress('Verifying Magic owner continuity and Particle EIP-7702 deployment…');
                const next = await service.captureParticleCertificationBootstrap({
                  operatorToken,
                  productId,
                });
                setStatus(next);
                setProgress('Bootstrap profile stored for this Particle project.');
              })
            }
          >
            1. Capture bootstrap
          </Button>
          <Button
            disabled={!['bootstrap', 'canary_ready'].includes(stage) || !canUseProduct}
            loading={pending === 'preview'}
            loadingLabel="Validating constrained preview"
            onClick={() =>
              void run('preview', async () => {
                setProgress('Preparing a non-submitting, server-bound Particle preview…');
                const result = await service.captureParticleCertificationCanaryPreview({
                  operatorToken,
                  productId,
                });
                setStatus(result.status);
                setCanary(result);
                setProgress('Canary preview approved. No funds moved.');
              })
            }
          >
            2. Approve canary preview
          </Button>
          <Button
            disabled={stage !== 'canary_ready' || canary === undefined}
            loading={pending === 'canary'}
            loadingLabel="Submitting and reconciling canary"
            onClick={() =>
              void run('canary', async () => {
                if (canary === undefined) return;
                const next = await service.runAndCertifyParticleCanary({
                  operatorToken,
                  checkoutSessionId: canary.checkoutSessionId,
                  expectedPaymentAttemptId: canary.paymentAttemptId,
                  onProgress: setProgress,
                });
                setStatus(next);
                setProgress('Particle profile certified. Normal payment policy is now active.');
              })
            }
          >
            3. Pay tiny canary and certify
          </Button>
        </section>
      ) : null}

      {stage === 'certified' ? (
        <InlineAlert title="Particle payment gate is certified" tone="success">
          New customers can now use the normal Magic + Particle checkout. Payment still becomes
          final only after Railway indexes the matching canonical OrderPaid event.
        </InlineAlert>
      ) : null}
    </div>
  );
}
