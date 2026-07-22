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

export const ParticleUserOpExecutionSchema = z
  .object({
    // SDK 2.0.3 declares `txs` as required, but its live V2 fee-quote response
    // can omit it. The actual EVM callData remains part of the signed user op.
    txs: z.array(ParticlePreparedCallSchema).max(16).optional(),
    userOp: z
      .object({
        callData: z.string().regex(/^0x(?:[0-9a-fA-F]{2})+$/),
      })
      .passthrough()
      .optional(),
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

function invalidExecutionCalls(path: string): AppError {
  return new AppError(
    'UA_PROVIDER_SCHEMA_INVALID',
    'Particle omitted independently verifiable EVM transaction calls.',
    {
      submissionPossible: false,
      safeDetails: { schemaIssuePath: path },
    },
  );
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
  if (parsed.txs !== undefined && parsed.txs.length > 0) return parsed.txs;
  const callData = parsed.userOp?.callData;
  if (callData === undefined) throw invalidExecutionCalls(`${path}.userOp.callData`);

  try {
    const decoded = decodeFunctionData({ abi: universalExecutorAbi, data: callData as Hex });
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
      throw invalidExecutionCalls(`${path}.userOp.callData`);
    }
    return targets.map((target, index) => {
      const value = values[index];
      const callDataAtIndex = data[index];
      if (value === undefined || callDataAtIndex === undefined) {
        throw invalidExecutionCalls(`${path}.userOp.callData`);
      }
      return normalizedCall(target, value, callDataAtIndex);
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    // Do not attach the decoder error: viem errors may echo full calldata.
    throw invalidExecutionCalls(`${path}.userOp.callData`);
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
  return {
    representation:
      parsed.txs !== undefined && parsed.txs.length > 0 ? 'preview_calls' : 'executor_calldata',
    executorCallDataDigest:
      parsed.userOp === undefined ? null : keccak256(parsed.userOp.callData as Hex),
    calls: calls.map((call) => ({
      uaType: call.uaType,
      to: call.to,
      value: call.value ?? '0x0',
      dataDigest: keccak256(call.data as Hex),
    })),
  };
}
