import type { CanonicalConfirmationView, CheckoutSnapshotView } from './view-models';
import { assign, setup } from './xstate-runtime.js';

export interface CheckoutMachineContext {
  snapshot: CheckoutSnapshotView;
  repeatPaymentBlocked: boolean;
  lastError: { message: string; retrySafe: boolean; fundsMayHaveMoved: boolean } | undefined;
}

export type CheckoutMachineEvent =
  | { type: 'CONTINUE' }
  | { type: 'SESSION_CREATED' }
  | { type: 'AUTHENTICATED' }
  | { type: 'READINESS_REQUIRED' }
  | { type: 'READINESS_READY' }
  | { type: 'PREPARE_ACCOUNT' }
  | { type: 'ACCOUNT_READY' }
  | { type: 'BALANCE_LOADED'; snapshot?: CheckoutSnapshotView }
  | { type: 'PREPARE_PAYMENT' }
  | { type: 'PREVIEW_READY'; snapshot?: CheckoutSnapshotView }
  | { type: 'CONFIRM_PAYMENT' }
  | { type: 'SIGNATURE_APPROVED' }
  | { type: 'SUBMISSION_REGISTERED'; snapshot?: CheckoutSnapshotView }
  | { type: 'PROVIDER_EXECUTED'; snapshot?: CheckoutSnapshotView }
  | { type: 'CANONICAL_CONFIRMED'; proof: CanonicalConfirmationView }
  | { type: 'TIMEOUT_AFTER_POSSIBLE_SUBMISSION' }
  | { type: 'CHECK_STATUS' }
  | { type: 'STATUS_STILL_UNKNOWN' }
  | { type: 'FAIL_PRE_SUBMISSION'; message: string }
  | { type: 'FAIL_CONFIRMED'; message: string }
  | { type: 'RETRY_SAFE' }
  | { type: 'CANCEL' }
  | { type: 'EXPIRE' };

function hasCanonicalFinality(proof: CanonicalConfirmationView | undefined): boolean {
  return Boolean(
    proof?.canonical &&
      proof.eventName === 'OrderPaid' &&
      BigInt(proof.confirmations) >= BigInt(proof.requiredConfirmations),
  );
}

const checkoutSetup = setup({
  types: {
    context: {} as CheckoutMachineContext,
    events: {} as CheckoutMachineEvent,
    input: {} as CheckoutSnapshotView,
  },
  guards: {
    restoredCanonical: ({ context }) =>
      hasCanonicalFinality(context.snapshot.canonicalConfirmation),
    restoredUnknown: ({ context }) =>
      context.snapshot.submissionPossible || context.snapshot.state === 'submitted_status_unknown',
    restoredPreview: ({ context }) => context.snapshot.state === 'preview_ready',
    restoredReady: ({ context }) => context.snapshot.state === 'ready_to_pay',
    restoredNeedsAccount: ({ context }) => context.snapshot.state === 'sponsor_required',
    restoredTerminal: ({ context }) => context.snapshot.state === 'terminal_failure',
    restoredExpired: ({ context }) => context.snapshot.state === 'expired',
    restoredRetryable: ({ context }) => context.snapshot.state === 'retryable_failure',
    eventHasCanonicalFinality: ({ event }) =>
      event.type === 'CANONICAL_CONFIRMED' && hasCanonicalFinality(event.proof),
  },
  actions: {
    blockRepeat: assign<CheckoutMachineContext, CheckoutMachineEvent>({
      repeatPaymentBlocked: true,
    }),
    clearError: assign<CheckoutMachineContext, CheckoutMachineEvent>({ lastError: undefined }),
    recordPreSubmissionFailure: assign<CheckoutMachineContext, CheckoutMachineEvent>({
      repeatPaymentBlocked: false,
      lastError: ({ event }) =>
        event.type === 'FAIL_PRE_SUBMISSION'
          ? { message: event.message, retrySafe: true, fundsMayHaveMoved: false }
          : undefined,
    }),
    recordFinalFailure: assign<CheckoutMachineContext, CheckoutMachineEvent>({
      repeatPaymentBlocked: true,
      lastError: ({ event }) =>
        event.type === 'FAIL_CONFIRMED'
          ? { message: event.message, retrySafe: false, fundsMayHaveMoved: true }
          : undefined,
    }),
    recordCanonicalProof: assign<CheckoutMachineContext, CheckoutMachineEvent>({
      snapshot: ({ context, event }) =>
        event.type === 'CANONICAL_CONFIRMED'
          ? { ...context.snapshot, canonicalConfirmation: event.proof, state: 'confirmed' }
          : context.snapshot,
    }),
    recordSnapshot: assign<CheckoutMachineContext, CheckoutMachineEvent>({
      snapshot: ({ context, event }) =>
        'snapshot' in event && event.snapshot !== undefined ? event.snapshot : context.snapshot,
    }),
  },
});

export const checkoutMachine = checkoutSetup.createMachine({
  id: 'checkout',
  initial: 'restoring',
  context: ({ input }: { input: CheckoutSnapshotView }) => ({
    snapshot: input,
    repeatPaymentBlocked: input.submissionPossible,
    lastError: undefined,
  }),
  states: {
    restoring: {
      always: [
        { guard: 'restoredCanonical', target: 'confirmed' },
        { guard: 'restoredUnknown', target: 'submitted_status_unknown', actions: 'blockRepeat' },
        { guard: 'restoredPreview', target: 'preview_ready' },
        { guard: 'restoredReady', target: 'ready_to_pay' },
        { guard: 'restoredNeedsAccount', target: 'sponsor_required' },
        { guard: 'restoredTerminal', target: 'terminal_failure' },
        { guard: 'restoredExpired', target: 'expired' },
        { guard: 'restoredRetryable', target: 'retryable_failure' },
        { target: 'product_ready' },
      ],
    },
    product_ready: { on: { CONTINUE: 'creating_session', EXPIRE: 'expired' } },
    creating_session: {
      on: {
        SESSION_CREATED: 'authenticating',
        FAIL_PRE_SUBMISSION: { target: 'retryable_failure', actions: 'recordPreSubmissionFailure' },
        CANCEL: 'cancelled',
      },
    },
    authenticating: {
      on: {
        AUTHENTICATED: 'checking_readiness',
        FAIL_PRE_SUBMISSION: { target: 'retryable_failure', actions: 'recordPreSubmissionFailure' },
        CANCEL: 'cancelled',
      },
    },
    checking_readiness: {
      on: {
        READINESS_REQUIRED: 'sponsor_required',
        READINESS_READY: 'loading_balance',
        FAIL_PRE_SUBMISSION: { target: 'retryable_failure', actions: 'recordPreSubmissionFailure' },
      },
    },
    sponsor_required: { on: { PREPARE_ACCOUNT: 'preparing_account', CANCEL: 'cancelled' } },
    preparing_account: {
      on: {
        ACCOUNT_READY: 'loading_balance',
        FAIL_PRE_SUBMISSION: { target: 'retryable_failure', actions: 'recordPreSubmissionFailure' },
        CANCEL: 'cancelled',
      },
    },
    loading_balance: {
      on: {
        BALANCE_LOADED: { target: 'ready_to_pay', actions: 'recordSnapshot' },
        FAIL_PRE_SUBMISSION: { target: 'retryable_failure', actions: 'recordPreSubmissionFailure' },
      },
    },
    ready_to_pay: {
      on: {
        PREPARE_PAYMENT: 'preparing_payment',
        FAIL_PRE_SUBMISSION: { target: 'retryable_failure', actions: 'recordPreSubmissionFailure' },
        EXPIRE: 'expired',
      },
    },
    preparing_payment: {
      on: {
        PREVIEW_READY: { target: 'preview_ready', actions: 'recordSnapshot' },
        FAIL_PRE_SUBMISSION: { target: 'retryable_failure', actions: 'recordPreSubmissionFailure' },
        CANCEL: 'cancelled',
      },
    },
    preview_ready: {
      on: {
        CONFIRM_PAYMENT: { target: 'signing_root_hash', actions: 'blockRepeat' },
        EXPIRE: 'expired',
        CANCEL: 'cancelled',
      },
    },
    signing_root_hash: {
      on: {
        SIGNATURE_APPROVED: 'submitting_particle',
        FAIL_PRE_SUBMISSION: { target: 'retryable_failure', actions: 'recordPreSubmissionFailure' },
        TIMEOUT_AFTER_POSSIBLE_SUBMISSION: {
          target: 'submitted_status_unknown',
          actions: 'blockRepeat',
        },
      },
    },
    submitting_particle: {
      on: {
        SUBMISSION_REGISTERED: { target: 'waiting_for_particle', actions: 'recordSnapshot' },
        TIMEOUT_AFTER_POSSIBLE_SUBMISSION: {
          target: 'submitted_status_unknown',
          actions: 'blockRepeat',
        },
      },
    },
    waiting_for_particle: {
      on: {
        PROVIDER_EXECUTED: { target: 'waiting_for_arbitrum', actions: 'recordSnapshot' },
        CANONICAL_CONFIRMED: {
          guard: 'eventHasCanonicalFinality',
          target: 'confirmed',
          actions: 'recordCanonicalProof',
        },
        TIMEOUT_AFTER_POSSIBLE_SUBMISSION: {
          target: 'submitted_status_unknown',
          actions: 'blockRepeat',
        },
        FAIL_CONFIRMED: { target: 'terminal_failure', actions: 'recordFinalFailure' },
      },
    },
    waiting_for_arbitrum: {
      on: {
        CANONICAL_CONFIRMED: {
          guard: 'eventHasCanonicalFinality',
          target: 'confirmed',
          actions: 'recordCanonicalProof',
        },
        TIMEOUT_AFTER_POSSIBLE_SUBMISSION: {
          target: 'submitted_status_unknown',
          actions: 'blockRepeat',
        },
        FAIL_CONFIRMED: { target: 'terminal_failure', actions: 'recordFinalFailure' },
      },
    },
    submitted_status_unknown: {
      on: {
        CHECK_STATUS: 'checking_status',
        CANONICAL_CONFIRMED: {
          guard: 'eventHasCanonicalFinality',
          target: 'confirmed',
          actions: 'recordCanonicalProof',
        },
      },
    },
    checking_status: {
      on: {
        STATUS_STILL_UNKNOWN: 'submitted_status_unknown',
        CANONICAL_CONFIRMED: {
          guard: 'eventHasCanonicalFinality',
          target: 'confirmed',
          actions: 'recordCanonicalProof',
        },
        FAIL_CONFIRMED: { target: 'terminal_failure', actions: 'recordFinalFailure' },
      },
    },
    retryable_failure: {
      on: {
        RETRY_SAFE: { target: 'checking_readiness', actions: 'clearError' },
        CANCEL: 'cancelled',
      },
    },
    terminal_failure: { type: 'final' },
    confirmed: { type: 'final' },
    cancelled: { type: 'final' },
    expired: { type: 'final' },
  },
});

export function paymentCanRepeat(stateValue: string, context: CheckoutMachineContext): boolean {
  return (
    !context.repeatPaymentBlocked &&
    ![
      'signing_root_hash',
      'submitting_particle',
      'waiting_for_particle',
      'waiting_for_arbitrum',
      'submitted_status_unknown',
      'checking_status',
      'confirmed',
    ].includes(stateValue)
  );
}
