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
  | 'prepareSelfFundedWalletAccount'
>;

export function AccountSetupPanel({
  onReady,
  service,
}: {
  onReady(): void;
  service: AccountSetupService;
}) {
  const [stage, setStage] = useState<'checking' | 'choice' | 'grant'>('checking');
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
        setStage('choice');
      })
      .catch((caught: unknown) => {
        if (!active) return;
        setError(
          caught instanceof Error ? caught.message : 'Account readiness could not be checked.',
        );
        setStage('choice');
      });
    return () => {
      active = false;
    };
  }, [onReady, service]);

  const confirmReadiness = async (challengeToken?: string) => {
    const readiness =
      challengeToken === undefined
        ? await service.prepareWalletAccount()
        : await service.prepareWalletAccount(challengeToken);
    if (!readiness.ready || readiness.blockers.length > 0) {
      throw new Error('Account setup is not confirmed yet.');
    }
    onReady();
  };

  const continueSelfFundedSetup = async () => {
    if (stage === 'checking') return;
    setPending(true);
    setError(undefined);
    try {
      const readiness = await service.prepareSelfFundedWalletAccount();
      if (!readiness.ready || readiness.blockers.length > 0) {
        throw new Error('Account setup is not confirmed yet.');
      }
      onReady();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Account setup could not continue.');
    } finally {
      setPending(false);
    }
  };

  const continueSponsoredSetup = async () => {
    if (stage === 'checking' || token === undefined) return;
    setPending(true);
    setError(undefined);
    try {
      if (stage === 'choice') {
        const result = await service.evaluateWalletPreparation(token);
        setToken(undefined);
        if (result.grantRequired) {
          setStage('grant');
          return;
        }
        await confirmReadiness();
      } else {
        await confirmReadiness(token);
      }
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
      {stage !== 'checking' ? (
        <InlineAlert title="Use your existing Arbitrum fee balance" tone="info">
          <p>
            If this address has enough ETH on Arbitrum, prepare it directly. OpenTab still uses the
            exact server-approved account setup plan and verifies the result onchain.
          </p>
        </InlineAlert>
      ) : null}
      {stage !== 'checking' ? (
        <Button loading={pending} onClick={() => void continueSelfFundedSetup()} size="large">
          Prepare with my Arbitrum ETH
        </Button>
      ) : null}
      {stage !== 'checking' && siteKey === undefined ? (
        <InlineAlert title="Sponsored setup unavailable" tone="info">
          <p>The optional setup grant is off. Self-funded account preparation remains available.</p>
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
      {stage === 'checking' || siteKey === undefined ? null : (
        <Button
          disabled={token === undefined}
          loading={pending}
          onClick={() => void continueSponsoredSetup()}
          size="large"
          variant="secondary"
        >
          {stage === 'choice' ? 'Check sponsored setup' : 'Request one-time setup grant'}
        </Button>
      )}
    </section>
  );
}
