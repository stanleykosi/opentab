import { parseFrontendFeatureEnvironment } from '@opentab/config';
import type { FrontendFeatureState } from './view-models';

export function resolveFrontendFeatureState(input: {
  environment: string;
  providerMode: 'deterministic' | 'live';
  deterministicDemo: boolean;
  payments: boolean;
  refunds: boolean;
  withdrawals: boolean;
  splits: boolean;
  judgeMode: boolean;
}): FrontendFeatureState {
  const { environment } = input;
  const deterministic = input.deterministicDemo;
  const production = environment === 'production';
  const live = input.providerMode === 'live';
  return {
    mode:
      production && deterministic
        ? 'live-unavailable'
        : deterministic
          ? 'deterministic'
          : live
            ? 'live'
            : 'live-unavailable',
    environment,
    payments: deterministic || input.payments,
    refunds: deterministic || input.refunds,
    withdrawals: deterministic || input.withdrawals,
    splits: deterministic || input.splits,
    judgeMode: deterministic || input.judgeMode,
  };
}

let serverFeatureState: FrontendFeatureState | undefined;

export function getServerFeatureState(): FrontendFeatureState {
  serverFeatureState ??= resolveFrontendFeatureState(parseFrontendFeatureEnvironment(process.env));
  return serverFeatureState;
}
