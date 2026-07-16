import type { MagicIdentityVerifierPort } from '@opentab/application';
import {
  AppError,
  EvmAddressSchema,
  sameEvmAddress,
  VerifiedMagicIdentitySchema,
} from '@opentab/shared';
import { z } from 'zod';
import { adapterEvidence, digestUnknown } from './evidence.js';
import { mapMagicError } from './vendor-errors.js';

const MAGIC_ADMIN_PACKAGE_VERSION = '2.8.2';
const MAGIC_DID_SCHEMA_VERSION = 1;

const DidClaimSchema = z.object({
  iat: z.number().int().nonnegative(),
  ext: z.number().int().positive(),
  iss: z.string().min(1).max(512),
  sub: z.string().min(1).max(512),
  aud: z.string().min(1).max(256),
  nbf: z.number().int().nonnegative(),
  tid: z.string().min(1).max(512),
  add: z.string().min(1).max(2_048),
});

const MagicAdminMetadataSchema = z.object({
  issuer: z.string().min(1).max(512).nullable(),
  publicAddress: z.string().nullable(),
  email: z.string().email().nullable(),
  oauthProvider: z.string().max(100).nullable(),
  phoneNumber: z.string().max(100).nullable(),
  username: z.string().max(200).nullable(),
  wallets: z
    .array(
      z.object({
        network: z.string().nullable(),
        publicAddress: z.string().nullable(),
        walletType: z.string().nullable(),
      }),
    )
    .nullable(),
});

interface MagicAdminClientLike {
  readonly clientId: string | null;
  readonly token: {
    validate(token: string): void;
    decode(token: string): readonly [string, unknown];
    getPublicAddress(token: string): string;
    getIssuer(token: string): string;
  };
  readonly users: {
    getMetadataByToken(token: string): Promise<unknown>;
  };
}

export interface MagicAdminVerifierConfig {
  readonly expectedAudience: string;
  readonly expectedApplicationId: string;
  readonly environment: string;
  readonly maxClockSkewSeconds?: number;
  readonly now?: () => Date;
}

export class MagicAdminIdentityVerifier implements MagicIdentityVerifierPort {
  constructor(
    private readonly client: MagicAdminClientLike,
    private readonly config: MagicAdminVerifierConfig,
  ) {
    if (client.clientId !== config.expectedAudience) {
      throw new AppError(
        'CONFIGURATION_INVALID',
        'Magic Admin client ID does not match the configured audience.',
      );
    }
    // DIDT 2.8.2 has no independent application-ID claim. The only
    // cryptographically checked app identifier is `aud` (the Magic client
    // ID). Treating a second arbitrary configured string as proof would be a
    // false claim, so both port expectations must name that same verified ID.
    if (config.expectedApplicationId !== config.expectedAudience) {
      throw new AppError(
        'CONFIGURATION_INVALID',
        'Magic application ID must equal the DID audience/client ID.',
      );
    }
  }

  async verifyDidToken(input: {
    didToken: string;
    expectedAudience: string;
    expectedApplicationId: string;
  }) {
    if (
      input.expectedAudience !== this.config.expectedAudience ||
      input.expectedApplicationId !== this.config.expectedApplicationId
    ) {
      throw new AppError('AUTH_DID_INVALID', 'The identity proof is for another application.');
    }
    if (input.didToken.length < 16 || input.didToken.length > 16_384) {
      throw new AppError('AUTH_DID_INVALID', 'The identity proof is invalid.');
    }

    try {
      // Installed Admin SDK 2.8.2 validates synchronously and throws. The
      // client was created via await Magic.init with an explicit client ID.
      this.client.token.validate(input.didToken);
      const decoded = this.client.token.decode(input.didToken);
      const claim = DidClaimSchema.parse(decoded[1]);
      const now = this.config.now?.() ?? new Date();
      const nowSeconds = Math.floor(now.getTime() / 1_000);
      const skew = this.config.maxClockSkewSeconds ?? 300;

      if (claim.aud !== this.config.expectedAudience) {
        throw new AppError('AUTH_DID_INVALID', 'The identity proof audience is invalid.');
      }
      if (
        claim.ext <= nowSeconds ||
        claim.nbf > nowSeconds + skew ||
        claim.iat > nowSeconds + skew
      ) {
        throw new AppError('AUTH_EXPIRED', 'The identity proof is expired or not yet valid.');
      }
      if (claim.ext - claim.iat > 86_400) {
        throw new AppError('AUTH_DID_INVALID', 'The identity proof lifetime is not accepted.');
      }

      const issuer = this.client.token.getIssuer(input.didToken);
      if (issuer !== claim.iss) {
        throw new AppError('AUTH_DID_INVALID', 'The identity issuer is inconsistent.');
      }
      const tokenAddress = EvmAddressSchema.parse(
        this.client.token.getPublicAddress(input.didToken),
      );
      const metadata = MagicAdminMetadataSchema.parse(
        await this.client.users.getMetadataByToken(input.didToken),
      );
      if (metadata.issuer !== issuer || metadata.publicAddress === null) {
        throw new AppError('AUTH_DID_INVALID', 'Magic identity metadata is incomplete.');
      }
      const metadataAddress = EvmAddressSchema.parse(metadata.publicAddress);
      if (!sameEvmAddress(tokenAddress, metadataAddress)) {
        throw new AppError('WALLET_ADDRESS_MISMATCH', 'Magic identity addresses do not match.');
      }
      for (const wallet of metadata.wallets ?? []) {
        if (wallet.publicAddress === null || wallet.network?.toLowerCase() !== 'ethereum') continue;
        const walletAddress = EvmAddressSchema.parse(wallet.publicAddress);
        if (!sameEvmAddress(tokenAddress, walletAddress)) {
          throw new AppError('WALLET_ADDRESS_MISMATCH', 'Magic wallet metadata is inconsistent.');
        }
      }

      const authMethod = metadata.oauthProvider === null ? 'email_otp' : 'google';
      if (metadata.oauthProvider !== null && metadata.oauthProvider.toLowerCase() !== 'google') {
        throw new AppError('AUTH_DID_INVALID', 'The Magic authentication provider is not allowed.');
      }
      const evidence = adapterEvidence({
        adapter: 'magic-admin',
        packageVersion: MAGIC_ADMIN_PACKAGE_VERSION,
        schemaVersion: MAGIC_DID_SCHEMA_VERSION,
        environment: this.config.environment,
        observedAt: now,
        payload: { claim, issuer, tokenAddress, metadataAddress, authMethod },
        provenance: 'live',
      });

      return VerifiedMagicIdentitySchema.parse({
        issuerHash: digestUnknown(issuer),
        walletAddress: tokenAddress,
        issuedAt: new Date(claim.iat * 1_000).toISOString(),
        expiresAt: new Date(claim.ext * 1_000).toISOString(),
        audience: claim.aud,
        applicationId: this.config.expectedApplicationId,
        authMethod,
        evidenceDigest: evidence.evidenceDigest,
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      const mapped = mapMagicError(error, 'AUTH_DID_INVALID');
      throw new AppError('AUTH_DID_INVALID', 'The identity proof could not be verified.', {
        ...(mapped.safeDetails === undefined ? {} : { safeDetails: mapped.safeDetails }),
        cause: error,
      });
    }
  }
}

export async function createMagicAdminIdentityVerifier(input: {
  secretApiKey: string;
  config: MagicAdminVerifierConfig;
}): Promise<MagicAdminIdentityVerifier> {
  if (!input.secretApiKey || /REPLACE|EXAMPLE|CHANGE_ME/i.test(input.secretApiKey)) {
    throw new AppError('CONFIGURATION_INVALID', 'A real Magic Admin secret is required.');
  }
  try {
    const { Magic } = await import('@magic-sdk/admin');
    // Omitting clientId forces Magic.init to resolve the project client ID
    // using the secret. We then compare it in the constructor, proving the
    // secret-to-application binding instead of echoing caller configuration.
    const client = await Magic.init(input.secretApiKey);
    return new MagicAdminIdentityVerifier(client, input.config);
  } catch (error) {
    throw mapMagicError(error, 'AUTH_PROVIDER_UNAVAILABLE');
  }
}
