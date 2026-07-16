import type { CsrfSessionServicePort } from '@opentab/application';
import {
  AppError,
  type CurrentUser,
  SessionIdSchema,
  sameEvmAddress,
  UserIdSchema,
  type VerifiedMagicIdentity,
} from '@opentab/shared';
import { and, eq } from 'drizzle-orm';
import { hashOpaqueSecret, opaqueId, randomSecret, safeHashEquals } from './crypto.js';
import { DrizzleUserRepository, SessionLookupRepository } from './repositories.js';
import { serverSessions, userIdentities, users } from './schema/index.js';
import type { PostgresUnitOfWork } from './unit-of-work.js';

export interface PostgresSessionServiceOptions {
  readonly sessionHashPepper: string;
  readonly sessionHashVersion?: number;
  readonly previousSessionHashPeppers?: readonly {
    readonly version: number;
    readonly pepper: string;
  }[];
  readonly csrfHashPepper: string;
  readonly previousCsrfHashPeppers?: readonly string[];
  readonly maxAgeSeconds: number;
  readonly now?: () => Date;
}

export class PostgresSessionService implements CsrfSessionServicePort {
  readonly #users: DrizzleUserRepository;
  readonly #sessions: SessionLookupRepository;
  readonly #now: () => Date;
  readonly #sessionHashVersion: number;

  constructor(
    private readonly uow: PostgresUnitOfWork,
    private readonly options: PostgresSessionServiceOptions,
  ) {
    if (!Number.isSafeInteger(options.maxAgeSeconds) || options.maxAgeSeconds < 300) {
      throw new RangeError('Session maximum age must be at least five minutes');
    }
    this.#sessionHashVersion = options.sessionHashVersion ?? 1;
    const sessionPeppers = [
      { version: this.#sessionHashVersion, pepper: options.sessionHashPepper },
      ...(options.previousSessionHashPeppers ?? []),
    ];
    const csrfPeppers = [options.csrfHashPepper, ...(options.previousCsrfHashPeppers ?? [])];
    if (
      !sessionPeppers.every(
        ({ version, pepper }) =>
          Number.isSafeInteger(version) &&
          version > 0 &&
          version <= 2_147_483_647 &&
          pepper.length >= 32,
      ) ||
      !csrfPeppers.every((pepper) => pepper.length >= 32) ||
      new Set(sessionPeppers.map(({ version }) => version)).size !== sessionPeppers.length ||
      new Set([...sessionPeppers.map(({ pepper }) => pepper), ...csrfPeppers]).size !==
        sessionPeppers.length + csrfPeppers.length
    ) {
      throw new Error('Session and CSRF hash peppers must be independent 32-byte secrets');
    }
    this.#users = new DrizzleUserRepository(uow);
    this.#sessions = new SessionLookupRepository(uow);
    this.#now = options.now ?? (() => new Date());
  }

  #hashToken(token: string, pepper = this.options.sessionHashPepper): string {
    return hashOpaqueSecret({
      domain: 'session-token',
      pepper,
      value: token,
    });
  }

  #hashCsrf(token: string, pepper = this.options.csrfHashPepper): string {
    return hashOpaqueSecret({
      domain: 'csrf-token',
      pepper,
      value: token,
    });
  }

  async #findSession(plaintextToken: string) {
    const activeCandidate = {
      version: this.#sessionHashVersion,
      hash: this.#hashToken(plaintextToken),
      active: true,
    };
    const candidates = [
      activeCandidate,
      ...(this.options.previousSessionHashPeppers ?? []).map(({ version, pepper }) => ({
        version,
        hash: this.#hashToken(plaintextToken, pepper),
        active: false,
      })),
    ];
    for (const candidate of candidates) {
      const record = await this.#sessions.findActiveByTokenHash(candidate.hash, this.#now());
      if (record === undefined || record.tokenHashVersion !== candidate.version) continue;
      if (candidate.active) return record;
      const activeHash = this.#hashToken(plaintextToken);
      const rotated = await this.#sessions.rotateTokenHash({
        id: record.id,
        expectedHash: candidate.hash,
        nextHash: activeHash,
        nextVersion: this.#sessionHashVersion,
      });
      if (rotated) {
        return {
          ...record,
          tokenHash: activeHash,
          tokenHashVersion: this.#sessionHashVersion,
        };
      }
      const concurrentlyRotated = await this.#sessions.findActiveByTokenHash(
        activeHash,
        this.#now(),
      );
      if (concurrentlyRotated?.tokenHashVersion === activeCandidate.version) {
        return concurrentlyRotated;
      }
    }
    // A concurrent verifier can rotate the legacy hash after this request's
    // first active-hash lookup but before its legacy lookup. Re-read the active
    // hash once after exhausting legacy candidates so both verifiers converge
    // on the same session without accepting an unknown token.
    const active = await this.#sessions.findActiveByTokenHash(activeCandidate.hash, this.#now());
    return active?.tokenHashVersion === activeCandidate.version ? active : undefined;
  }

  async create(identity: VerifiedMagicIdentity): Promise<{
    user: CurrentUser;
    plaintextToken: string;
    csrfToken: string;
    expiresAt: string;
  }> {
    const now = this.#now();
    if (new Date(identity.expiresAt).getTime() <= now.getTime()) {
      throw new AppError('AUTH_EXPIRED', 'The identity proof has expired.');
    }

    const plaintextToken = randomSecret(32);
    const csrfToken = randomSecret(32);
    const expiresAt = new Date(now.getTime() + this.options.maxAgeSeconds * 1_000);

    const userId = await this.uow.transaction(async () => {
      const [existingIdentity] = await this.uow
        .current()
        .select({ id: userIdentities.id, userId: userIdentities.userId })
        .from(userIdentities)
        .where(
          and(
            eq(userIdentities.provider, 'magic'),
            eq(userIdentities.providerSubjectHash, identity.issuerHash),
          ),
        )
        .limit(1);

      let resolvedUserId: string;
      if (existingIdentity !== undefined) {
        const [existingUser] = await this.uow
          .current()
          .select({
            id: users.id,
            walletAddress: users.walletAddressChecksum,
            status: users.status,
          })
          .from(users)
          .where(eq(users.id, existingIdentity.userId))
          .limit(1);
        if (existingUser === undefined || existingUser.status !== 'active') {
          throw new AppError('AUTH_FORBIDDEN', 'This account is not active.');
        }
        if (
          !sameEvmAddress(
            identity.walletAddress,
            existingUser.walletAddress as typeof identity.walletAddress,
          )
        ) {
          throw new AppError(
            'WALLET_ADDRESS_MISMATCH',
            'The wallet address does not match this identity.',
          );
        }
        resolvedUserId = existingUser.id;
        await this.uow
          .current()
          .update(userIdentities)
          .set({
            authMethod: identity.authMethod,
            evidenceDigest: identity.evidenceDigest,
            lastVerifiedAt: now,
            updatedAt: now,
          })
          .where(eq(userIdentities.id, existingIdentity.id));
        await this.uow
          .current()
          .update(users)
          .set({ lastLoginAt: now, updatedAt: now })
          .where(eq(users.id, resolvedUserId));
      } else {
        const walletLower = identity.walletAddress.toLowerCase();
        const [walletUser] = await this.uow
          .current()
          .select({ id: users.id, status: users.status })
          .from(users)
          .where(eq(users.walletAddressLower, walletLower))
          .limit(1);
        if (walletUser !== undefined && walletUser.status !== 'active') {
          throw new AppError('AUTH_FORBIDDEN', 'This account is not active.');
        }
        resolvedUserId = walletUser?.id ?? UserIdSchema.parse(opaqueId('usr'));
        if (walletUser === undefined) {
          await this.uow.current().insert(users).values({
            id: resolvedUserId,
            magicIssuerHash: identity.issuerHash,
            walletAddressChecksum: identity.walletAddress,
            walletAddressLower: walletLower,
            status: 'active',
            lastLoginAt: now,
          });
        } else {
          await this.uow
            .current()
            .update(users)
            .set({ lastLoginAt: now, updatedAt: now })
            .where(eq(users.id, resolvedUserId));
        }
        await this.uow.current().insert(userIdentities).values({
          userId: resolvedUserId,
          provider: 'magic',
          providerSubjectHash: identity.issuerHash,
          authMethod: identity.authMethod,
          evidenceDigest: identity.evidenceDigest,
          lastVerifiedAt: now,
        });
      }

      const sessionId = SessionIdSchema.parse(opaqueId('ses'));
      await this.uow
        .current()
        .insert(serverSessions)
        .values({
          id: sessionId,
          userId: resolvedUserId,
          tokenHash: this.#hashToken(plaintextToken),
          tokenHashVersion: this.#sessionHashVersion,
          csrfTokenHash: this.#hashCsrf(csrfToken),
          expiresAt,
          lastSeenAt: now,
        });
      return resolvedUserId;
    });

    const user = await this.#users.findCurrentUserById(userId);
    if (user === undefined)
      throw new AppError('INTERNAL_ERROR', 'The application session could not be created.');
    return { user, plaintextToken, csrfToken, expiresAt: expiresAt.toISOString() };
  }

  async verify(plaintextToken: string): Promise<CurrentUser> {
    if (plaintextToken.length < 32 || plaintextToken.length > 256) {
      throw new AppError('AUTH_SESSION_INVALID', 'The application session is invalid.');
    }
    const record = await this.#findSession(plaintextToken);
    if (record === undefined) {
      throw new AppError('AUTH_SESSION_INVALID', 'The application session is invalid.');
    }
    const user = await this.#users.findCurrentUserById(record.userId);
    if (user === undefined || user.status !== 'active') {
      throw new AppError('AUTH_SESSION_REVOKED', 'The application session is no longer active.');
    }
    return user;
  }

  async refresh(plaintextToken: string): Promise<{
    user: CurrentUser;
    plaintextToken: string;
    csrfToken: string;
    expiresAt: string;
  }> {
    if (plaintextToken.length < 32 || plaintextToken.length > 256) {
      throw new AppError('AUTH_SESSION_INVALID', 'The application session is invalid.');
    }
    const nextPlaintextToken = randomSecret(32);
    const nextCsrfToken = randomSecret(32);
    return this.uow.transaction(async () => {
      const record = await this.#findSession(plaintextToken);
      if (record === undefined) {
        throw new AppError('AUTH_SESSION_INVALID', 'The application session is invalid.');
      }
      const user = await this.#users.findCurrentUserById(record.userId);
      if (user === undefined || user.status !== 'active') {
        throw new AppError('AUTH_SESSION_REVOKED', 'The application session is no longer active.');
      }
      const rotated = await this.#sessions.rotateCredentials({
        id: record.id,
        expectedTokenHash: record.tokenHash,
        nextTokenHash: this.#hashToken(nextPlaintextToken),
        nextTokenHashVersion: this.#sessionHashVersion,
        nextCsrfTokenHash: this.#hashCsrf(nextCsrfToken),
        now: this.#now(),
      });
      if (rotated === undefined) {
        throw new AppError('AUTH_SESSION_INVALID', 'The application session was already rotated.');
      }
      return {
        user,
        plaintextToken: nextPlaintextToken,
        csrfToken: nextCsrfToken,
        expiresAt: rotated.expiresAt.toISOString(),
      };
    });
  }

  async verifyCsrf(plaintextToken: string, csrfToken: string): Promise<CurrentUser> {
    if (csrfToken.length < 32 || csrfToken.length > 256) {
      throw new AppError('CSRF_INVALID', 'The CSRF token is invalid.');
    }
    const record = await this.#findSession(plaintextToken);
    if (record === undefined) {
      throw new AppError('CSRF_INVALID', 'The CSRF token is invalid.');
    }
    const csrfCandidates = [
      { hash: this.#hashCsrf(csrfToken), active: true },
      ...(this.options.previousCsrfHashPeppers ?? []).map((pepper) => ({
        hash: this.#hashCsrf(csrfToken, pepper),
        active: false,
      })),
    ];
    const matching = csrfCandidates.find(({ hash }) => safeHashEquals(record.csrfTokenHash, hash));
    if (matching === undefined) throw new AppError('CSRF_INVALID', 'The CSRF token is invalid.');
    if (!matching.active) {
      await this.#sessions.rotateCsrfHash({
        id: record.id,
        expectedHash: matching.hash,
        nextHash: this.#hashCsrf(csrfToken),
      });
    }
    return this.verify(plaintextToken);
  }

  async revoke(plaintextToken: string): Promise<void> {
    if (plaintextToken.length < 32 || plaintextToken.length > 256) return;
    const hashes = [
      this.#hashToken(plaintextToken),
      ...(this.options.previousSessionHashPeppers ?? []).map(({ pepper }) =>
        this.#hashToken(plaintextToken, pepper),
      ),
    ];
    for (const hash of hashes) {
      if (await this.#sessions.revokeByTokenHash(hash, this.#now())) return;
    }
  }
}
