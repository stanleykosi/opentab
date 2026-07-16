import { createHash, randomUUID } from 'node:crypto';
import type {
  AuthContinuationServicePort,
  DistributedLockPort,
  JobQueuePort,
  RateLimitPort,
} from '@opentab/application';
import { AppError } from '@opentab/shared';
import { type ConnectionOptions, type JobsOptions, Queue } from 'bullmq';
import Redis, { type RedisOptions } from 'ioredis';
import { hashOpaqueSecret, randomSecret } from './crypto.js';

const RELEASE_LOCK_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
`;

const EXTEND_LOCK_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('pexpire', KEYS[1], ARGV[2])
end
return 0
`;

const RATE_LIMIT_SCRIPT = `
local current = redis.call('incr', KEYS[1])
if current == 1 then redis.call('expire', KEYS[1], ARGV[1]) end
local ttl = redis.call('ttl', KEYS[1])
return {current, ttl}
`;

const GET_AND_DELETE_SCRIPT = `
local value = redis.call('get', KEYS[1])
if value then redis.call('del', KEYS[1]) end
return value
`;

function safeReturnPath(value: string): string {
  if (value.length < 1 || value.length > 512 || !value.startsWith('/') || value.startsWith('//')) {
    throw new AppError('VALIDATION_FAILED', 'The return path is invalid.');
  }
  let parsed: URL;
  try {
    parsed = new URL(value, 'https://opentab.invalid');
  } catch (error) {
    throw new AppError('VALIDATION_FAILED', 'The return path is invalid.', { cause: error });
  }
  const allowed =
    parsed.pathname === '/' ||
    /^\/split\/[A-Za-z0-9_-]{16,256}$/.test(parsed.pathname) ||
    ['/m/', '/c/', '/checkout/', '/receipt/'].some((prefix) =>
      parsed.pathname.startsWith(prefix),
    ) ||
    parsed.pathname === '/merchant' ||
    parsed.pathname.startsWith('/merchant/') ||
    parsed.pathname === '/account' ||
    parsed.pathname.startsWith('/account/');
  if (parsed.origin !== 'https://opentab.invalid' || parsed.hash.length > 0 || !allowed) {
    throw new AppError('VALIDATION_FAILED', 'The return path is not allowed.');
  }
  return `${parsed.pathname}${parsed.search}`;
}

export function createRedis(url: string, options: RedisOptions = {}): Redis {
  if (!/^rediss?:\/\//.test(url)) throw new Error('Redis URL must use redis:// or rediss://');
  return new Redis(url, {
    family: 0,
    lazyConnect: true,
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    connectTimeout: 10_000,
    commandTimeout: 5_000,
    ...options,
  });
}

export class RedisDistributedLock implements DistributedLockPort {
  constructor(
    private readonly redis: Redis,
    private readonly namespace = 'opentab:lock',
  ) {}

  async withLock<T>(
    key: string,
    ttlMs: number,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 300_000) {
      throw new RangeError('Distributed lock TTL must be between 1 and 300 seconds');
    }
    const redisKey = `${this.namespace}:${key}`;
    const token = randomUUID();
    const acquired = await this.redis.set(redisKey, token, 'PX', ttlMs, 'NX');
    if (acquired !== 'OK') {
      throw new AppError('RATE_LIMITED', 'This operation is already in progress.', {
        retryable: true,
      });
    }

    const controller = new AbortController();
    let lockError: AppError | undefined;
    let renewal = Promise.resolve();
    const loseLock = (cause?: unknown) => {
      lockError ??= new AppError('INTERNAL_ERROR', 'The distributed lock was lost.', {
        retryable: true,
        submissionPossible: true,
        ...(cause === undefined ? {} : { cause }),
      });
      controller.abort(lockError);
    };
    const timer = setInterval(
      () => {
        renewal = renewal.then(async () => {
          if (lockError !== undefined) return;
          try {
            const extended = await this.redis.eval(
              EXTEND_LOCK_SCRIPT,
              1,
              redisKey,
              token,
              ttlMs.toString(),
            );
            if (Number(extended) !== 1) loseLock();
          } catch (error) {
            loseLock(error);
          }
        });
      },
      Math.max(250, Math.floor(ttlMs / 3)),
    );
    timer.unref();
    let result: T | undefined;
    let operationError: unknown;
    try {
      result = await operation(controller.signal);
    } catch (error) {
      operationError = error;
    } finally {
      clearInterval(timer);
      await renewal;
      if (operationError === undefined && lockError === undefined) {
        try {
          const stillOwned = await this.redis.eval(
            EXTEND_LOCK_SCRIPT,
            1,
            redisKey,
            token,
            ttlMs.toString(),
          );
          if (Number(stillOwned) !== 1) loseLock();
        } catch (error) {
          loseLock(error);
        }
      }
      await this.redis.eval(RELEASE_LOCK_SCRIPT, 1, redisKey, token).catch(() => undefined);
    }
    if (lockError !== undefined) throw lockError;
    if (operationError !== undefined) throw operationError;
    return result as T;
  }
}

export class RedisRateLimit implements RateLimitPort {
  constructor(
    private readonly redis: Redis,
    private readonly namespace = 'opentab:rate',
  ) {}

  async consume(input: {
    scope: string;
    subjectHash: string;
    limit: number;
    windowSeconds: number;
  }): Promise<{ allowed: boolean; retryAfterSeconds?: number }> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100_000) {
      throw new RangeError('Rate limit must be a positive bounded integer');
    }
    if (
      !Number.isSafeInteger(input.windowSeconds) ||
      input.windowSeconds < 1 ||
      input.windowSeconds > 86_400
    ) {
      throw new RangeError('Rate limit window must be between one second and one day');
    }
    const key = `${this.namespace}:${input.scope}:${input.subjectHash}`;
    const raw = await this.redis.eval(RATE_LIMIT_SCRIPT, 1, key, input.windowSeconds.toString());
    if (!Array.isArray(raw) || raw.length !== 2)
      throw new Error('Unexpected Redis rate limit response');
    const count = Number(raw[0]);
    const ttl = Math.max(1, Number(raw[1]));
    if (!Number.isSafeInteger(count) || !Number.isSafeInteger(ttl)) {
      throw new Error('Invalid Redis rate limit response');
    }
    return count <= input.limit ? { allowed: true } : { allowed: false, retryAfterSeconds: ttl };
  }
}

export class RedisAuthContinuationService implements AuthContinuationServicePort {
  readonly #ttlSeconds: number;
  readonly #now: () => Date;

  constructor(
    private readonly redis: Redis,
    private readonly pepper: string,
    private readonly namespace = 'opentab:auth-continuation',
    options: { ttlSeconds?: number; now?: () => Date } = {},
  ) {
    this.#ttlSeconds = options.ttlSeconds ?? 300;
    this.#now = options.now ?? (() => new Date());
    if (pepper.length < 32) throw new Error('Auth continuation pepper must be at least 32 bytes');
    if (
      !Number.isSafeInteger(this.#ttlSeconds) ||
      this.#ttlSeconds < 60 ||
      this.#ttlSeconds > 900
    ) {
      throw new RangeError('Auth continuation lifetime must be between one and fifteen minutes');
    }
  }

  async issue(input: { returnPath: string }) {
    const returnPath = safeReturnPath(input.returnPath);
    const continuationId = randomSecret(32);
    const verifierToken = randomSecret(32);
    const verifierHash = hashOpaqueSecret({
      domain: 'auth-continuation',
      pepper: this.pepper,
      value: verifierToken,
    });
    const expiresAt = new Date(this.#now().getTime() + this.#ttlSeconds * 1_000);
    const key = `${this.namespace}:${continuationId}:${verifierHash}`;
    const stored = await this.redis.set(
      key,
      JSON.stringify({ returnPath, expiresAt: expiresAt.toISOString() }),
      'EX',
      this.#ttlSeconds,
      'NX',
    );
    if (stored !== 'OK') {
      throw new AppError('INTERNAL_ERROR', 'The login continuation could not be issued.', {
        retryable: true,
      });
    }
    return { continuationId, verifierToken, expiresAt: expiresAt.toISOString() };
  }

  async consume(input: { continuationId: string; verifierToken: string }) {
    if (
      !/^[A-Za-z0-9_-]{40,200}$/.test(input.continuationId) ||
      !/^[A-Za-z0-9_-]{40,200}$/.test(input.verifierToken)
    ) {
      throw new AppError('AUTH_STATE_MISMATCH', 'The login continuation is invalid.');
    }
    const verifierHash = hashOpaqueSecret({
      domain: 'auth-continuation',
      pepper: this.pepper,
      value: input.verifierToken,
    });
    const key = `${this.namespace}:${input.continuationId}:${verifierHash}`;
    const raw = await this.redis.eval(GET_AND_DELETE_SCRIPT, 1, key);
    if (typeof raw !== 'string') {
      throw new AppError('AUTH_STATE_MISMATCH', 'The login continuation is invalid or expired.');
    }
    try {
      const value = JSON.parse(raw) as Readonly<Record<string, unknown>>;
      if (
        typeof value['returnPath'] !== 'string' ||
        typeof value['expiresAt'] !== 'string' ||
        new Date(value['expiresAt']).getTime() <= this.#now().getTime()
      ) {
        throw new Error('expired continuation');
      }
      return { returnPath: safeReturnPath(value['returnPath']) };
    } catch (error) {
      throw new AppError('AUTH_STATE_MISMATCH', 'The login continuation is invalid or expired.', {
        cause: error,
      });
    }
  }
}

export class BullMqJobQueue implements JobQueuePort {
  readonly #queue: Queue<Record<string, string>, void, string>;
  #closed = false;

  constructor(input: { redis: Redis; queueName?: string; prefix?: string }) {
    this.#queue = new Queue(input.queueName ?? 'opentab-jobs', {
      // BullMQ embeds ioredis 5.10 while this package pins 5.11. Runtime APIs
      // are compatible; isolate the duplicate nominal declaration here.
      connection: input.redis as unknown as ConnectionOptions,
      prefix: input.prefix ?? 'opentab',
      defaultJobOptions: {
        attempts: 10,
        backoff: { type: 'exponential', delay: 1_000 },
        removeOnComplete: { age: 86_400, count: 10_000 },
        removeOnFail: false,
      },
    });
  }

  async enqueue(input: {
    kind: string;
    businessKey: string;
    payload: Readonly<Record<string, string>>;
    runAt?: Date;
  }): Promise<void> {
    if (this.#closed) throw new Error('The job queue is closed');
    if (!/^[a-z][a-z0-9._-]{0,79}$/i.test(input.kind)) {
      throw new RangeError('Job kind must be a bounded identifier');
    }
    if (input.businessKey.length < 1 || input.businessKey.length > 200) {
      throw new RangeError('Job business key must be between 1 and 200 characters');
    }
    const delay = Math.max(0, (input.runAt?.getTime() ?? Date.now()) - Date.now());
    const digest = createHash('sha256')
      .update(`${input.kind}\0${input.businessKey}`, 'utf8')
      .digest('hex');
    const options: JobsOptions = { jobId: `${input.kind}-${digest}`, delay };
    await this.#queue.add(input.kind, { ...input.payload }, options);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#queue.close();
  }
}
