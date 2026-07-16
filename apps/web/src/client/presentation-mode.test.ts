import { describe, expect, it } from 'vitest';
import { resolveFrontendFeatureState } from './presentation-mode';

describe('frontend presentation mode', () => {
  it('does not activate deterministic fixtures from local development alone', () => {
    expect(
      resolveFrontendFeatureState({
        environment: 'local',
        providerMode: 'deterministic',
        deterministicDemo: false,
        payments: false,
        refunds: false,
        withdrawals: false,
        splits: false,
        judgeMode: false,
      }),
    ).toMatchObject({ mode: 'live-unavailable', payments: false, judgeMode: false });
  });

  it('requires an explicit flag for the visibly deterministic path', () => {
    expect(
      resolveFrontendFeatureState({
        environment: 'local',
        providerMode: 'deterministic',
        deterministicDemo: true,
        payments: false,
        refunds: false,
        withdrawals: false,
        splits: false,
        judgeMode: false,
      }),
    ).toMatchObject({ mode: 'deterministic', payments: true, judgeMode: true });
  });

  it('never allows deterministic fixtures to turn production into demo mode', () => {
    expect(
      resolveFrontendFeatureState({
        environment: 'production',
        providerMode: 'deterministic',
        deterministicDemo: true,
        payments: true,
        refunds: true,
        withdrawals: true,
        splits: true,
        judgeMode: true,
      }).mode,
    ).toBe('live-unavailable');
  });

  it('keeps the live application available while the guarded payment flag is off', () => {
    const base = {
      environment: 'demo-mainnet',
      deterministicDemo: false,
      refunds: false,
      withdrawals: false,
      splits: false,
      judgeMode: false,
    };
    expect(
      resolveFrontendFeatureState({ ...base, providerMode: 'live', payments: false }).mode,
    ).toBe('live');
    expect(
      resolveFrontendFeatureState({ ...base, providerMode: 'live', payments: false }).payments,
    ).toBe(false);
    expect(
      resolveFrontendFeatureState({ ...base, providerMode: 'live', payments: true }).mode,
    ).toBe('live');
  });
});
