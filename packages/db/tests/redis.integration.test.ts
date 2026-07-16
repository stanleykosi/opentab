import { randomUUID } from 'node:crypto';
import { type ConnectionOptions, Queue } from 'bullmq';
import type Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BullMqJobQueue,
  createRedis,
  RedisAuthContinuationService,
  RedisDistributedLock,
  RedisRateLimit,
} from '../src/redis.js';

const redisUrl = process.env['REDIS_URL_TEST'];
const namespace = `opentab:test:${process.pid}:${randomUUID()}`;
let redis: Redis;

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener('abort', () => resolve(), { once: true }),
  );
}

describe.skipIf(redisUrl === undefined)('native Redis coordination adapters', () => {
  beforeAll(async () => {
    if (redisUrl === undefined) return;
    redis = createRedis(redisUrl, { keyPrefix: '' });
    await redis.connect();
    expect(await redis.ping()).toBe('PONG');
  });

  afterAll(async () => {
    if (redis === undefined) return;
    const keys = await redis.keys(`${namespace}:*`);
    if (keys.length > 0) await redis.del(...keys);
    await redis.quit();
  });

  it('provides mutual exclusion and owner-token-safe release', async () => {
    const lockNamespace = `${namespace}:lock-owner`;
    const lock = new RedisDistributedLock(redis, lockNamespace);
    let releaseFirst: () => void = () => {};
    const firstRunning = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = lock.withLock('payment', 1_000, async () => {
      await firstRunning;
      return 'first';
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    await expect(lock.withLock('payment', 1_000, async () => 'second')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
    releaseFirst();
    await expect(first).resolves.toBe('first');

    const redisKey = `${lockNamespace}:foreign-owner`;
    await expect(
      lock.withLock('foreign-owner', 1_000, async () => {
        await redis.set(redisKey, 'replacement-owner', 'PX', 5_000);
        return 'must-not-be-accepted';
      }),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR', submissionPossible: true });
    expect(await redis.get(redisKey)).toBe('replacement-owner');
  });

  it('renews a long operation and fails closed when renewal loses ownership', async () => {
    const lockNamespace = `${namespace}:lock-renew`;
    const lock = new RedisDistributedLock(redis, lockNamespace);
    const longOperation = lock.withLock('long', 1_000, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_350));
      return 'renewed';
    });
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await expect(lock.withLock('long', 1_000, async () => 'collision')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
    await expect(longOperation).resolves.toBe('renewed');

    const redisKey = `${lockNamespace}:lost`;
    await expect(
      lock.withLock('lost', 1_000, async (signal) => {
        await redis.set(redisKey, 'stolen-owner', 'PX', 5_000);
        await waitForAbort(signal);
        return 'must-not-commit';
      }),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR', retryable: true, submissionPossible: true });
    expect(await redis.get(redisKey)).toBe('stolen-owner');
  });

  it('enforces a fixed rate-limit window and resets after expiry', async () => {
    const limits = new RedisRateLimit(redis, `${namespace}:rate`);
    const input = { scope: 'sponsor-ip', subjectHash: 'a'.repeat(64), limit: 2, windowSeconds: 1 };
    await expect(limits.consume(input)).resolves.toEqual({ allowed: true });
    await expect(limits.consume(input)).resolves.toEqual({ allowed: true });
    await expect(limits.consume(input)).resolves.toEqual({ allowed: false, retryAfterSeconds: 1 });
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await expect(limits.consume(input)).resolves.toEqual({ allowed: true });
  });

  it('issues allowlisted high-entropy auth state and rejects mismatch and replay', async () => {
    const continuations = new RedisAuthContinuationService(
      redis,
      'auth-continuation-test-pepper'.padEnd(40, 'p'),
      `${namespace}:auth-state`,
    );
    await expect(continuations.issue({ returnPath: 'https://evil.example' })).rejects.toMatchObject(
      {
        code: 'VALIDATION_FAILED',
      },
    );
    await expect(continuations.issue({ returnPath: '/split/short' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(
      continuations.issue({ returnPath: '//evil.example/split/token-token-token' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      continuations.issue({ returnPath: '/split/token-token-token-token#leak' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const split = await continuations.issue({
      returnPath: '/split/token-token-token-token?resume=1',
    });
    await expect(continuations.consume(split)).resolves.toEqual({
      returnPath: '/split/token-token-token-token?resume=1',
    });
    const issued = await continuations.issue({ returnPath: '/checkout/chk_safe?resume=1' });
    expect(issued.continuationId).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(issued.verifierToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    await expect(
      continuations.consume({
        continuationId: issued.continuationId,
        verifierToken: 'mismatched-verifier-token'.padEnd(43, 'x'),
      }),
    ).rejects.toMatchObject({ code: 'AUTH_STATE_MISMATCH' });
    await expect(continuations.consume(issued)).resolves.toEqual({
      returnPath: '/checkout/chk_safe?resume=1',
    });
    await expect(continuations.consume(issued)).rejects.toMatchObject({
      code: 'AUTH_STATE_MISMATCH',
    });
  });

  it('rejects an auth continuation whose accepted lifetime elapsed', async () => {
    let now = new Date('2026-07-14T00:00:00.000Z');
    const continuations = new RedisAuthContinuationService(
      redis,
      'auth-continuation-expiry-pepper'.padEnd(40, 'e'),
      `${namespace}:auth-expiry`,
      { now: () => now },
    );
    const issued = await continuations.issue({ returnPath: '/account' });
    now = new Date(now.getTime() + 301_000);
    await expect(continuations.consume(issued)).rejects.toMatchObject({
      code: 'AUTH_STATE_MISMATCH',
    });
  });

  it('deduplicates BullMQ business jobs with a delimiter-safe ID and closes cleanly', async () => {
    const queueName = `jobs-${randomUUID()}`;
    const prefix = `${namespace}:bull`;
    const jobs = new BullMqJobQueue({ redis, queueName, prefix });
    const inspector = new Queue(queueName, {
      connection: redis as unknown as ConnectionOptions,
      prefix,
    });
    try {
      const command = {
        kind: 'payment-reconcile',
        businessKey: 'provider:operation/with-delimiters',
        payload: { attemptId: 'pay_01J00000000000000000000000' },
      } as const;
      await jobs.enqueue(command);
      await jobs.enqueue(command);
      const queued = await inspector.getJobs(['waiting', 'delayed']);
      expect(queued).toHaveLength(1);
      expect(queued[0]?.id).toMatch(/^payment-reconcile-[a-f0-9]{64}$/);
      expect(queued[0]?.data).toEqual(command.payload);
    } finally {
      await jobs.close();
      await inspector.obliterate({ force: true });
      await inspector.close();
    }
    await expect(
      jobs.enqueue({ kind: 'closed', businessKey: 'one', payload: { safe: 'value' } }),
    ).rejects.toThrow();
  });
});
