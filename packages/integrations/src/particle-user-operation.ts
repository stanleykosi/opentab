import { AppError, EvmAddressSchema } from '@opentab/shared';
import { decodeFunctionData, type Hex, keccak256, parseAbi, toHex } from 'viem';
import { z } from 'zod';

const universalExecutorAbi = parseAbi([
  'function execute(address target, uint256 value, bytes data)',
  'function execute_ncC(address target, uint256 value, bytes data)',
  'function executeBatch(address[] targets, uint256[] values, bytes[] data)',
  'function executeBatch_y6U(address[] targets, uint256[] values, bytes[] data)',
]);

export const ParticlePreparedCallSchema = z.object({
  uaType: z.string().min(1).max(80),
  to: EvmAddressSchema,
  data: z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/),
  value: z
    .string()
    .regex(/^0x[0-9a-fA-F]+$/)
    .optional(),
});

const EvmCallDataSchema = z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/);
const ProviderObjectSchema = z.record(z.string(), z.unknown());

export const ParticleUserOpExecutionSchema = z
  .object({
    // SDK 2.0.3 declares an EVM | Solana user-op union. Live fee-quote
    // responses may omit the convenience `txs`, so parse the union envelope
    // here and perform chain-specific EVM validation only at the call boundary.
    txs: z.array(z.unknown()).max(16).optional(),
    userOp: ProviderObjectSchema.optional(),
  })
  .passthrough();

export type ParticleUserOpExecution = z.infer<typeof ParticleUserOpExecutionSchema>;
export type ParticlePreparedCall = z.infer<typeof ParticlePreparedCallSchema>;

export interface ParticleUserOpExecutionEvidence {
  readonly representation: 'preview_calls' | 'executor_calldata';
  readonly executorCallDataDigest: Hex | null;
  readonly calls: readonly {
    readonly uaType: string;
    readonly to: string;
    readonly value: string;
    readonly dataDigest: Hex;
  }[];
}

function chainIdOf(input: ParticleUserOpExecution): number | undefined {
  const chainId = (input as Readonly<Record<string, unknown>>).chainId;
  return typeof chainId === 'number' && Number.isSafeInteger(chainId) ? chainId : undefined;
}

function invalidExecutionCalls(path: string, input: ParticleUserOpExecution): AppError {
  const chainId = chainIdOf(input);
  const solana = chainId === 101;
  return new AppError(
    solana ? 'UA_ROUTE_UNAVAILABLE' : 'UA_PROVIDER_SCHEMA_INVALID',
    solana
      ? 'Particle selected an unreviewed Solana operation instead of the configured EVM source route.'
      : 'Particle omitted independently verifiable EVM transaction calls.',
    {
      submissionPossible: false,
      safeDetails: {
        schemaIssuePath: path,
        ...(chainId === undefined ? {} : { providerChainId: chainId.toString() }),
      },
    },
  );
}

function previewCalls(input: ParticleUserOpExecution): readonly ParticlePreparedCall[] | undefined {
  const parsed = z.array(ParticlePreparedCallSchema).min(1).max(16).safeParse(input.txs);
  return parsed.success ? parsed.data : undefined;
}

function evmCallData(input: ParticleUserOpExecution): Hex | undefined {
  const parsed = EvmCallDataSchema.safeParse(input.userOp?.callData);
  return parsed.success ? (parsed.data as Hex) : undefined;
}

function normalizedCall(to: string, value: bigint, data: Hex): ParticlePreparedCall {
  return ParticlePreparedCallSchema.parse({
    uaType: 'evm-decoded',
    to: EvmAddressSchema.parse(to),
    data,
    value: toHex(value),
  });
}

/**
 * Returns the provider preview calls when supplied, otherwise decodes the
 * actual Universal executor calldata carried by the EVM user operation. No
 * template calls are synthesized: undecodable or ambiguous calldata fails
 * closed before a root hash can be signed.
 */
export function particleUserOpCalls(
  input: ParticleUserOpExecution,
  path: string,
): readonly ParticlePreparedCall[] {
  const parsed = ParticleUserOpExecutionSchema.parse(input);
  const reviewedPreviewCalls = previewCalls(parsed);
  if (reviewedPreviewCalls !== undefined) return reviewedPreviewCalls;
  const callData = evmCallData(parsed);
  if (callData === undefined || callData === '0x') {
    throw invalidExecutionCalls(`${path}.userOp.callData`, parsed);
  }

  try {
    const decoded = decodeFunctionData({ abi: universalExecutorAbi, data: callData });
    if (decoded.functionName === 'execute' || decoded.functionName === 'execute_ncC') {
      const [target, value, data] = decoded.args;
      return [normalizedCall(target, value, data)];
    }

    const [targets, values, data] = decoded.args;
    if (
      targets.length === 0 ||
      targets.length > 16 ||
      targets.length !== values.length ||
      targets.length !== data.length
    ) {
      throw invalidExecutionCalls(`${path}.userOp.callData`, parsed);
    }
    return targets.map((target, index) => {
      const value = values[index];
      const callDataAtIndex = data[index];
      if (value === undefined || callDataAtIndex === undefined) {
        throw invalidExecutionCalls(`${path}.userOp.callData`, parsed);
      }
      return normalizedCall(target, value, callDataAtIndex);
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    // Do not attach the decoder error: viem errors may echo full calldata.
    throw invalidExecutionCalls(`${path}.userOp.callData`, parsed);
  }
}

/**
 * Produces a bounded semantic record for evidence hashing. Particle user-op
 * calldata can exceed the shared evidence helper's reviewed string bound, so
 * only one-way hashes of calldata enter persisted evidence.
 */
export function particleUserOpExecutionEvidence(
  input: ParticleUserOpExecution,
  path: string,
): ParticleUserOpExecutionEvidence {
  const parsed = ParticleUserOpExecutionSchema.parse(input);
  const calls = particleUserOpCalls(parsed, path);
  const reviewedPreviewCalls = previewCalls(parsed);
  const callData = evmCallData(parsed);
  return {
    representation: reviewedPreviewCalls === undefined ? 'executor_calldata' : 'preview_calls',
    executorCallDataDigest: callData === undefined ? null : keccak256(callData),
    calls: calls.map((call) => ({
      uaType: call.uaType,
      to: call.to,
      value: call.value ?? '0x0',
      dataDigest: keccak256(call.data as Hex),
    })),
  };
}
