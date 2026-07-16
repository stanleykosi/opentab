import {
  AppError,
  BaseUnitAmountSchema,
  CurrentUserSchema,
  EvmAddressSchema,
  TransactionHashSchema,
  UserIdSchema,
} from '@opentab/shared';
import { describe, expect, it } from 'vitest';
import type {
  ArbitrumReadPort,
  ClockPort,
  DistributedLockPort,
  FeatureFlagPort,
  IdempotencyRepositoryPort,
  IdempotencyResult,
  RateLimitPort,
  SponsorTransferPort,
  TelemetryPort,
} from '../src/ports/index.js';
import {
  RequestBootstrapGrantUseCase,
  type SponsorBudgetReservation,
  type SponsorGrantRecord,
  type SponsorGrantStorePort,
  type SponsorPolicy,
} from '../src/use-cases/sponsor.js';

const recipient = EvmAddressSchema.parse(`0x${'1'.repeat(40)}`);
const otherRecipient = EvmAddressSchema.parse(`0x${'2'.repeat(40)}`);
const user = CurrentUserSchema.parse({
  id: UserIdSchema.parse('usr_01J00000000000000000000000'),
  walletAddress: recipient,
  authMethod: 'email_otp',
  status: 'active',
  merchantMemberships: [],
});
const now = new Date('2026-07-14T02:00:00.000Z');
const amount = (value: string) => BaseUnitAmountSchema.parse(value);
const transactionHash = TransactionHashSchema.parse(`0x${'3'.repeat(64)}`);

const policy: SponsorPolicy = {
  environment: 'demo-mainnet',
  targetWei: 1_000n,
  minimumGrantWei: 10n,
  perGrantCapWei: 500n,
  perAddressDailyCapWei: 500n,
  perIdentityDailyCapWei: 500n,
  perNetworkDailyCapWei: 5_000n,
  perDeviceDailyCapWei: 1_500n,
  globalDailyCapWei: 50_000n,
  lowBalanceAlertWei: 500n,
};

class MemoryIdempotency implements IdempotencyRepositoryPort {
  value: SponsorGrantRecord | undefined;
  state: 'created' | 'replayed' = 'created';

  async execute<T>(input: {
    scope: string;
    keyHash: string;
    requestHash: string;
    expiresAt: Date;
    operation: () => Promise<T>;
  }): Promise<IdempotencyResult<T>> {
    if (this.value !== undefined) return { state: this.state, value: this.value as T };
    const value = await input.operation();
    this.value = value as SponsorGrantRecord;
    return { state: 'created', value };
  }
}

class MemoryGrantStore implements SponsorGrantStorePort {
  pending = 100n;
  grant: SponsorGrantRecord | undefined;
  reservation:
    | {
        amountWei: bigint;
        budgets: readonly SponsorBudgetReservation[];
        budgetDate: string;
      }
    | undefined;

  async pendingAmountWei(): Promise<bigint> {
    return this.pending;
  }

  async reserveAndCreate(
    input: Parameters<SponsorGrantStorePort['reserveAndCreate']>[0],
  ): Promise<SponsorGrantRecord> {
    this.reservation = {
      amountWei: input.amountWei,
      budgets: input.budgets,
      budgetDate: input.budgetDate,
    };
    this.grant = {
      id: 'grant-1',
      userId: input.userId,
      recipient: input.recipient,
      amountWei: BaseUnitAmountSchema.parse(input.amountWei.toString()),
      status: 'created',
      createdAt: input.now.toISOString(),
    };
    return this.grant;
  }

  async findById(): Promise<SponsorGrantRecord | undefined> {
    return this.grant;
  }

  async markSubmissionStarted(
    input: Parameters<SponsorGrantStorePort['markSubmissionStarted']>[0],
  ): Promise<SponsorGrantRecord> {
    if (this.grant === undefined) throw new Error('Grant missing');
    if (this.grant.status !== 'created') return this.grant;
    this.grant = {
      ...this.grant,
      status: 'submission_started',
      sponsorSignerAddress: input.sponsorSignerAddress,
      signerNonce: input.signerNonce,
    };
    return this.grant;
  }

  async markTransferResult(
    input: Parameters<SponsorGrantStorePort['markTransferResult']>[0],
  ): Promise<SponsorGrantRecord> {
    if (this.grant === undefined) throw new Error('Grant missing');
    this.grant = {
      ...this.grant,
      status: input.result.status,
      ...(input.result.status === 'submitted'
        ? { transactionHash: input.result.transactionHash }
        : {}),
    };
    return this.grant;
  }

  async markTransactionPrepared(
    input: Parameters<SponsorGrantStorePort['markTransactionPrepared']>[0],
  ): Promise<SponsorGrantRecord> {
    if (this.grant === undefined) throw new Error('Grant missing');
    this.grant = { ...this.grant, transactionHash: input.transactionHash };
    return this.grant;
  }

  async markReplaced(): Promise<SponsorGrantRecord> {
    if (this.grant === undefined) throw new Error('Grant missing');
    this.grant = { ...this.grant, status: 'replaced' };
    return this.grant;
  }

  async markFailed(): Promise<void> {
    if (this.grant !== undefined) this.grant = { ...this.grant, status: 'failed' };
  }
}

function harness(
  input: {
    flagDecisions?: readonly boolean[];
    rateAllowed?: boolean;
    accountType?: 'eoa' | 'delegated_eoa' | 'contract';
    locksPort?: DistributedLockPort;
    transferPort?: SponsorTransferPort;
    pendingNonce?: string;
  } = {},
) {
  const grants = new MemoryGrantStore();
  const idempotency = new MemoryIdempotency();
  const locks: string[] = [];
  const transfers: string[] = [];
  const events: string[] = [];
  const increments: string[] = [];
  const flagsQueue = [...(input.flagDecisions ?? [true, true, true])];
  const chain: ArbitrumReadPort = {
    getLatestBlock: async () => {
      throw new Error('not used');
    },
    getBlock: async () => {
      throw new Error('not used');
    },
    getLogs: async () => {
      throw new Error('not used');
    },
    getNativeBalance: async () => '100',
    getDelegationCode: async () => ({
      accountType: input.accountType ?? 'eoa',
      codeHash: `0x${'0'.repeat(64)}`,
    }),
    getTransactionReceipt: async () => {
      throw new Error('not used');
    },
    findOrderEvent: async () => undefined,
    readProduct: async () => undefined,
  };
  const transfer: SponsorTransferPort = input.transferPort ?? {
    getSignerHealth: async () => ({
      signerAddress: otherRecipient,
      balanceWei: amount('10000'),
      pendingNonce: input.pendingNonce ?? '8',
      observedAt: now.toISOString(),
    }),
    prepareActivationGas: async (request) => {
      transfers.push(request.idempotencyReference);
      return {
        transactionHash,
        signerNonce: request.signerNonce,
        submit: async () => ({
          status: 'submitted',
          transactionHash,
          signerNonce: request.signerNonce,
        }),
      };
    },
  };
  const locksPort: DistributedLockPort = {
    async withLock<T>(
      key: string,
      _ttlMs: number,
      operation: (signal: AbortSignal) => Promise<T>,
    ): Promise<T> {
      locks.push(key);
      return operation(new AbortController().signal);
    },
  };
  const rateLimits: RateLimitPort = {
    consume: async () => ({ allowed: input.rateAllowed ?? true }),
  };
  const flags: FeatureFlagPort = {
    enabled: async () => flagsQueue.shift() ?? false,
  };
  const telemetry: TelemetryPort = {
    event: (name) => events.push(name),
    error: () => undefined,
    increment: (name) => increments.push(name),
  };
  const clock: ClockPort = { now: () => new Date(now) };
  const useCase = new RequestBootstrapGrantUseCase({
    chain,
    transfer,
    grants,
    idempotency,
    locks: input.locksPort ?? locksPort,
    rateLimits,
    flags,
    telemetry,
    clock,
    policy,
    globalBudgetSubjectHash: 'f'.repeat(64),
  });
  return { useCase, grants, idempotency, locks, transfers, events, increments };
}

const request = {
  user,
  recipient,
  identitySubjectHash: 'a'.repeat(64),
  addressSubjectHash: 'b'.repeat(64),
  networkSubjectHash: 'c'.repeat(64),
  deviceSubjectHash: 'd'.repeat(64),
  idempotencyKeyHash: 'e'.repeat(64),
  requestHash: '1'.repeat(64),
  requestId: 'req_sponsor',
};

describe('bootstrap sponsor abuse controls', () => {
  it('rejects an address mismatch before acquiring a lock or reading chain state', async () => {
    const h = harness();
    await expect(
      h.useCase.execute({ ...request, recipient: otherRecipient }),
    ).rejects.toMatchObject({
      code: 'WALLET_ADDRESS_MISMATCH',
    });
    expect(h.locks).toHaveLength(0);
  });

  it('uses one address lock and reserves exact deficit across every budget dimension', async () => {
    const h = harness();
    const result = await h.useCase.execute(request);

    expect(result.status).toBe('submitted');
    expect(result.amountWei).toBe('500');
    expect(h.locks).toEqual([
      `bootstrap-grant:demo-mainnet:${recipient.toLowerCase()}`,
      `bootstrap-signer:demo-mainnet:42161:${otherRecipient.toLowerCase()}`,
    ]);
    expect(h.grants.reservation?.amountWei).toBe(500n);
    expect(h.grants.reservation?.budgetDate).toBe('2026-07-14');
    expect(h.grants.reservation?.budgets.map((budget) => budget.scope)).toEqual([
      'global',
      'address',
      'identity',
      'network',
      'device',
    ]);
    expect(h.transfers).toEqual(['grant-1']);
  });

  it('fails closed on rate-limit abuse before reserving any budget', async () => {
    const h = harness({ rateAllowed: false });
    await expect(h.useCase.execute(request)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(h.grants.reservation).toBeUndefined();
    expect(h.transfers).toHaveLength(0);
  });

  it('never funds a contract recipient even when it matches the authenticated address', async () => {
    const h = harness({ accountType: 'contract' });
    await expect(h.useCase.execute(request)).rejects.toMatchObject({ code: 'SPONSOR_INELIGIBLE' });
    expect(h.grants.reservation).toBeUndefined();
    expect(h.transfers).toHaveLength(0);
  });

  it('rechecks the kill switch inside the lock and immediately before broadcast', async () => {
    const h = harness({ flagDecisions: [true, true, false] });
    await expect(h.useCase.execute(request)).rejects.toMatchObject({ code: 'SPONSOR_DISABLED' });
    expect(h.transfers).toHaveLength(0);
  });

  it('resumes a replayed reservation only after durably fixing its signer nonce', async () => {
    const h = harness();
    h.grants.grant = {
      id: 'grant-crash-recovery',
      userId: user.id,
      recipient,
      amountWei: amount('500'),
      status: 'created',
      createdAt: now.toISOString(),
    };
    h.idempotency.value = h.grants.grant;
    h.idempotency.state = 'replayed';

    const result = await h.useCase.execute(request);

    expect(result).toMatchObject({
      status: 'submitted',
      sponsorSignerAddress: otherRecipient,
      signerNonce: '8',
    });
    expect(h.transfers).toEqual(['grant-crash-recovery']);
  });

  it('never rebroadcasts when the durable nonce was consumed before restart recovery', async () => {
    const h = harness({ pendingNonce: '9' });
    h.grants.grant = {
      id: 'grant-after-possible-broadcast',
      userId: user.id,
      recipient,
      amountWei: amount('500'),
      status: 'submission_started',
      sponsorSignerAddress: otherRecipient,
      signerNonce: '8',
      createdAt: now.toISOString(),
    };
    h.idempotency.value = h.grants.grant;
    h.idempotency.state = 'replayed';

    const result = await h.useCase.execute(request);

    expect(result).toMatchObject({ status: 'replaced', signerNonce: '8' });
    expect(h.transfers).toHaveLength(0);
  });

  it('re-prepares and submits the exact reserved nonce after a crash before raw broadcast', async () => {
    const h = harness();
    h.grants.grant = {
      id: 'grant-prepared-before-crash',
      userId: user.id,
      recipient,
      amountWei: amount('500'),
      status: 'submission_started',
      sponsorSignerAddress: otherRecipient,
      signerNonce: '8',
      transactionHash,
      createdAt: now.toISOString(),
    };
    h.idempotency.value = h.grants.grant;
    h.idempotency.state = 'replayed';

    const result = await h.useCase.execute(request);

    expect(result).toMatchObject({
      status: 'submitted',
      transactionHash,
      signerNonce: '8',
    });
    expect(h.transfers).toEqual(['grant-prepared-before-crash']);
    expect(h.events).toContain('sponsor_grant_prepared_recovery');
  });

  it('persists the exact hash before an ambiguous send and never submits it twice', async () => {
    let submissions = 0;
    const transfer: SponsorTransferPort = {
      getSignerHealth: async () => ({
        signerAddress: otherRecipient,
        balanceWei: amount('10000'),
        pendingNonce: '8',
        observedAt: now.toISOString(),
      }),
      prepareActivationGas: async (prepared) => ({
        transactionHash,
        signerNonce: prepared.signerNonce,
        submit: async () => {
          submissions += 1;
          throw new AppError('SPONSOR_SUBMISSION_UNKNOWN', 'RPC timed out after raw send.', {
            retryable: true,
            submissionPossible: true,
          });
        },
      }),
    };
    const h = harness({
      transferPort: transfer,
      flagDecisions: [true, true, true, true, true],
    });

    await expect(h.useCase.execute(request)).rejects.toMatchObject({
      code: 'SPONSOR_SUBMISSION_UNKNOWN',
      submissionPossible: true,
    });
    expect(h.grants.grant).toMatchObject({
      status: 'submitted_unknown',
      transactionHash,
      signerNonce: '8',
    });
    h.idempotency.state = 'replayed';
    await expect(h.useCase.execute(request)).resolves.toMatchObject({
      status: 'submitted_unknown',
      transactionHash,
    });
    expect(submissions).toBe(1);
  });

  it('serializes two recipients at the shared signer nonce boundary', async () => {
    const tails = new Map<string, Promise<void>>();
    const sharedLock: DistributedLockPort = {
      async withLock<T>(
        key: string,
        _ttlMs: number,
        operation: (signal: AbortSignal) => Promise<T>,
      ): Promise<T> {
        const previous = tails.get(key) ?? Promise.resolve();
        let release: () => void = () => {};
        const current = new Promise<void>((resolve) => {
          release = resolve;
        });
        tails.set(key, current);
        await previous;
        try {
          return await operation(new AbortController().signal);
        } finally {
          release();
          if (tails.get(key) === current) tails.delete(key);
        }
      },
    };
    let nonce = 0;
    let transferActive = false;
    const observedNonces: string[] = [];
    const sharedTransfer: SponsorTransferPort = {
      getSignerHealth: async () => ({
        signerAddress: otherRecipient,
        balanceWei: amount('10000'),
        pendingNonce: nonce.toString(),
        observedAt: now.toISOString(),
      }),
      prepareActivationGas: async (transferRequest) => {
        if (transferActive) throw new Error('pending nonce collision');
        transferActive = true;
        await new Promise((resolve) => setTimeout(resolve, 5));
        const signerNonce = nonce.toString();
        expect(transferRequest.signerNonce).toBe(signerNonce);
        observedNonces.push(signerNonce);
        nonce += 1;
        transferActive = false;
        return {
          transactionHash,
          signerNonce,
          submit: async () => ({ status: 'submitted', transactionHash, signerNonce }),
        };
      },
    };
    const secondRecipient = EvmAddressSchema.parse(`0x${'4'.repeat(40)}`);
    const secondUser = CurrentUserSchema.parse({
      ...user,
      id: UserIdSchema.parse('usr_01J00000000000000000000002'),
      walletAddress: secondRecipient,
    });
    const first = harness({ locksPort: sharedLock, transferPort: sharedTransfer });
    const second = harness({ locksPort: sharedLock, transferPort: sharedTransfer });

    await Promise.all([
      first.useCase.execute(request),
      second.useCase.execute({
        ...request,
        user: secondUser,
        recipient: secondRecipient,
        identitySubjectHash: '4'.repeat(64),
        addressSubjectHash: '5'.repeat(64),
        idempotencyKeyHash: '6'.repeat(64),
        requestHash: '7'.repeat(64),
      }),
    ]);

    expect(observedNonces).toEqual(['0', '1']);
  });
});
