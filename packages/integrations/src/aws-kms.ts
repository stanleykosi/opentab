import { Buffer } from 'node:buffer';
import { createPublicKey } from 'node:crypto';
import {
  GetPublicKeyCommand,
  type GetPublicKeyCommandOutput,
  KMSClient,
  type KMSClientConfig,
  SignCommand,
  type SignCommandOutput,
} from '@aws-sdk/client-kms';
import { AppError, type EvmAddress, EvmAddressSchema, sameEvmAddress } from '@opentab/shared';
import type { AwsCredentialsProviderInit } from '@vercel/oidc-aws-credentials-provider';
import {
  bytesToHex,
  concatHex,
  type Hex,
  hexToBytes,
  recoverAddress,
  serializeSignature,
  toHex,
} from 'viem';
import { publicKeyToAddress } from 'viem/accounts';
import { z } from 'zod';
import { digestUnknown } from './evidence.js';

const SECP256K1_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const SECP256K1_HALF_ORDER = SECP256K1_ORDER / 2n;
const ECDSA_SHA_256 = 'ECDSA_SHA_256' as const;

const AwsErrorSchema = z
  .object({
    name: z.string().max(160).optional(),
    code: z.string().max(160).optional(),
  })
  .passthrough();

/** The two exact AWS commands used by OpenTab's managed-signing boundary. */
export interface AwsKmsClientLike {
  send(command: GetPublicKeyCommand): Promise<GetPublicKeyCommandOutput>;
  send(command: SignCommand): Promise<SignCommandOutput>;
}

export interface AwsKmsClientConfig {
  readonly region: string;
  readonly maxAttempts?: number;
  readonly credentials?: KMSClientConfig['credentials'];
}

interface VercelOidcAwsCredentialsModule {
  awsCredentialsProvider(
    init: AwsCredentialsProviderInit,
  ): NonNullable<KMSClientConfig['credentials']>;
}

export interface VercelOidcAwsKmsClientConfig extends AwsKmsClientConfig {
  readonly roleArn: string;
  /** Test seam; production uses a lazy import of Vercel's official provider. */
  readonly loadCredentialProvider?: () => Promise<VercelOidcAwsCredentialsModule>;
}

function assertRegion(region: string): void {
  if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(region)) {
    throw new AppError('CONFIGURATION_INVALID', 'The AWS KMS region is invalid.');
  }
}

function assertKeyId(keyId: string): void {
  if (keyId.length < 1 || keyId.length > 2_048 || /\s/.test(keyId)) {
    throw new AppError('CONFIGURATION_INVALID', 'The AWS KMS key identifier is invalid.');
  }
}

function assertRoleArn(roleArn: string): void {
  if (
    !/^arn:(?:aws|aws-us-gov|aws-cn):iam::[0-9]{12}:role\/[A-Za-z0-9+=,.@_/-]{1,512}$/.test(roleArn)
  ) {
    throw new AppError('CONFIGURATION_INVALID', 'The Vercel OIDC AWS role ARN is invalid.');
  }
}

export function createAwsKmsClient(config: AwsKmsClientConfig): KMSClient {
  assertRegion(config.region);
  const maxAttempts = config.maxAttempts ?? 3;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) {
    throw new AppError('CONFIGURATION_INVALID', 'The AWS KMS retry policy is invalid.');
  }
  return new KMSClient({
    region: config.region,
    maxAttempts,
    ...(config.credentials === undefined ? {} : { credentials: config.credentials }),
  });
}

/**
 * Creates a KMS client backed only by request-scoped Vercel OIDC credentials.
 * The provider module is loaded after the application selects a managed signer;
 * no static AWS access-key variables are read or accepted by this boundary.
 */
export async function createVercelOidcAwsKmsClient(
  config: VercelOidcAwsKmsClientConfig,
): Promise<KMSClient> {
  assertRoleArn(config.roleArn);
  const module = await (config.loadCredentialProvider?.() ??
    import('@vercel/oidc-aws-credentials-provider'));
  const credentials = module.awsCredentialsProvider({ roleArn: config.roleArn });
  return createAwsKmsClient({
    region: config.region,
    credentials,
    ...(config.maxAttempts === undefined ? {} : { maxAttempts: config.maxAttempts }),
  });
}

function mapAwsKmsError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const parsed = AwsErrorSchema.safeParse(error);
  const name =
    error instanceof Error
      ? error.name.slice(0, 160)
      : parsed.success
        ? (parsed.data.name ?? parsed.data.code ?? '')
        : '';
  const safeDetails = {
    vendor: 'aws-kms',
    causeDigest: digestUnknown(error),
  } as const;
  if (/Throttl|LimitExceeded/i.test(name)) {
    return new AppError('RATE_LIMITED', 'The managed signing service is rate limited.', {
      retryable: true,
      safeDetails,
      cause: error,
    });
  }
  if (
    /AccessDenied|Disabled|InvalidKeyUsage|KMSInvalidState|NotFound|Validation|UnsupportedOperation/i.test(
      name,
    )
  ) {
    return new AppError('CONFIGURATION_INVALID', 'The managed signing key is unavailable.', {
      safeDetails,
      cause: error,
    });
  }
  return new AppError('INTERNAL_ERROR', 'The managed signing service is unavailable.', {
    retryable: true,
    safeDetails,
    cause: error,
  });
}

function parsePublicKeyAddress(publicKeyDer: Uint8Array): EvmAddress {
  try {
    const publicKey = createPublicKey({
      key: Buffer.from(publicKeyDer),
      format: 'der',
      type: 'spki',
    });
    const jwk = publicKey.export({ format: 'jwk' });
    if (jwk.kty !== 'EC' || jwk.crv !== 'secp256k1' || jwk.x === undefined || jwk.y === undefined) {
      throw new Error('Unexpected public key curve');
    }
    const x = Buffer.from(jwk.x, 'base64url');
    const y = Buffer.from(jwk.y, 'base64url');
    if (x.length !== 32 || y.length !== 32) throw new Error('Unexpected public key length');
    const uncompressed = concatHex(['0x04', bytesToHex(x), bytesToHex(y)]);
    return EvmAddressSchema.parse(publicKeyToAddress(uncompressed));
  } catch (error) {
    throw new AppError('CONFIGURATION_INVALID', 'AWS KMS returned an invalid public key.', {
      cause: error,
    });
  }
}

interface ParsedDerSignature {
  readonly r: bigint;
  readonly s: bigint;
}

function readDerInteger(bytes: Uint8Array, offset: number): { value: bigint; next: number } {
  if (bytes[offset] !== 0x02) throw new Error('Expected DER integer');
  const length = bytes[offset + 1];
  if (length === undefined || length < 1 || length > 33) throw new Error('Invalid DER length');
  const start = offset + 2;
  const end = start + length;
  if (end > bytes.length) throw new Error('Truncated DER integer');
  const encoded = bytes.slice(start, end);
  const first = encoded[0];
  if (first === undefined || (first & 0x80) !== 0) throw new Error('Negative DER integer');
  if (encoded.length > 1 && first === 0 && encoded[1] !== undefined && (encoded[1] & 0x80) === 0) {
    throw new Error('Non-minimal DER integer');
  }
  const unsigned = first === 0 ? encoded.slice(1) : encoded;
  if (unsigned.length > 32) throw new Error('Oversized DER integer');
  const hex = bytesToHex(unsigned);
  const value = unsigned.length === 0 ? 0n : BigInt(hex);
  if (value <= 0n || value >= SECP256K1_ORDER) throw new Error('DER integer out of range');
  return { value, next: end };
}

export function parseAwsKmsDerSignature(signature: Uint8Array): ParsedDerSignature {
  try {
    if (signature.length < 8 || signature.length > 72 || signature[0] !== 0x30) {
      throw new Error('Invalid DER sequence');
    }
    const sequenceLength = signature[1];
    if (sequenceLength === undefined || sequenceLength !== signature.length - 2) {
      throw new Error('Invalid DER sequence length');
    }
    const r = readDerInteger(signature, 2);
    const s = readDerInteger(signature, r.next);
    if (s.next !== signature.length) throw new Error('Trailing DER data');
    return { r: r.value, s: s.value };
  } catch (error) {
    throw new AppError('INTERNAL_ERROR', 'AWS KMS returned an invalid signature.', {
      cause: error,
    });
  }
}

async function canonicalRecoverableSignature(input: {
  readonly digest: Hex;
  readonly derSignature: Uint8Array;
  readonly expectedAddress: EvmAddress;
}): Promise<Hex> {
  const parsed = parseAwsKmsDerSignature(input.derSignature);
  const normalizedS = parsed.s > SECP256K1_HALF_ORDER ? SECP256K1_ORDER - parsed.s : parsed.s;
  const candidates: Hex[] = [];
  for (const yParity of [0, 1] as const) {
    const signature = serializeSignature({
      r: toHex(parsed.r, { size: 32 }),
      s: toHex(normalizedS, { size: 32 }),
      yParity,
    });
    try {
      const recovered = EvmAddressSchema.parse(
        await recoverAddress({ hash: input.digest, signature }),
      );
      if (sameEvmAddress(recovered, input.expectedAddress)) candidates.push(signature);
    } catch {
      // A recovery branch that cannot decode is not a valid candidate.
    }
  }
  if (candidates.length !== 1) {
    throw new AppError(
      'INTERNAL_ERROR',
      'The managed signature did not recover to the configured address.',
    );
  }
  const signature = candidates[0];
  if (signature === undefined) {
    throw new AppError('INTERNAL_ERROR', 'The managed signature is unavailable.');
  }
  return signature;
}

/**
 * Narrow AWS KMS secp256k1 signer. It can sign only caller-supplied 32-byte
 * digests; domain/call policy remains in the typed order/split/sponsor adapters.
 */
export class AwsKmsSecp256k1Signer {
  readonly address: EvmAddress;
  readonly resolvedKeyId: string;

  private constructor(
    private readonly client: AwsKmsClientLike,
    resolvedKeyId: string,
    address: EvmAddress,
  ) {
    this.resolvedKeyId = resolvedKeyId;
    this.address = address;
  }

  static async create(input: {
    readonly client: AwsKmsClientLike;
    readonly keyId: string;
    readonly expectedAddress: EvmAddress;
  }): Promise<AwsKmsSecp256k1Signer> {
    assertKeyId(input.keyId);
    let output: GetPublicKeyCommandOutput;
    try {
      output = await input.client.send(new GetPublicKeyCommand({ KeyId: input.keyId }));
    } catch (error) {
      throw mapAwsKmsError(error);
    }
    if (
      output.PublicKey === undefined ||
      output.KeyId === undefined ||
      output.KeySpec !== 'ECC_SECG_P256K1' ||
      output.KeyUsage !== 'SIGN_VERIFY' ||
      output.SigningAlgorithms?.includes(ECDSA_SHA_256) !== true
    ) {
      throw new AppError(
        'CONFIGURATION_INVALID',
        'AWS KMS key must be an enabled secp256k1 signing key.',
      );
    }
    const address = parsePublicKeyAddress(output.PublicKey);
    if (!sameEvmAddress(address, input.expectedAddress)) {
      throw new AppError(
        'CONFIGURATION_INVALID',
        'AWS KMS public key does not match the configured signer address.',
      );
    }
    return new AwsKmsSecp256k1Signer(input.client, output.KeyId, address);
  }

  async signDigest(digest: Hex): Promise<Hex> {
    if (!/^0x[0-9a-fA-F]{64}$/.test(digest)) {
      throw new AppError('VALIDATION_FAILED', 'Managed signing requires a 32-byte digest.');
    }
    let output: SignCommandOutput;
    try {
      output = await this.client.send(
        new SignCommand({
          // Use the resolved ARN from GetPublicKey so an alias cannot be
          // retargeted between startup verification and signing.
          KeyId: this.resolvedKeyId,
          Message: hexToBytes(digest),
          MessageType: 'DIGEST',
          SigningAlgorithm: ECDSA_SHA_256,
        }),
      );
    } catch (error) {
      throw mapAwsKmsError(error);
    }
    if (
      output.Signature === undefined ||
      output.SigningAlgorithm !== ECDSA_SHA_256 ||
      output.KeyId !== this.resolvedKeyId
    ) {
      throw new AppError('INTERNAL_ERROR', 'AWS KMS returned an incomplete signing response.');
    }
    return canonicalRecoverableSignature({
      digest,
      derSignature: output.Signature,
      expectedAddress: this.address,
    });
  }
}
