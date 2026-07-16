import type {
  AuthContinuationServicePort,
  BackendApiCommandPort,
  BackendApiQueryPort,
  BackendApiResourceQueryPort,
  CsrfSessionServicePort,
  ExchangeSessionUseCase,
  FeatureFlagPort,
  LogoutSessionUseCase,
  RateLimitPort,
  RefreshSessionUseCase,
} from '@opentab/application';
import { AppError } from '@opentab/shared';

export interface BackendApiRegistry {
  readonly sessions: CsrfSessionServicePort;
  readonly authContinuations: AuthContinuationServicePort;
  readonly exchangeSession: Pick<ExchangeSessionUseCase, 'execute'>;
  readonly refreshSession: Pick<RefreshSessionUseCase, 'execute'>;
  readonly logoutSession: Pick<LogoutSessionUseCase, 'execute'>;
  readonly queries: BackendApiQueryPort;
  readonly resourceQueries: BackendApiResourceQueryPort;
  readonly commands: BackendApiCommandPort;
  readonly featureFlags: FeatureFlagPort;
  readonly rateLimits: RateLimitPort;
  readonly requestLog: {
    info(fields: Readonly<Record<string, string | number | boolean>>): void;
    error(fields: Readonly<Record<string, string | number | boolean>>): void;
  };
  readonly allowedOrigin: string;
  readonly sessionCookieName: '__Host-opentab_session' | 'opentab_session';
  readonly authContinuationCookieName: '__Host-opentab_auth_state' | 'opentab_auth_state';
  readonly sessionCookieSecure: boolean;
  readonly digestSecret: (domain: string, value: string) => string;
  readonly networkSubject: (request: Request) => string;
}

const commandMethods: readonly (keyof BackendApiCommandPort)[] = [
  'createMerchant',
  'updateMerchantProfile',
  'onboardMerchant',
  'createProduct',
  'updateProduct',
  'changeProductStatus',
  'createCheckoutLink',
  'createCheckoutSession',
  'bindCheckoutSession',
  'refreshCheckoutQuote',
  'createPaymentAttempt',
  'recordPreparedPayment',
  'startPaymentSubmission',
  'registerPaymentSubmission',
  'recoverPaymentAttempt',
  'recordDelegationEvidence',
  'evaluateBootstrapEligibility',
  'requestBootstrapGrant',
  'prepareRefund',
  'registerRefundSubmission',
  'prepareWithdrawal',
  'registerWithdrawalSubmission',
  'updateLoyalty',
  'createSplit',
  'inviteSplitParticipants',
  'revokeSplit',
  'prepareSplitPayment',
  'registerSplitPaymentSubmission',
  'registerContractOperationSubmission',
  'materializeJudgeEvidence',
  'publishJudgeEvidence',
  'revokeJudgeEvidence',
];

const resourceQueryMethods: readonly (keyof BackendApiResourceQueryPort)[] = [
  'getPublicConfig',
  'getMerchantProfile',
  'getMerchantMembership',
  'getCheckoutLink',
  'getWalletReadiness',
  'getWalletBalance',
  'getPaymentRecovery',
  'getReceipt',
  'getRefund',
  'getSettlement',
  'getWithdrawal',
  'getLoyaltyStatus',
  'getSplitPayment',
  'getContractOperation',
  'getHealth',
  'getReadiness',
];

const queryMethods: readonly (keyof BackendApiQueryPort)[] = [
  'getMerchantCatalog',
  'getPublicProductById',
  'getPublicProductBySlugs',
  'getPassMetadataProduct',
  'getCheckoutForActor',
  'getAttemptForActor',
  'getPaymentWorkflowForActor',
  'getOrderForActor',
  'getMerchantSummary',
  'listMerchantOrders',
  'listCustomerOrders',
  'listMerchantProducts',
  'getMerchantProductForActor',
  'getSplitByCapability',
  'getJudgeProof',
  'getSponsorGrantForActor',
];

let registry: BackendApiRegistry | undefined;
let initialization: Promise<void> | undefined;

function assertMethods(object: object, methods: readonly PropertyKey[], label: string): void {
  const record = object as Readonly<Record<PropertyKey, unknown>>;
  for (const method of methods) {
    if (typeof record[method] !== 'function') {
      throw new AppError('CONFIGURATION_INVALID', `${label}.${String(method)} is not configured.`);
    }
  }
}

export function installBackendApiRegistry(input: BackendApiRegistry): void {
  if (registry !== undefined) {
    throw new AppError('CONFIGURATION_INVALID', 'The backend API registry is already installed.');
  }
  const origin = new URL(input.allowedOrigin);
  const localHttp =
    origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if (origin.origin !== input.allowedOrigin || (origin.protocol !== 'https:' && !localHttp)) {
    throw new AppError('CONFIGURATION_INVALID', 'The backend API origin is invalid.');
  }
  if (input.sessionCookieName === '__Host-opentab_session' && !input.sessionCookieSecure) {
    throw new AppError('CONFIGURATION_INVALID', 'The __Host session cookie must be Secure.');
  }
  assertMethods(input.commands, commandMethods, 'commands');
  assertMethods(input.queries, queryMethods, 'queries');
  assertMethods(input.resourceQueries, resourceQueryMethods, 'resourceQueries');
  assertMethods(
    input.sessions,
    ['create', 'verify', 'verifyCsrf', 'refresh', 'revoke'],
    'sessions',
  );
  assertMethods(input.authContinuations, ['issue', 'consume'], 'authContinuations');
  assertMethods(input.exchangeSession, ['execute'], 'exchangeSession');
  assertMethods(input.refreshSession, ['execute'], 'refreshSession');
  assertMethods(input.logoutSession, ['execute'], 'logoutSession');
  assertMethods(input.featureFlags, ['enabled'], 'featureFlags');
  assertMethods(input.rateLimits, ['consume'], 'rateLimits');
  assertMethods(input.requestLog, ['info', 'error'], 'requestLog');
  if (typeof input.digestSecret !== 'function' || typeof input.networkSubject !== 'function') {
    throw new AppError('CONFIGURATION_INVALID', 'Backend API digest services are not configured.');
  }
  const expectedContinuationCookie = input.sessionCookieSecure
    ? '__Host-opentab_auth_state'
    : 'opentab_auth_state';
  if (input.authContinuationCookieName !== expectedContinuationCookie) {
    throw new AppError('CONFIGURATION_INVALID', 'The auth continuation cookie mode is invalid.');
  }
  registry = Object.freeze(input);
}

export function getBackendApiRegistry(): BackendApiRegistry {
  if (registry === undefined) {
    throw new AppError('CONFIGURATION_INVALID', 'The backend API is not configured.');
  }
  return registry;
}

export function isBackendApiRegistryInstalled(): boolean {
  return registry !== undefined;
}

export async function ensureBackendApiRegistry(): Promise<void> {
  if (registry !== undefined) return;
  initialization ??= import('./composition.js')
    .then(({ installComposedBackendApiRegistry }) => installComposedBackendApiRegistry())
    .catch((error: unknown) => {
      initialization = undefined;
      throw error;
    });
  await initialization;
}

export function resetBackendApiRegistryForTests(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('The backend API registry can only be reset by tests');
  }
  registry = undefined;
  initialization = undefined;
}
