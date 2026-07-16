'use client';

import { Button, Checkbox, InlineAlert, TextArea, TextField } from '@opentab/ui';
import { useState } from 'react';

export function MerchantOnboarding() {
  const [name, setName] = useState('Daylight Room');
  const [slug, setSlug] = useState('daylight-room');
  const [support, setSupport] = useState('hello@daylight.example');
  const [acknowledged, setAcknowledged] = useState(false);
  const [state, setState] = useState<'draft' | 'pending' | 'complete' | 'error'>('draft');
  const slugValid = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);
  if (state === 'complete')
    return (
      <section className="onboarding-result">
        <p className="eyebrow">Merchant activated</p>
        <h1>Your storefront is ready</h1>
        <InlineAlert title="Profile confirmed" tone="success">
          <p>Daylight Room can now create products and receive confirmed settlement.</p>
        </InlineAlert>
        <a className="ot-button ot-button--primary" href="/merchant/products/new">
          Create your first product
        </a>
      </section>
    );
  return (
    <form
      className="onboarding-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (
          !slugValid ||
          !acknowledged ||
          name.trim().length < 2 ||
          !/^\S+@\S+\.\S+$/.test(support)
        ) {
          setState('error');
          const fieldId =
            name.trim().length < 2
              ? 'merchant-name'
              : !slugValid
                ? 'merchant-slug'
                : !/^\S+@\S+\.\S+$/.test(support)
                  ? 'merchant-support'
                  : 'merchant-policy';
          document.getElementById(fieldId)?.focus();
          return;
        }
        setState('pending');
        window.setTimeout(() => setState('complete'), 900);
      }}
    >
      <header className="page-heading">
        <p className="eyebrow">Merchant onboarding</p>
        <h1>Open your first tab</h1>
        <p>
          Create the public identity customers see before payment. You can resume this draft later.
        </p>
      </header>
      {state === 'error' ? (
        <div className="form-error-summary" role="alert" tabIndex={-1}>
          <strong>Review your profile</strong>
          <p>Complete the highlighted fields and policy acknowledgement.</p>
        </div>
      ) : null}
      <fieldset>
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
          {...(slugValid ? {} : { error: 'Use lowercase letters, numbers, and single hyphens.' })}
        />
        <TextArea
          label="Short introduction"
          defaultValue="Sunlit gatherings, good coffee, and small editions made to be remembered."
        />
      </fieldset>
      <fieldset>
        <legend>Support and payout</legend>
        <TextField
          id="merchant-support"
          label="Customer support email"
          onChange={(event) => setSupport(event.currentTarget.value)}
          required
          type="email"
          value={support}
        />
        <TextField
          description="Defaults to your verified embedded account. Changing it later requires an additional safety check."
          label="Payout destination"
          readOnly
          value="0x7D24…91C0"
        />
        <InlineAlert title="Payout ownership checked" tone="info">
          <p>
            The destination matches your authenticated account. Full address stays hidden in routine
            screens.
          </p>
        </InlineAlert>
      </fieldset>
      <Checkbox
        checked={acknowledged}
        description="You are responsible for offer accuracy, refund terms, customer support, and applicable local obligations."
        id="merchant-policy"
        label="I accept the merchant policy and confirm this payout destination"
        onChange={(event) => setAcknowledged(event.currentTarget.checked)}
      />
      <Button
        loading={state === 'pending'}
        loadingLabel="Activating merchant"
        size="large"
        type="submit"
      >
        Create merchant profile
      </Button>
    </form>
  );
}

export function MerchantSettings() {
  const [saved, setSaved] = useState(false);
  return (
    <div className="settings-layout">
      <header className="merchant-page-head">
        <div>
          <p className="eyebrow">Merchant settings</p>
          <h1>Profile, payout, and security</h1>
          <p>Changes with financial impact use separate safeguards.</p>
        </div>
      </header>
      {saved ? <InlineAlert title="Profile changes saved" tone="success" /> : null}
      <section className="settings-section">
        <div>
          <h2>Storefront profile</h2>
          <p>Customer-facing name and support details.</p>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setSaved(true);
          }}
        >
          <TextField defaultValue="Daylight Room" label="Display name" />
          <TextField defaultValue="hello@daylight.example" label="Support email" type="email" />
          <Button type="submit">Save profile</Button>
        </form>
      </section>
      <section className="settings-section">
        <div>
          <h2>Payout destination</h2>
          <p>A change requires renewed authentication and a cooling period.</p>
        </div>
        <div>
          <p className="mono">0x7D24…91C0</p>
          <Button variant="secondary">Start payout change</Button>
        </div>
      </section>
      <section className="settings-section">
        <div>
          <h2>Sessions</h2>
          <p>Revoke browser sessions without changing your embedded account.</p>
        </div>
        <div className="session-row">
          <div>
            <strong>Current session</strong>
            <span>Chrome · Lagos · active now</span>
          </div>
          <Button variant="secondary">Sign out other sessions</Button>
        </div>
      </section>
      <section className="settings-section">
        <div>
          <h2>Privacy and records</h2>
          <p>
            Request an export or begin an account deletion review. Financial records may need to be
            retained.
          </p>
        </div>
        <div className="page-actions">
          <Button variant="secondary">Request data export</Button>
          <Button variant="quiet">Review deletion request</Button>
        </div>
      </section>
      <section className="settings-section">
        <div>
          <h2>Recent audit activity</h2>
          <p>Security-relevant merchant actions.</p>
        </div>
        <ul className="audit-list">
          <li>
            <span>Product paused</span>
            <time dateTime="2026-07-09T16:20:00Z">9 Jul, 17:20 WAT</time>
          </li>
          <li>
            <span>Profile support email changed</span>
            <time dateTime="2026-07-08T09:10:00Z">8 Jul, 10:10 WAT</time>
          </li>
        </ul>
      </section>
    </div>
  );
}
