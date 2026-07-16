'use client';

import { Button, InlineAlert } from '@opentab/ui';
import { useCallback, useEffect, useState } from 'react';
import type { BrowserApplicationService } from '../application/browser-application-service';
import { TurnstileChallenge } from './turnstile-challenge';

type AccountSetupService = Pick<
  BrowserApplicationService,
  | 'checkWalletReadiness'
  | 'evaluateWalletPreparation'
  | 'getSponsorChallengeConfig'
  | 'prepareWalletAccount'
>;

export function AccountSetupPanel({
  onReady,
  service,
}: {
  onReady(): void;
  service: AccountSetupService;
}) {
  const [stage, setStage] = useState<'checking' | 'eligibility' | 'grant'>('checking');
  const [siteKey, setSiteKey] = useState<string>();
  const [token, setToken] = useState<string>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const receiveToken = useCallback((next: string | undefined) => setToken(next), []);

  useEffect(() => {
    let active = true;
    void Promise.all([service.checkWalletReadiness(), service.getSponsorChallengeConfig()])
      .then(([readiness, challenge]) => {
        if (!active) return;
        if (readiness.ready && readiness.blockers.length === 0) {
          onReady();
          return;
        }
        setSiteKey(challenge.siteKey);
        setStage('eligibility');
      })
      .catch((caught: unknown) => {
        if (!active) return;
        setError(
          caught instanceof Error ? caught.message : 'Account readiness could not be checked.',
        );
        setStage('eligibility');
      });
    return () => {
      active = false;
    };
  }, [onReady, service]);

  const continueSetup = async () => {
    if (stage === 'checking' || token === undefined) return;
    setPending(true);
    setError(undefined);
    try {
      if (stage === 'eligibility') {
        const result = await service.evaluateWalletPreparation(token);
        if (result.grantRequired) {
          setToken(undefined);
          setStage('grant');
          return;
        }
        const readiness = await service.prepareWalletAccount();
        if (!readiness.ready || readiness.blockers.length > 0) {
          throw new Error('Account setup is not canonically confirmed yet.');
        }
      } else {
        const readiness = await service.prepareWalletAccount(token);
        if (!readiness.ready || readiness.blockers.length > 0) {
          throw new Error('Account setup is not canonically confirmed yet.');
        }
      }
      onReady();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Account setup could not continue.');
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="onboarding-form">
      <header className="page-heading">
        <p className="eyebrow">Secure account readiness</p>
        <h1>Prepare your embedded account</h1>
        <p>Your address stays the same. Every commercial operation still requires exact review.</p>
      </header>
      {stage === 'checking' ? <p aria-live="polite">Checking account readiness…</p> : null}
      {stage !== 'checking' && siteKey === undefined ? (
        <InlineAlert title="Protected setup unavailable" tone="danger">
          <p>No setup grant was requested because the security challenge is not configured.</p>
        </InlineAlert>
      ) : null}
      {stage !== 'checking' && siteKey !== undefined ? (
        <TurnstileChallenge key={stage} onToken={receiveToken} siteKey={siteKey} />
      ) : null}
      {stage === 'grant' ? (
        <InlineAlert title="Fresh security check required" tone="info">
          <p>Complete this new check for the single bounded setup grant.</p>
        </InlineAlert>
      ) : null}
      {error === undefined ? null : (
        <InlineAlert title="Account setup did not continue" tone="warning">
          <p>{error}</p>
        </InlineAlert>
      )}
      {stage === 'checking' ? null : (
        <Button
          disabled={siteKey === undefined || token === undefined}
          loading={pending}
          onClick={() => void continueSetup()}
          size="large"
        >
          {stage === 'eligibility' ? 'Check setup eligibility' : 'Prepare account'}
        </Button>
      )}
    </section>
  );
}
