const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;

export type JudgeCapabilityResult =
  | { kind: 'public' }
  | { kind: 'protected'; capability: string }
  | { kind: 'invalid' };

function capabilityFromFragment(fragment: string): string | undefined {
  if (CAPABILITY_PATTERN.test(fragment)) return fragment;
  const parameters = new URLSearchParams(fragment);
  if ([...parameters.keys()].some((key) => key !== 'token')) return undefined;
  const values = parameters.getAll('token');
  return values.length === 1 && CAPABILITY_PATTERN.test(values[0] ?? '') ? values[0] : undefined;
}

/**
 * Removes a Judge capability from the visible URL/history before returning it
 * to the caller. The token is intentionally never stored in React state.
 */
export function takeJudgeCapability(
  location: Pick<Location, 'hash' | 'pathname' | 'search'>,
  history: Pick<History, 'replaceState' | 'state'>,
): JudgeCapabilityResult {
  const hash = location.hash;
  if (hash.length === 0) return { kind: 'public' };

  history.replaceState(history.state, '', `${location.pathname}${location.search}`);
  const capability = capabilityFromFragment(hash.slice(1));
  return capability === undefined ? { kind: 'invalid' } : { kind: 'protected', capability };
}

export function protectedJudgeHref(orderId: string, capability: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(orderId) || !CAPABILITY_PATTERN.test(capability)) {
    throw new Error('Invalid Judge proof link values.');
  }
  return `/judge/${encodeURIComponent(orderId)}#token=${encodeURIComponent(capability)}`;
}
