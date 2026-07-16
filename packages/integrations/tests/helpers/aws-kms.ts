import { Buffer } from 'node:buffer';
import { createPublicKey, randomBytes } from 'node:crypto';
import { GetPublicKeyCommand, type SignCommand } from '@aws-sdk/client-kms';
import { EvmAddressSchema } from '@opentab/shared';
import { computeAddress, SigningKey } from 'ethers';
import { bytesToHex } from 'viem';
import type { AwsKmsClientLike } from '../../src/aws-kms.js';

const CURVE_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

function derInteger(value: bigint): Buffer {
  let hex = value.toString(16);
  if (hex.length % 2 !== 0) hex = `0${hex}`;
  let bytes = Buffer.from(hex, 'hex');
  if ((bytes[0] ?? 0) >= 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
  return Buffer.concat([Buffer.from([0x02, bytes.length]), bytes]);
}

function derSignature(r: bigint, s: bigint): Uint8Array {
  const body = Buffer.concat([derInteger(r), derInteger(s)]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

function ephemeralSigningKey(): SigningKey {
  for (;;) {
    try {
      return new SigningKey(`0x${randomBytes(32).toString('hex')}`);
    } catch {
      // Retry the astronomically unlikely zero/out-of-range scalar.
    }
  }
}

/** Public-only KMS shape with an ephemeral test key that never leaves memory. */
export function createFakeAwsKms(input: { highS?: boolean } = {}) {
  const key = ephemeralSigningKey();
  const publicKey = key.publicKey;
  const x = Buffer.from(publicKey.slice(4, 68), 'hex').toString('base64url');
  const y = Buffer.from(publicKey.slice(68), 'hex').toString('base64url');
  const spki = createPublicKey({
    key: { kty: 'EC', crv: 'secp256k1', x, y },
    format: 'jwk',
  }).export({ format: 'der', type: 'spki' });
  const address = EvmAddressSchema.parse(computeAddress(publicKey));
  const resolvedKeyId = `arn:aws:kms:eu-west-1:000000000000:key/${address.slice(2).toLowerCase()}`;
  const commands: Array<GetPublicKeyCommand | SignCommand> = [];
  const client = {
    async send(command: GetPublicKeyCommand | SignCommand) {
      commands.push(command);
      if (command instanceof GetPublicKeyCommand) {
        return {
          $metadata: {},
          KeyId: resolvedKeyId,
          PublicKey: new Uint8Array(spki),
          KeySpec: 'ECC_SECG_P256K1' as const,
          KeyUsage: 'SIGN_VERIFY' as const,
          SigningAlgorithms: ['ECDSA_SHA_256' as const],
        };
      }
      const message = command.input.Message;
      if (
        message === undefined ||
        command.input.MessageType !== 'DIGEST' ||
        command.input.SigningAlgorithm !== 'ECDSA_SHA_256' ||
        command.input.KeyId !== resolvedKeyId
      ) {
        throw new Error('Unexpected test KMS signing request');
      }
      const signature = key.sign(bytesToHex(message));
      const lowS = BigInt(signature.s);
      const s = input.highS ? CURVE_ORDER - lowS : lowS;
      return {
        $metadata: {},
        KeyId: resolvedKeyId,
        Signature: derSignature(BigInt(signature.r), s),
        SigningAlgorithm: 'ECDSA_SHA_256' as const,
      };
    },
  } as unknown as AwsKmsClientLike;
  return { client, address, resolvedKeyId, commands };
}
