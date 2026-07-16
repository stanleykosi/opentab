'use client';

import { InlineAlert } from '@opentab/ui';
import { useEffect, useRef, useState } from 'react';

const TURNSTILE_SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

interface TurnstileApi {
  render(
    container: HTMLElement,
    options: {
      sitekey: string;
      action: 'opentab-bootstrap';
      theme: 'auto';
      size: 'flexible';
      callback(token: string): void;
      'expired-callback'(): void;
      'timeout-callback'(): void;
      'error-callback'(): void;
    },
  ): string;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let scriptPromise: Promise<TurnstileApi> | undefined;

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile !== undefined) return Promise.resolve(window.turnstile);
  scriptPromise ??= new Promise<TurnstileApi>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${TURNSTILE_SCRIPT}"]`);
    const script = existing ?? document.createElement('script');
    const loaded = () => {
      if (window.turnstile === undefined) {
        reject(new Error('Turnstile did not initialize.'));
        return;
      }
      resolve(window.turnstile);
    };
    script.addEventListener('load', loaded, { once: true });
    script.addEventListener('error', () => reject(new Error('Turnstile failed to load.')), {
      once: true,
    });
    if (existing === null) {
      script.src = TURNSTILE_SCRIPT;
      script.async = true;
      script.defer = true;
      document.head.append(script);
    }
  }).catch((error: unknown) => {
    scriptPromise = undefined;
    throw error;
  });
  return scriptPromise;
}

export function TurnstileChallenge({
  onToken,
  siteKey,
}: {
  siteKey: string;
  onToken(token: string | undefined): void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    let widget: { api: TurnstileApi; id: string } | undefined;
    onToken(undefined);
    void loadTurnstile()
      .then((api) => {
        if (!active || containerRef.current === null) return;
        const id = api.render(containerRef.current, {
          sitekey: siteKey,
          action: 'opentab-bootstrap',
          theme: 'auto',
          size: 'flexible',
          callback: (token) => {
            if (active) {
              setFailed(false);
              onToken(token);
            }
          },
          'expired-callback': () => {
            if (active) onToken(undefined);
          },
          'timeout-callback': () => {
            if (active) onToken(undefined);
          },
          'error-callback': () => {
            if (active) {
              onToken(undefined);
              setFailed(true);
            }
          },
        });
        widget = { api, id };
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
      onToken(undefined);
      if (widget !== undefined) widget.api.remove(widget.id);
    };
  }, [onToken, siteKey]);

  return (
    <section aria-label="Security check" className="turnstile-challenge">
      <div ref={containerRef} />
      {failed ? (
        <InlineAlert title="Security check unavailable" tone="warning">
          <p>Check your connection, then reload this checkout. No account setup was submitted.</p>
        </InlineAlert>
      ) : null}
    </section>
  );
}
