import type { ErrorCode } from '@opentab/shared';

export interface ClockPort {
  now(): Date;
}

export interface RandomPort {
  opaqueId(prefix: string): string;
  bytes32(): `0x${string}`;
  secret(bytes: number): string;
}

export interface DistributedLockPort {
  withLock<T>(
    key: string,
    ttlMs: number,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T>;
}

export interface RateLimitPort {
  consume(input: {
    scope: string;
    subjectHash: string;
    limit: number;
    windowSeconds: number;
  }): Promise<{ allowed: boolean; retryAfterSeconds?: number }>;
}

export interface JobQueuePort {
  enqueue(input: {
    kind: string;
    businessKey: string;
    payload: Readonly<Record<string, string>>;
    runAt?: Date;
  }): Promise<void>;
}

export interface TelemetryPort {
  event(name: string, fields: Readonly<Record<string, string | boolean>>): void;
  error(error: Error, fields: Readonly<Record<string, string | ErrorCode>>): void;
  increment(metric: string, labels?: Readonly<Record<string, string>>): void;
}

export interface FeatureFlagPort {
  enabled(flag: string, context?: Readonly<Record<string, string>>): Promise<boolean>;
}

/** Verifies a short-lived anti-automation token without exposing vendor response shapes. */
export interface HumanChallengeVerifierPort {
  verify(token: string): Promise<void>;
}
