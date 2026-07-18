'use client';

import { Button, Checkbox, InlineAlert, TextField } from '@opentab/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BrowserApiClient,
  BrowserApiError,
  type MerchantProfileResponse,
} from '../../application/browser-api-client';
import {
  type BrowserApplicationService,
  getBrowserApplicationService,
} from '../../application/browser-application-service';
import { AccountSetupPanel } from '../account-setup-panel';
import { BoundOperationStatus } from '../bound-operation-status';
import { SessionControl } from '../session-control';
import { ErrorState, PageSkeleton } from '../states';
import { useBoundOperation } from '../use-bound-operation';

function key(scope: string): string {
  return `web.${scope}.${crypto.randomUUID()}`;
}

function masked(value: string): string {
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function message(error: unknown, fallback: string): { message: string; reference?: string } {
  return {
    message: error instanceof BrowserApiError ? error.message : fallback,
    ...(error instanceof BrowserApiError && error.requestId !== undefined
      ? { reference: error.requestId }
      : {}),
  };
}

type OnboardingState =
  | { status: 'loading' }
  | { status: 'editing'; payoutAddress: string; existing?: MerchantProfileResponse }
  | { status: 'submitting'; payoutAddress: string; existing?: MerchantProfileResponse }
  | { status: 'complete'; merchantName: string; canonicalStatus: string }
  | { status: 'error'; message: string; reference?: string };

export function LiveMerchantOnboarding({
  client: providedClient,
  service,
}: {
  client?: BrowserApiClient;
  service?: BrowserApplicationService;
}) {
  const client = useMemo(() => providedClient ?? new BrowserApiClient(), [providedClient]);
  const browserService = useMemo(() => service ?? getBrowserApplicationService(), [service]);
  const operation = useBoundOperation(browserService);
  const [accountReady, setAccountReady] = useState(false);
  const markAccountReady = useCallback(() => setAccountReady(true), []);
  const [state, setState] = useState<OnboardingState>({ status: 'loading' });
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [support, setSupport] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [formError, setFormError] = useState<string>();

  useEffect(() => {
    let active = true;
    void client
      .restoreSession()
      .then(async (session) => {
        let existing: MerchantProfileResponse | undefined;
        try {
          existing = await client.getMerchantProfile();
        } catch (error) {
          if (!(error instanceof BrowserApiError) || error.status !== 404) throw error;
        }
        if (!active) return;
        if (existing !== undefined) {
          setName(existing.merchant.displayName);
          setSlug(existing.merchant.slug);
          setSupport(existing.merchant.supportContact ?? '');
          if (existing.merchant.status === 'active') {
            setState({
              status: 'complete',
              merchantName: existing.merchant.displayName,
              canonicalStatus: existing.merchant.status,
            });
            return;
          }
          if (existing.operation !== undefined && existing.operation.status !== 'prepared') {
            operation.adopt(existing.operation);
            setAccountReady(true);
          }
        }
        setState({
          status: 'editing',
          payoutAddress: session.user.walletAddress,
          ...(existing === undefined ? {} : { existing }),
        });
      })
      .catch((error: unknown) => {
        if (active)
          setState({ status: 'error', ...message(error, 'Merchant onboarding could not load.') });
      });
    return () => {
      active = false;
    };
  }, [client, operation.adopt]);

  if (state.status === 'loading') return <PageSkeleton label="Loading merchant onboarding" />;
  if (state.status === 'error') {
    return (
      <ErrorState
        body={state.message}
        {...(state.reference === undefined ? {} : { reference: state.reference })}
        title="Merchant onboarding unavailable"
      />
    );
  }
  if (state.status === 'complete' || operation.state === 'confirmed') {
    const merchantName = state.status === 'complete' ? state.merchantName : name;
    const canonicalStatus = state.status === 'complete' ? state.canonicalStatus : 'active';
    const active = canonicalStatus === 'active';
    return (
      <section className="onboarding-result">
        <p className="eyebrow">Merchant {canonicalStatus}</p>
        <h1>{active ? 'Your storefront is ready' : 'Your storefront is being confirmed'}</h1>
        <InlineAlert
          title={active ? 'Profile confirmed' : 'Activation submitted'}
          tone={active ? 'success' : 'info'}
        >
          <p>
            {active
              ? `${merchantName} can now create products and receive confirmed settlement.`
              : `${merchantName} remains unavailable to buyers until its activation is confirmed.`}
          </p>
        </InlineAlert>
        {active ? (
          <div className="page-actions">
            <a className="ot-button ot-button--primary" href="/merchant">
              Open merchant console
            </a>
            <a className="ot-button ot-button--secondary" href="/merchant/products/new">
              Create a product
            </a>
          </div>
        ) : (
          <a className="ot-button ot-button--secondary" href="/merchant">
            Check activation status
          </a>
        )}
      </section>
    );
  }
  if (!accountReady) {
    return <AccountSetupPanel onReady={markAccountReady} service={browserService} />;
  }

  const submit = async () => {
    const slugValid = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);
    if (!slugValid || !acknowledged || name.trim().length < 2 || support.trim().length < 3) {
      setFormError('Complete the public profile and confirm the merchant policy.');
      const fieldId =
        name.trim().length < 2
          ? 'merchant-name'
          : !slugValid
            ? 'merchant-slug'
            : support.trim().length < 3
              ? 'merchant-support'
              : 'merchant-policy';
      document.getElementById(fieldId)?.focus();
      return;
    }
    const previous = state;
    setState({ ...state, status: 'submitting' });
    setFormError(undefined);
    try {
      const existing = state.existing;
      if (existing !== undefined) {
        if (existing.operation === undefined) {
          throw new BrowserApiError({
            code: 'RESPONSE_INVALID',
            message: 'The durable activation record is missing. Refresh before trying again.',
            status: 0,
          });
        }
        await operation.prepare(existing.operation);
        setState({ ...state, status: 'editing' });
      } else {
        const profile = await client.createMerchantProfile(
          {
            slug,
            displayName: name,
            supportContact: support,
            payoutAddress: state.payoutAddress,
          },
          key('merchant-create'),
        );
        setState({
          status: 'editing',
          payoutAddress: state.payoutAddress,
          existing: {
            merchant: profile.merchant,
            operation: profile.operation,
            requestId: profile.requestId,
          },
        });
        await operation.prepare(profile.operation);
      }
    } catch (error) {
      setState(previous);
      setFormError(message(error, 'Merchant activation could not finish.').message);
    }
  };

  return (
    <form
      className="onboarding-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <header className="page-heading">
        <p className="eyebrow">Merchant onboarding</p>
        <h1>Open your first tab</h1>
        <p>Create the public identity customers see before payment.</p>
      </header>
      {formError === undefined ? null : (
        <div className="form-error-summary" role="alert" tabIndex={-1}>
          <strong>Merchant profile not saved</strong>
          <p>{formError}</p>
        </div>
      )}
      <fieldset disabled={state.status === 'submitting' || operation.state !== 'idle'}>
        <legend>Public profile</legend>
        <TextField
          id="merchant-name"
          label="Display name"
          onChange={(event) => setName(event.currentTarget.value)}
          required
          value={name}
        />
        <TextField
          description={`Storefront: /m/${slug || 'your-store'}`}
          id="merchant-slug"
          label="Storefront slug"
          onChange={(event) => setSlug(event.currentTarget.value)}
          required
          value={slug}
          {...(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)
            ? {}
            : { error: 'Use lowercase letters, numbers, and single hyphens.' })}
        />
        <TextField
          id="merchant-support"
          label="Customer support contact"
          onChange={(event) => setSupport(event.currentTarget.value)}
          required
          value={support}
        />
      </fieldset>
      <fieldset disabled={state.status === 'submitting' || operation.state !== 'idle'}>
        <legend>Payout ownership</legend>
        <TextField
          description="This destination is bound to the authenticated embedded account."
          label="Payout destination"
          readOnly
          value={masked(state.payoutAddress)}
        />
        <InlineAlert title="Payout ownership checked" tone="info">
          <p>The destination matches your signed-in account. The full address stays hidden here.</p>
        </InlineAlert>
      </fieldset>
      <Checkbox
        checked={acknowledged}
        description="You are responsible for offer accuracy, refund terms, support, and applicable local obligations."
        id="merchant-policy"
        label="I accept the merchant policy and confirm this payout destination"
        onChange={(event) => setAcknowledged(event.currentTarget.checked)}
      />
      <Button
        disabled={operation.state !== 'idle' && operation.state !== 'failed'}
        loading={state.status === 'submitting'}
        loadingLabel="Preparing exact activation"
        size="large"
        type="submit"
      >
        {state.existing === undefined ? 'Review merchant activation' : 'Review pending activation'}
      </Button>
      <BoundOperationStatus
        confirmLabel="Approve merchant activation"
        controller={operation}
        noun="Merchant activation"
      />
    </form>
  );
}

type SettingsState =
  | { status: 'loading' }
  | { status: 'ready'; profile: MerchantProfileResponse }
  | { status: 'error'; message: string; reference?: string };

export function LiveMerchantSettings({
  client: providedClient,
  service,
}: {
  client?: BrowserApiClient;
  service?: BrowserApplicationService;
}) {
  const client = useMemo(() => providedClient ?? new BrowserApiClient(), [providedClient]);
  const payoutOperation = useBoundOperation(service);
  const [state, setState] = useState<SettingsState>({ status: 'loading' });
  const [name, setName] = useState('');
  const [support, setSupport] = useState('');
  const [loyaltyName, setLoyaltyName] = useState('Regulars');
  const [thresholdPoints, setThresholdPoints] = useState('1000');
  const [loyaltyEnabled, setLoyaltyEnabled] = useState(true);
  const [payoutAddress, setPayoutAddress] = useState('');
  const [saving, setSaving] = useState<'profile' | 'loyalty' | 'payout'>();
  const [notice, setNotice] = useState<{
    tone: 'success' | 'danger';
    title: string;
    body: string;
  }>();

  useEffect(() => {
    let active = true;
    void client
      .restoreSession()
      .then(async () => {
        const [profile, loyalty] = await Promise.all([
          client.getMerchantProfile(),
          client.getLoyaltyStatus().catch((error: unknown) => {
            if (error instanceof BrowserApiError && error.code === 'FEATURE_DISABLED')
              return undefined;
            throw error;
          }),
        ]);
        if (!active) return;
        setName(profile.merchant.displayName);
        setSupport(profile.merchant.supportContact ?? '');
        setPayoutAddress(profile.merchant.payoutAddress);
        const program = loyalty?.programs.find((entry) => entry.merchantId === profile.merchant.id);
        if (program !== undefined) {
          setLoyaltyName(program.name);
          setThresholdPoints(program.thresholdPoints);
          setLoyaltyEnabled(program.enabled);
        }
        setState({ status: 'ready', profile });
      })
      .catch((error: unknown) => {
        if (active)
          setState({ status: 'error', ...message(error, 'Merchant settings could not load.') });
      });
    return () => {
      active = false;
    };
  }, [client]);

  useEffect(() => {
    if (payoutOperation.state !== 'confirmed') return;
    let active = true;
    void client
      .getMerchantProfile()
      .then((profile) => {
        if (!active) return;
        setState({ status: 'ready', profile });
        setPayoutAddress(profile.merchant.payoutAddress);
        setNotice({
          tone: 'success',
          title: 'Payout destination confirmed',
          body: 'The confirmed merchant record now uses the new destination.',
        });
        payoutOperation.reset();
      })
      .catch((error: unknown) => {
        if (!active) return;
        setNotice({
          tone: 'danger',
          title: 'Payout status unavailable',
          body: message(error, 'Refresh before preparing another payout change.').message,
        });
      });
    return () => {
      active = false;
    };
  }, [client, payoutOperation.reset, payoutOperation.state]);

  if (state.status === 'loading') return <PageSkeleton label="Loading merchant settings" />;
  if (state.status === 'error') {
    return (
      <ErrorState
        body={state.message}
        {...(state.reference === undefined ? {} : { reference: state.reference })}
        title="Merchant settings unavailable"
      />
    );
  }

  const saveProfile = async () => {
    if (state.profile.version === undefined) {
      setNotice({
        tone: 'danger',
        title: 'Profile version unavailable',
        body: 'Refresh before changing this profile so OpenTab can prevent overwriting another update.',
      });
      return;
    }
    setSaving('profile');
    setNotice(undefined);
    try {
      const profile = await client.updateMerchantProfile(
        {
          expectedVersion: state.profile.version,
          displayName: name,
          supportContact: support,
        },
        key('merchant-profile-update'),
      );
      setState({ ...state, profile });
      setNotice({
        tone: 'success',
        title: 'Profile changes saved',
        body: 'Your storefront now uses these details.',
      });
    } catch (error) {
      setNotice({
        tone: 'danger',
        title: 'Profile not saved',
        body: message(error, 'Try again.').message,
      });
    } finally {
      setSaving(undefined);
    }
  };

  const saveLoyalty = async () => {
    if (!/^[1-9][0-9]*$/.test(thresholdPoints)) {
      setNotice({
        tone: 'danger',
        title: 'Loyalty not saved',
        body: 'The reward threshold must be a whole number greater than zero.',
      });
      return;
    }
    setSaving('loyalty');
    setNotice(undefined);
    try {
      const result = await client.updateLoyaltyProgram(
        {
          merchantId: state.profile.merchant.id,
          name: loyaltyName,
          thresholdPoints,
          enabled: loyaltyEnabled,
        },
        key('merchant-loyalty-update'),
      );
      setNotice({
        tone: 'success',
        title: 'Loyalty settings saved',
        body: `${result.program.name} will apply to newly confirmed awards.`,
      });
    } catch (error) {
      setNotice({
        tone: 'danger',
        title: 'Loyalty not saved',
        body: message(error, 'Try again.').message,
      });
    } finally {
      setSaving(undefined);
    }
  };

  const preparePayoutChange = async () => {
    if (state.profile.version === undefined) {
      setNotice({
        tone: 'danger',
        title: 'Profile version unavailable',
        body: 'Refresh before preparing a payout change.',
      });
      return;
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(payoutAddress)) {
      setNotice({
        tone: 'danger',
        title: 'Payout destination invalid',
        body: 'Enter a complete 0x-prefixed account address.',
      });
      document.getElementById('merchant-payout-address')?.focus();
      return;
    }
    setSaving('payout');
    setNotice(undefined);
    try {
      const response = await client.updateMerchantProfile(
        { expectedVersion: state.profile.version, payoutAddress },
        key('merchant-payout-update'),
      );
      if (response.operation === undefined) {
        throw new BrowserApiError({
          code: 'RESPONSE_INVALID',
          message: 'The exact payout approval was not returned. Nothing was submitted.',
          status: 0,
        });
      }
      setState({ ...state, profile: response });
      await payoutOperation.prepare(response.operation);
      setNotice({
        tone: 'success',
        title: 'Payout approval ready',
        body: 'Review and approve the exact destination below. The current destination remains active until confirmation.',
      });
    } catch (error) {
      setNotice({
        tone: 'danger',
        title: 'Payout change not prepared',
        body: message(error, 'Nothing was submitted. Try again.').message,
      });
    } finally {
      setSaving(undefined);
    }
  };

  return (
    <div className="settings-layout">
      <header className="merchant-page-head">
        <div>
          <p className="eyebrow">Merchant settings</p>
          <h1>Profile, payout, and rewards</h1>
          <p>Financially important changes use version checks and authenticated requests.</p>
        </div>
      </header>
      {notice === undefined ? null : (
        <InlineAlert title={notice.title} tone={notice.tone}>
          <p>{notice.body}</p>
        </InlineAlert>
      )}
      <section className="settings-section">
        <div>
          <h2>Storefront profile</h2>
          <p>Customer-facing name and support details.</p>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void saveProfile();
          }}
        >
          <TextField
            label="Display name"
            onChange={(event) => setName(event.currentTarget.value)}
            required
            value={name}
          />
          <TextField
            label="Support contact"
            onChange={(event) => setSupport(event.currentTarget.value)}
            required
            value={support}
          />
          <Button loading={saving === 'profile'} type="submit">
            Save profile
          </Button>
        </form>
      </section>
      <section className="settings-section">
        <div>
          <h2>Loyalty program</h2>
          <p>Points are credited only after a confirmed purchase event.</p>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void saveLoyalty();
          }}
        >
          <TextField
            label="Program name"
            onChange={(event) => setLoyaltyName(event.currentTarget.value)}
            required
            value={loyaltyName}
          />
          <TextField
            description="Customers earn each product’s fixed points after a confirmed purchase. This threshold sets when the named reward is reached."
            inputMode="numeric"
            label="Reward threshold (points)"
            onChange={(event) => setThresholdPoints(event.currentTarget.value)}
            required
            value={thresholdPoints}
          />
          <Checkbox
            checked={loyaltyEnabled}
            label="Loyalty awards enabled"
            onChange={(event) => setLoyaltyEnabled(event.currentTarget.checked)}
          />
          <Button loading={saving === 'loyalty'} type="submit">
            Save loyalty settings
          </Button>
        </form>
      </section>
      <section className="settings-section">
        <div>
          <h2>Payout destination</h2>
          <p>
            Changes require the merchant owner’s embedded-account approval and a confirmed event.
          </p>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void preparePayoutChange();
          }}
        >
          <p>
            Current: <span className="mono">{masked(state.profile.merchant.payoutAddress)}</span>
          </p>
          <TextField
            description="The database projection changes only after the matching contract event is confirmed."
            id="merchant-payout-address"
            label="New payout destination"
            onChange={(event) => setPayoutAddress(event.currentTarget.value.trim())}
            required
            spellCheck={false}
            value={payoutAddress}
          />
          <Button
            disabled={!['idle', 'failed'].includes(payoutOperation.state)}
            loading={saving === 'payout'}
            type="submit"
          >
            Review payout change
          </Button>
          <BoundOperationStatus
            confirmLabel="Approve payout destination"
            controller={payoutOperation}
            noun="Payout change"
          />
        </form>
      </section>
      <section className="settings-section">
        <div>
          <h2>Current session</h2>
          <p>Signing out revokes this application session without changing the embedded account.</p>
        </div>
        <SessionControl />
      </section>
      <section className="settings-section">
        <div>
          <h2>Audit activity</h2>
          <p>Security-relevant changes are retained in the server audit ledger.</p>
        </div>
        <p>Use the support reference from a failed action when requesting an audit review.</p>
      </section>
    </div>
  );
}
