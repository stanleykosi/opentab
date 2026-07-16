import {
  AppError,
  ARBITRUM_ONE_CHAIN_ID,
  type BaseUnitAmount,
  BaseUnitAmountSchema,
  type CurrentUser,
  type EvmAddress,
  sameEvmAddress,
} from '@opentab/shared';
import type {
  ArbitrumReadPort,
  ClockPort,
  DistributedLockPort,
  FeatureFlagPort,
  IdempotencyRepositoryPort,
  RateLimitPort,
  SponsorTransferPort,
  TelemetryPort,
} from '../ports/index.js';

export interface SponsorBudgetReservation {
  readonly scope: 'global' | 'address' | 'identity' | 'network' | 'device';
  readonly subjectHash: string;
  readonly limitWei: bigint;
  readonly countLimit: number;
}

export interface SponsorGrantRecord {
  readonly id: string;
  readonly userId: string;
  readonly recipient: EvmAddress;
  readonly amountWei: BaseUnitAmount;
  readonly status:
    | 'created'
    | 'submission_started'
    | 'submitted'
    | 'submitted_unknown'
    | 'confirmed'
    | 'failed'
    | 'replaced'
    | 'orphaned';
  readonly transactionHash?: string;
  readonly sponsorSignerAddress?: EvmAddress;
  readonly signerNonce?: string;
  readonly createdAt: string;
}

export interface SponsorGrantStorePort {
  pendingAmountWei(input: { environment: string; recipient: EvmAddress }): Promise<bigint>;
  reserveAndCreate(input: {
    environment: 'local' | 'test' | 'preview' | 'staging' | 'demo-mainnet' | 'production';
    userId: string;
    identitySubjectHash: string;
    recipient: EvmAddress;
    idempotencyKeyHash: string;
    requestId: string;
    balanceBeforeWei: bigint;
    targetWei: bigint;
    amountWei: bigint;
    budgetDate: string;
    budgets: readonly SponsorBudgetReservation[];
    now: Date;
  }): Promise<SponsorGrantRecord>;
  findById(id: string): Promise<SponsorGrantRecord | undefined>;
  markSubmissionStarted(input: {
    id: string;
    sponsorSignerAddress: EvmAddress;
    signerNonce: string;
    now: Date;
  }): Promise<SponsorGrantRecord>;
  markTransactionPrepared(input: {
    id: string;
    transactionHash: string;
    signerNonce: string;
    now: Date;
  }): Promise<SponsorGrantRecord>;
  markTransferResult(input: {
    id: string;
    result:
      | { status: 'submitted'; transactionHash: string; signerNonce: string }
      | { status: 'submitted_unknown'; transactionHash: string; signerNonce: string };
    now: Date;
  }): Promise<SponsorGrantRecord>;
  markFailed(input: { id: string; errorCode: string; now: Date }): Promise<void>;
  markReplaced(input: { id: string; reason: string; now: Date }): Promise<SponsorGrantRecord>;
}

export interface SponsorPolicy {
  readonly environment: 'local' | 'test' | 'preview' | 'staging' | 'demo-mainnet' | 'production';
  readonly targetWei: bigint;
  readonly minimumGrantWei: bigint;
  readonly perGrantCapWei: bigint;
  readonly perAddressDailyCapWei: bigint;
  readonly perIdentityDailyCapWei: bigint;
  readonly perNetworkDailyCapWei: bigint;
  readonly perDeviceDailyCapWei: bigint;
  readonly globalDailyCapWei: bigint;
  readonly lowBalanceAlertWei: bigint;
}

export interface SponsorGrantReconciliationCandidate {
  readonly id: string;
  readonly status:
    | 'submission_started'
    | 'submitted'
    | 'submitted_unknown'
    | 'confirmed'
    | 'orphaned';
  readonly recipient: EvmAddress;
  readonly amountWei: BaseUnitAmount;
  readonly sponsorSignerAddress: EvmAddress;
  readonly signerNonce: string;
  /** Every exact transaction prepared for the single reserved nonce, oldest first. */
  readonly transactionHashes: readonly string[];
  readonly transactionHash: string;
  readonly blockNumber?: string;
  readonly blockHash?: string;
}

export interface SponsorGrantReconciliationStorePort {
  listCandidates(input: { limit: number }): Promise<readonly SponsorGrantReconciliationCandidate[]>;
  markCanonicalOutcome(
    input:
      | {
          id: string;
          expectedTransactionHash: string;
          outcome: 'confirmed';
          blockNumber: string;
          blockHash: string;
          now: Date;
        }
      | {
          id: string;
          expectedTransactionHash: string;
          outcome: 'failed';
          blockNumber: string;
          blockHash: string;
          errorCode: string;
          now: Date;
        }
      | {
          id: string;
          expectedTransactionHash: string;
          outcome: 'orphaned';
          now: Date;
        },
  ): Promise<void>;
}

function utcBudgetDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function assertDigest(label: string, value: string): void {
  if (!/^[0-9a-f]{64}$/i.test(value)) {
    throw new AppError('VALIDATION_FAILED', `${label} is invalid.`);
  }
}

export class RequestBootstrapGrantUseCase {
  constructor(
    private readonly dependencies: {
      chain: ArbitrumReadPort;
      transfer: SponsorTransferPort;
      grants: SponsorGrantStorePort;
      idempotency: IdempotencyRepositoryPort;
      locks: DistributedLockPort;
      rateLimits: RateLimitPort;
      flags: FeatureFlagPort;
      telemetry: TelemetryPort;
      clock: ClockPort;
      policy: SponsorPolicy;
      globalBudgetSubjectHash: string;
    },
  ) {
    const policy = dependencies.policy;
    if (
      policy.minimumGrantWei <= 0n ||
      policy.targetWei <= 0n ||
      policy.perGrantCapWei < policy.minimumGrantWei ||
      policy.perAddressDailyCapWei < policy.perGrantCapWei ||
      policy.perIdentityDailyCapWei < policy.perGrantCapWei ||
      policy.perNetworkDailyCapWei < policy.perGrantCapWei ||
      policy.perDeviceDailyCapWei < policy.perGrantCapWei ||
      policy.globalDailyCapWei < policy.perGrantCapWei ||
      policy.lowBalanceAlertWei < policy.perGrantCapWei
    ) {
      throw new AppError('CONFIGURATION_INVALID', 'The sponsor policy is internally inconsistent.');
    }
    assertDigest('Global budget subject', dependencies.globalBudgetSubjectHash);
  }

  async execute(input: {
    user: CurrentUser;
    recipient: EvmAddress;
    identitySubjectHash: string;
    addressSubjectHash: string;
    networkSubjectHash: string;
    deviceSubjectHash: string;
    idempotencyKeyHash: string;
    requestHash: string;
    requestId: string;
  }): Promise<SponsorGrantRecord> {
    if (input.user.status !== 'active')
      throw new AppError('AUTH_FORBIDDEN', 'This account is not active.');
    if (!sameEvmAddress(input.user.walletAddress, input.recipient)) {
      throw new AppError(
        'WALLET_ADDRESS_MISMATCH',
        'The sponsor recipient does not match your wallet.',
      );
    }
    for (const [label, digest] of [
      ['Identity subject', input.identitySubjectHash],
      ['Address subject', input.addressSubjectHash],
      ['Network subject', input.networkSubjectHash],
      ['Device subject', input.deviceSubjectHash],
      ['Idempotency key', input.idempotencyKeyHash],
      ['Request', input.requestHash],
    ] as const) {
      assertDigest(label, digest);
    }
    await this.#assertEnabled(input.user.id);

    return this.dependencies.locks.withLock(
      `bootstrap-grant:${this.dependencies.policy.environment}:${input.recipient.toLowerCase()}`,
      60_000,
      async (recipientLockSignal) => {
        await this.#assertEnabled(input.user.id);
        if (recipientLockSignal.aborted) {
          throw new AppError('INTERNAL_ERROR', 'The sponsor recipient lock was lost.', {
            retryable: true,
          });
        }
        const now = this.dependencies.clock.now();
        const idempotency = await this.dependencies.idempotency.execute({
          scope: `bootstrap-grant:${this.dependencies.policy.environment}:${input.user.id}`,
          keyHash: input.idempotencyKeyHash,
          requestHash: input.requestHash,
          expiresAt: new Date(now.getTime() + 48 * 60 * 60 * 1_000),
          operation: async () => {
            await this.#consumeLimits(input);
            const delegation = await this.dependencies.chain.getDelegationCode(input.recipient);
            if (delegation.accountType !== 'eoa' || delegation.implementation !== undefined) {
              throw new AppError('SPONSOR_INELIGIBLE', 'This account is already prepared.');
            }
            const confirmedBalanceWei = BigInt(
              await this.dependencies.chain.getNativeBalance(input.recipient),
            );
            const pendingWei = await this.dependencies.grants.pendingAmountWei({
              environment: this.dependencies.policy.environment,
              recipient: input.recipient,
            });
            const deficit = this.dependencies.policy.targetWei - confirmedBalanceWei - pendingWei;
            const amountWei =
              deficit > this.dependencies.policy.perGrantCapWei
                ? this.dependencies.policy.perGrantCapWei
                : deficit;
            if (amountWei < this.dependencies.policy.minimumGrantWei) {
              throw new AppError(
                'SPONSOR_INELIGIBLE',
                'This account does not need an activation grant.',
              );
            }
            const signerHealth = await this.dependencies.transfer.getSignerHealth({
              chainId: ARBITRUM_ONE_CHAIN_ID,
            });
            this.#assertSignerCanFund(signerHealth.balanceWei, amountWei);
            const budgets: readonly SponsorBudgetReservation[] = [
              {
                scope: 'global',
                subjectHash: this.dependencies.globalBudgetSubjectHash,
                limitWei: this.dependencies.policy.globalDailyCapWei,
                countLimit: 100_000,
              },
              {
                scope: 'address',
                subjectHash: input.addressSubjectHash,
                limitWei: this.dependencies.policy.perAddressDailyCapWei,
                countLimit: 1,
              },
              {
                scope: 'identity',
                subjectHash: input.identitySubjectHash,
                limitWei: this.dependencies.policy.perIdentityDailyCapWei,
                countLimit: 1,
              },
              {
                scope: 'network',
                subjectHash: input.networkSubjectHash,
                limitWei: this.dependencies.policy.perNetworkDailyCapWei,
                countLimit: 25,
              },
              {
                scope: 'device',
                subjectHash: input.deviceSubjectHash,
                limitWei: this.dependencies.policy.perDeviceDailyCapWei,
                countLimit: 3,
              },
            ];
            return this.dependencies.grants.reserveAndCreate({
              environment: this.dependencies.policy.environment,
              userId: input.user.id,
              identitySubjectHash: input.identitySubjectHash,
              recipient: input.recipient,
              idempotencyKeyHash: input.idempotencyKeyHash,
              requestId: input.requestId,
              balanceBeforeWei: confirmedBalanceWei,
              targetWei: this.dependencies.policy.targetWei,
              amountWei,
              budgetDate: utcBudgetDate(now),
              budgets,
              now,
            });
          },
        });

        const current = await this.dependencies.grants.findById(idempotency.value.id);
        if (current === undefined)
          throw new AppError('INTERNAL_ERROR', 'The sponsor grant could not be loaded.');
        if (!['created', 'submission_started'].includes(current.status)) return current;

        const signer = await this.dependencies.transfer.getSignerHealth({
          chainId: ARBITRUM_ONE_CHAIN_ID,
        });
        return this.dependencies.locks.withLock(
          `bootstrap-signer:${this.dependencies.policy.environment}:${ARBITRUM_ONE_CHAIN_ID}:${signer.signerAddress.toLowerCase()}`,
          60_000,
          async (signerLockSignal) => {
            let durable = current;
            try {
              await this.#assertEnabled(input.user.id);
              const lockedSigner = await this.dependencies.transfer.getSignerHealth({
                chainId: ARBITRUM_ONE_CHAIN_ID,
              });
              if (!sameEvmAddress(lockedSigner.signerAddress, signer.signerAddress)) {
                throw new AppError(
                  'CONFIGURATION_INVALID',
                  'The configured sponsor signer changed during grant preparation.',
                );
              }
              this.#assertSignerCanFund(lockedSigner.balanceWei, BigInt(current.amountWei));
              if (recipientLockSignal.aborted || signerLockSignal.aborted) {
                throw new AppError('INTERNAL_ERROR', 'The sponsor signer lock was lost.', {
                  retryable: true,
                });
              }
              durable =
                current.status === 'created'
                  ? await this.dependencies.grants.markSubmissionStarted({
                      id: current.id,
                      sponsorSignerAddress: lockedSigner.signerAddress,
                      signerNonce: lockedSigner.pendingNonce,
                      now: this.dependencies.clock.now(),
                    })
                  : current;
              if (
                durable.sponsorSignerAddress === undefined ||
                durable.signerNonce === undefined ||
                !sameEvmAddress(durable.sponsorSignerAddress, lockedSigner.signerAddress)
              ) {
                throw new AppError(
                  'CONFIGURATION_INVALID',
                  'The durable sponsor submission boundary is invalid.',
                );
              }
              const reservedNonce = BigInt(BaseUnitAmountSchema.parse(durable.signerNonce));
              const pendingNonce = BigInt(BaseUnitAmountSchema.parse(lockedSigner.pendingNonce));
              if (pendingNonce > reservedNonce) {
                if (durable.transactionHash !== undefined) {
                  const unknown = await this.dependencies.grants.markTransferResult({
                    id: durable.id,
                    result: {
                      status: 'submitted_unknown',
                      transactionHash: durable.transactionHash,
                      signerNonce: durable.signerNonce,
                    },
                    now: this.dependencies.clock.now(),
                  });
                  this.dependencies.telemetry.increment('sponsor_grants_total', {
                    status: unknown.status,
                  });
                  return unknown;
                }
                const replaced = await this.dependencies.grants.markReplaced({
                  id: durable.id,
                  reason: 'signer_nonce_consumed_before_transaction_prepared',
                  now: this.dependencies.clock.now(),
                });
                this.dependencies.telemetry.increment('sponsor_grants_total', {
                  status: replaced.status,
                });
                return replaced;
              }
              if (pendingNonce < reservedNonce) {
                this.dependencies.telemetry.event('sponsor_grant_nonce_queued', {
                  grantId: durable.id,
                });
                return durable;
              }
              if (durable.transactionHash !== undefined) {
                // A crash may occur after persisting the exact hash but before
                // raw broadcast. Re-prepare the same recipient/amount/nonce and
                // submit one bounded replacement. Nonce uniqueness guarantees
                // that at most one of the exact transfer candidates can settle.
                this.dependencies.telemetry.event('sponsor_grant_prepared_recovery', {
                  grantId: durable.id,
                });
              }
              const prepared = await this.dependencies.transfer.prepareActivationGas({
                chainId: ARBITRUM_ONE_CHAIN_ID,
                recipient: input.recipient,
                amountWei: durable.amountWei,
                idempotencyReference: durable.id,
                signerNonce: durable.signerNonce,
              });
              if (prepared.signerNonce !== durable.signerNonce) {
                throw new AppError(
                  'OPERATION_PLAN_INVALID',
                  'The prepared sponsor transaction changed its reserved nonce.',
                );
              }
              durable = await this.dependencies.grants.markTransactionPrepared({
                id: durable.id,
                transactionHash: prepared.transactionHash,
                signerNonce: durable.signerNonce,
                now: this.dependencies.clock.now(),
              });
              const result = await prepared.submit();
              const updated = await this.dependencies.grants.markTransferResult({
                id: durable.id,
                result,
                now: this.dependencies.clock.now(),
              });
              this.dependencies.telemetry.increment('sponsor_grants_total', {
                status: updated.status,
              });
              return updated;
            } catch (error) {
              const appError =
                error instanceof AppError
                  ? error
                  : new AppError(
                      'SPONSOR_SUBMISSION_UNKNOWN',
                      'The activation grant status is unknown.',
                      {
                        retryable: true,
                        submissionPossible: true,
                        cause: error,
                      },
                    );
              if (durable.status === 'created' && !appError.retryable) {
                await this.dependencies.grants.markFailed({
                  id: current.id,
                  errorCode: appError.code,
                  now: this.dependencies.clock.now(),
                });
              } else if (
                appError.submissionPossible &&
                durable.signerNonce !== undefined &&
                durable.transactionHash !== undefined
              ) {
                await this.dependencies.grants.markTransferResult({
                  id: durable.id,
                  result: {
                    status: 'submitted_unknown',
                    transactionHash: durable.transactionHash,
                    signerNonce: durable.signerNonce,
                  },
                  now: this.dependencies.clock.now(),
                });
              }
              this.dependencies.telemetry.error(appError, {
                errorCode: appError.code,
                grantId: current.id,
              });
              throw appError;
            }
          },
        );
      },
    );
  }

  async #assertEnabled(userId: string): Promise<void> {
    if (!(await this.dependencies.flags.enabled('bootstrap-sponsor', { userId }))) {
      throw new AppError('SPONSOR_DISABLED', 'Account preparation is temporarily unavailable.');
    }
  }

  #assertSignerCanFund(balanceWei: BaseUnitAmount, amountWei: bigint): void {
    const signerBalanceWei = BigInt(balanceWei);
    const lowBalance = signerBalanceWei < this.dependencies.policy.lowBalanceAlertWei;
    this.dependencies.telemetry.event('sponsor_signer_health', {
      lowBalance,
      canFundGrant: signerBalanceWei >= amountWei,
    });
    if (lowBalance || signerBalanceWei < amountWei) {
      this.dependencies.telemetry.increment('sponsor_low_balance_alerts_total');
      throw new AppError(
        'SPONSOR_BUDGET_EXHAUSTED',
        'Account preparation is temporarily unavailable.',
        { retryable: true },
      );
    }
  }

  async #consumeLimits(input: {
    user: CurrentUser;
    recipient: EvmAddress;
    identitySubjectHash: string;
    networkSubjectHash: string;
    deviceSubjectHash: string;
  }): Promise<void> {
    const dimensions = [
      {
        scope: 'sponsor-user',
        subjectHash: input.identitySubjectHash,
        limit: 3,
        windowSeconds: 86_400,
      },
      {
        scope: 'sponsor-network',
        subjectHash: input.networkSubjectHash,
        limit: 25,
        windowSeconds: 86_400,
      },
      {
        scope: 'sponsor-device',
        subjectHash: input.deviceSubjectHash,
        limit: 5,
        windowSeconds: 86_400,
      },
    ] as const;
    for (const dimension of dimensions) {
      const decision = await this.dependencies.rateLimits.consume(dimension);
      if (!decision.allowed) {
        this.dependencies.telemetry.increment('sponsor_denials_total', { scope: dimension.scope });
        throw new AppError('RATE_LIMITED', 'Account preparation is temporarily limited.', {
          retryable: true,
          ...(decision.retryAfterSeconds === undefined
            ? {}
            : { safeDetails: { retryAfterSeconds: decision.retryAfterSeconds.toString() } }),
        });
      }
    }
  }
}
