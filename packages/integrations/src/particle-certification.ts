import {
  AppError,
  ARBITRUM_ONE_CHAIN_ID,
  type CheckoutBinding,
  CheckoutBindingSchema,
  digestParticleProjectConfiguration,
  type EvidenceDigest,
  type EvmAddress,
  EvmAddressSchema,
  type ParticleCompatibilityProfile,
  ParticleCompatibilityProfileSchema,
  sameEvmAddress,
} from '@opentab/shared';
import {
  CHAIN_ID,
  PREFER_TOKEN_TYPE,
  SUPPORTED_TOKEN_TYPE,
  UNIVERSAL_ACCOUNT_VERSION,
  UniversalAccount,
} from '@particle-network/universal-account-sdk';
import { getAddress, type Hex, keccak256, toHex } from 'viem';
import { z } from 'zod';
import { digestUnknown } from './evidence.js';
import { createCheckoutOperationTemplate } from './particle.js';
import { ParticleAuthorizationChainIdSchema } from './particle-response-schemas.js';
import {
  ParticleUserOpExecutionSchema,
  particleUserOpCalls,
  particleUserOpExecutionEvidence,
} from './particle-user-operation.js';
import { mapParticleError } from './vendor-errors.js';

const ARBITRUM_CHAIN_NUMBER = Number(ARBITRUM_ONE_CHAIN_ID);
const EIP7702_DESIGNATOR_PREFIX = '0xef0100';

const SmartAccountSchema = z
  .object({
    name: z.literal('UNIVERSAL'),
    version: z.literal(UNIVERSAL_ACCOUNT_VERSION),
    ownerAddress: EvmAddressSchema,
    smartAccountAddress: EvmAddressSchema,
    useEIP7702: z.literal(true),
  })
  .passthrough();

const PrimaryAssetsCaptureSchema = z
  .object({
    assets: z.array(
      z
        .object({
          tokenType: z.enum(['eth', 'usdt', 'usdc', 'bnb', 'sol']),
          amount: z.number().finite().nonnegative(),
          amountInUSD: z.number().finite().nonnegative(),
          chainAggregation: z.array(z.unknown()),
        })
        .passthrough(),
    ),
    totalAmountInUSD: z.number().finite().nonnegative(),
  })
  .passthrough();

const DeploymentSchema = z
  .object({
    chainId: z.number().int().positive().safe(),
    isDelegated: z.boolean(),
    address: EvmAddressSchema.optional(),
  })
  .passthrough();

const AuthSchema = z
  .object({
    chainId: ParticleAuthorizationChainIdSchema.optional(),
    address: EvmAddressSchema,
    nonce: z.number().int().nonnegative().safe(),
  })
  .passthrough();

const TokenAmountSchema = z.object({
  token: z.object({
    type: z.enum(['eth', 'usdt', 'usdc', 'bnb', 'sol']).optional(),
    chainId: z.number().int().positive().safe(),
    address: z.string().min(1).max(128),
  }),
  amount: z.string().min(1).max(100),
  amountInUSD: z.string().min(1).max(100),
  // Particle's live v2 RPC can omit this token-row attribution field even
  // though SDK 2.0.3 still declares it as required. It is not an authority
  // boundary: owner continuity is enforced by the required top-level sender
  // and smartAccountOptions addresses below.
  senderAddress: z.string().min(1).max(128).nullish(),
});

const PreparedCaptureSchema = z
  .object({
    sender: EvmAddressSchema,
    transactionId: z.string().min(1).max(256),
    smartAccountOptions: z.object({
      ownerAddress: EvmAddressSchema,
      senderAddress: EvmAddressSchema,
    }),
    depositTokens: z.array(TokenAmountSchema),
    tokenChanges: z.object({ decr: z.array(TokenAmountSchema) }),
    rootHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    userOps: z.array(
      ParticleUserOpExecutionSchema.extend({
        chainId: z.number().int().positive().safe(),
      }).passthrough(),
    ),
  })
  .passthrough();

const RpcResponseSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: z.union([z.number(), z.string()]),
    result: z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/),
  })
  .strict();

interface CertificationSdkLike {
  getSmartAccountOptions(): Promise<unknown>;
  getPrimaryAssets(): Promise<unknown>;
  getEIP7702Deployments(): Promise<unknown>;
  getEIP7702Auth(chainIds: number[]): Promise<unknown>;
  createUniversalTransaction(input: {
    chainId: number;
    expectTokens: readonly { type: SUPPORTED_TOKEN_TYPE; amount: string }[];
    transactions: readonly { to: string; data: string; value?: string }[];
  }): Promise<unknown>;
}

export interface ParticleOperatorCertificationConfig {
  readonly profileId: string;
  readonly environment: 'demo-mainnet' | 'production';
  readonly projectId: string;
  readonly projectClientKey: string;
  readonly projectAppUuid: string;
  readonly ownerAddress: EvmAddress;
  readonly magic: {
    getOwnerAddress(): Promise<EvmAddress>;
    getChainId(): Promise<string>;
    switchToArbitrum(): Promise<void>;
    probeDelegationAuthorizationNonce(input: {
      ownerAddress: EvmAddress;
      implementationAddress: EvmAddress;
    }): Promise<{
      chainId: typeof ARBITRUM_ONE_CHAIN_ID;
      implementationAddress: EvmAddress;
      nonce: string;
    }>;
  };
  readonly arbitrumRpcUrl: string;
  readonly allowedArbitrumRpcOrigins: readonly string[];
  readonly allowedSourceChainIds: readonly string[];
  readonly allowedSourceAssets: readonly ('USDC' | 'USDT' | 'ETH')[];
  readonly slippageBps: number;
  readonly delegationPlanTtlSeconds: number;
  readonly particleRpcUrl?: string;
  readonly now?: () => Date;
}

interface CertificationDependencies {
  readonly sdk: CertificationSdkLike;
  readonly fetch: typeof globalThis.fetch;
}

interface BootstrapCapture {
  readonly profile: ParticleCompatibilityProfile;
  readonly delegateAddress: EvmAddress;
}

type CertificationProviderMethod =
  | 'universal_getUniversalAccount'
  | 'universal_getPrimaryAssets'
  | 'universal_getEIP7702Deployments'
  | 'universal_createEIP7702DelegationAuth'
  | 'universal_createTransaction';

function particleCertificationProviderError(
  method: CertificationProviderMethod,
  error: unknown,
  response?: unknown,
): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof z.ZodError) {
    const issue = error.issues[0];
    const issuePath = issue?.path.map(String).join('.') || 'root';
    const providerShape = particleUserOpsShape(response);
    return new AppError(
      'UA_PROVIDER_SCHEMA_INVALID',
      `Particle returned an unsupported response for ${method} at ${issuePath}.${providerShape === undefined ? '' : ` Shape: ${providerShape}.`} No transaction was submitted.`,
      {
        retryable: false,
        safeDetails: {
          vendor: 'particle',
          providerMethod: method,
          schemaIssueCode: issue?.code ?? 'unknown',
          schemaIssuePath: issuePath,
          ...(providerShape === undefined ? {} : { providerShape }),
        },
      },
    );
  }
  const mapped = mapParticleError(error, 'UA_PROVIDER_SCHEMA_INVALID');
  const vendorCode = mapped.safeDetails?.vendorCauseCode ?? mapped.safeDetails?.vendorCode;
  const vendorReason = mapped.safeDetails?.vendorReason;
  const diagnostic = mapped.safeDetails?.causeDigest?.slice(2, 14);
  const message =
    vendorCode === '40102'
      ? `Particle rejected the configured project credentials during ${method}. Copy the Project ID, Client Key, and App ID from the same Particle web application, set its domain to opentab-opal.vercel.app, then redeploy Vercel. No transaction was submitted.`
      : vendorReason === 'insufficient_funds'
        ? `Particle could not prepare the activation route during ${method} because the unified balance is insufficient for the 0.10 USDC payment plus route fees. Add supported non-Arbitrum liquidity, then create a fresh activation preview. No transaction was submitted.`
        : vendorReason === 'invalid_parameters'
          ? `Particle rejected the ${method} parameters${vendorCode === undefined ? '' : ` (code ${vendorCode})`}. Verify that the Project ID, Client Key, and App ID belong to the same web app and that its allowed domain is opentab-opal.vercel.app. No transaction was submitted.`
          : vendorReason === 'unsupported_chain'
            ? `Particle does not support one of the configured chains during ${method} (code ${vendorCode}). No transaction was submitted.`
            : vendorReason === 'simulation_failed'
              ? `Particle could not simulate the exact OpenTab activation payment during ${method} (code ${vendorCode}). Refresh to create an unexpired order, then retry once. No transaction was submitted.`
              : vendorReason === 'network_unavailable'
                ? `The browser could not reach Particle during ${method}. Confirm the Particle web-app domain is opentab-opal.vercel.app and disable any blocker for universal-rpc-proxy.particle.network, then retry. No transaction was submitted.`
                : vendorReason === 'timeout'
                  ? `Particle timed out during ${method}. Retry once; if it repeats, report this method and code to Particle support. No transaction was submitted.`
                  : `Particle could not complete ${method}${vendorCode === undefined ? '' : ` (code ${vendorCode})`}${diagnostic === undefined ? '' : `, diagnostic ${diagnostic}`}. No transaction was submitted.`;
  return new AppError(mapped.code, message, {
    retryable: vendorCode === '40102' ? false : mapped.retryable,
    submissionPossible: false,
    ...(mapped.safeDetails === undefined
      ? { safeDetails: { providerMethod: method } }
      : { safeDetails: { ...mapped.safeDetails, providerMethod: method } }),
    cause: error,
  });
}

function particleUserOpsShape(response: unknown): string | undefined {
  if (typeof response !== 'object' || response === null) return undefined;
  const userOps = (response as Readonly<Record<string, unknown>>).userOps;
  if (!Array.isArray(userOps)) return undefined;

  return userOps
    .slice(0, 8)
    .map((entry, index) => {
      if (typeof entry !== 'object' || entry === null) return `${index}:invalid`;
      const operation = entry as Readonly<Record<string, unknown>>;
      const chainId =
        typeof operation.chainId === 'number' || typeof operation.chainId === 'string'
          ? String(operation.chainId).slice(0, 20)
          : 'unknown';
      const userOp =
        typeof operation.userOp === 'object' && operation.userOp !== null
          ? (operation.userOp as Readonly<Record<string, unknown>>)
          : undefined;
      const kind =
        typeof userOp?.callData === 'string'
          ? 'evm'
          : Array.isArray(userOp?.insArgs)
            ? 'solana'
            : 'unknown';
      const txCount = Array.isArray(operation.txs) ? Math.min(operation.txs.length, 99) : 0;
      const callDataBytes =
        typeof userOp?.callData === 'string' && /^0x[0-9a-fA-F]*$/.test(userOp.callData)
          ? Math.max(0, Math.floor((userOp.callData.length - 2) / 2))
          : 0;
      return `${index}:chain=${chainId},kind=${kind},txs=${txCount},callDataBytes=${callDataBytes}`;
    })
    .join(';');
}

async function captureBootstrapProviderResponse<T>(
  method: CertificationProviderMethod,
  read: () => Promise<unknown>,
  schema: { parse(value: unknown): T },
): Promise<{ readonly raw: unknown; readonly value: T }> {
  let raw: unknown;
  try {
    raw = await read();
  } catch (error) {
    throw particleCertificationProviderError(method, error);
  }
  try {
    return { raw, value: schema.parse(raw) };
  } catch (error) {
    throw particleCertificationProviderError(method, error, raw);
  }
}

function assertConfigured(config: ParticleOperatorCertificationConfig): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{2,108}$/.test(config.profileId)) {
    throw new AppError(
      'UA_CONFIGURATION_INVALID',
      'Particle certification profile base is invalid.',
    );
  }
  for (const value of [config.projectId, config.projectClientKey, config.projectAppUuid]) {
    if (value.length === 0 || /REPLACE|EXAMPLE|CHANGE_ME/i.test(value)) {
      throw new AppError(
        'UA_CONFIGURATION_INVALID',
        'Particle certification credentials are incomplete.',
      );
    }
  }
  const rpc = safeHttpsUrl(config.arbitrumRpcUrl, 'Arbitrum RPC');
  const allowed = new Set(
    config.allowedArbitrumRpcOrigins.map((entry) => safeHttpsUrl(entry, 'RPC origin').origin),
  );
  if (!allowed.has(rpc.origin)) {
    throw new AppError(
      'UA_CONFIGURATION_INVALID',
      'The certification RPC is outside its origin allowlist.',
    );
  }
  if (
    !Number.isInteger(config.slippageBps) ||
    config.slippageBps < 0 ||
    config.slippageBps > 500 ||
    !Number.isInteger(config.delegationPlanTtlSeconds) ||
    config.delegationPlanTtlSeconds < 30 ||
    config.delegationPlanTtlSeconds > 600
  ) {
    throw new AppError('UA_CONFIGURATION_INVALID', 'Particle certification policy is invalid.');
  }
  if (!config.allowedSourceChainIds.includes(ARBITRUM_ONE_CHAIN_ID)) {
    throw new AppError(
      'UA_CONFIGURATION_INVALID',
      'Arbitrum must remain in the source-chain policy.',
    );
  }
}

function safeHttpsUrl(value: string, label: string): URL {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('unsafe URL');
    return url;
  } catch (error) {
    throw new AppError(
      'UA_CONFIGURATION_INVALID',
      `${label} must be a credential-free HTTPS URL.`,
      {
        cause: error,
      },
    );
  }
}

function assetForToken(token: z.infer<typeof TokenAmountSchema>['token']) {
  if (token.type === 'usdc') return 'USDC' as const;
  if (token.type === 'usdt') return 'USDT' as const;
  if (token.type === 'eth') return 'ETH' as const;
  return undefined;
}

function exactDestination(
  prepared: z.infer<typeof PreparedCaptureSchema>,
  binding: CheckoutBinding,
) {
  const template = createCheckoutOperationTemplate(binding);
  const calls = prepared.userOps.flatMap((operation, index) =>
    operation.chainId === ARBITRUM_CHAIN_NUMBER
      ? particleUserOpCalls(operation, `userOps.${index}`)
      : [],
  );
  if (calls.length !== template.calls.length) {
    throw new AppError(
      'UA_PROVIDER_SCHEMA_INVALID',
      'Particle changed the canary destination calls.',
    );
  }
  for (const [index, expected] of template.calls.entries()) {
    const actual = calls[index];
    if (
      actual === undefined ||
      !sameEvmAddress(actual.to, expected.to) ||
      actual.data.toLowerCase() !== expected.data.toLowerCase() ||
      BigInt(actual.value ?? '0x0') !== BigInt(expected.valueWei)
    ) {
      throw new AppError(
        'UA_PROVIDER_SCHEMA_INVALID',
        'Particle changed the bound canary transaction.',
      );
    }
  }
  return template;
}

export class ParticleOperatorCertificationAdapter {
  #bootstrapCapture: Promise<BootstrapCapture> | undefined;

  constructor(
    private readonly config: ParticleOperatorCertificationConfig,
    private readonly dependencies: CertificationDependencies,
  ) {
    assertConfigured(config);
  }

  async captureBootstrap(): Promise<{ profile: ParticleCompatibilityProfile }> {
    const capture = await this.#bootstrap();
    return { profile: capture.profile };
  }

  async captureCanaryReady(bindingInput: CheckoutBinding): Promise<{
    profile: ParticleCompatibilityProfile;
    preparedFixtureDigest: EvidenceDigest;
  }> {
    const binding = CheckoutBindingSchema.parse(bindingInput);
    if (!sameEvmAddress(binding.orderIntent.payer, this.config.ownerAddress)) {
      throw new AppError(
        'WALLET_ADDRESS_MISMATCH',
        'The canary binding belongs to another wallet.',
      );
    }
    const bootstrap = await this.#bootstrap();
    await this.#assertOwnerContinuity();
    const template = createCheckoutOperationTemplate(binding);
    try {
      const preparedCapture = await captureBootstrapProviderResponse(
        'universal_createTransaction',
        () =>
          this.dependencies.sdk.createUniversalTransaction({
            chainId: CHAIN_ID.ARBITRUM_MAINNET_ONE,
            expectTokens: [
              {
                type: SUPPORTED_TOKEN_TYPE.USDC,
                amount: `${BigInt(binding.orderIntent.amountBaseUnits) / 1_000_000n}.${(
                  BigInt(binding.orderIntent.amountBaseUnits) % 1_000_000n
                )
                  .toString()
                  .padStart(6, '0')}`,
              },
            ],
            transactions: template.calls.map((call) => ({
              to: call.to,
              data: call.data,
              value: toHex(BigInt(call.valueWei)),
            })),
          }),
        PreparedCaptureSchema,
      );
      const prepared = preparedCapture.value;
      if (
        !sameEvmAddress(prepared.sender, this.config.ownerAddress) ||
        !sameEvmAddress(prepared.smartAccountOptions.ownerAddress, this.config.ownerAddress) ||
        !sameEvmAddress(prepared.smartAccountOptions.senderAddress, this.config.ownerAddress)
      ) {
        throw new AppError(
          'WALLET_ADDRESS_MISMATCH',
          'Particle prepared the canary for another owner.',
        );
      }
      for (const operation of prepared.userOps) {
        if (
          operation.chainId !== ARBITRUM_CHAIN_NUMBER &&
          !this.config.allowedSourceChainIds.includes(operation.chainId.toString())
        ) {
          throw new AppError(
            'UA_ROUTE_UNAVAILABLE',
            `Particle selected source chain ${operation.chainId}, which is outside the configured activation route.`,
            {
              submissionPossible: false,
              safeDetails: { providerChainId: operation.chainId.toString() },
            },
          );
        }
      }
      exactDestination(prepared, binding);
      const sourceValues =
        prepared.tokenChanges.decr.length > 0 ? prepared.tokenChanges.decr : prepared.depositTokens;
      const nonArbitrum = sourceValues.filter(
        (entry) => entry.token.chainId !== ARBITRUM_CHAIN_NUMBER,
      );
      if (nonArbitrum.length === 0) {
        throw new AppError(
          'UA_ROUTE_UNAVAILABLE',
          'Certification requires a canary routed from a non-Arbitrum source asset.',
        );
      }
      const byChain = new Map<number, (typeof nonArbitrum)[number]>();
      for (const entry of nonArbitrum) {
        const asset = assetForToken(entry.token);
        const chainId = entry.token.chainId.toString();
        if (
          asset === undefined ||
          !this.config.allowedSourceAssets.includes(asset) ||
          !this.config.allowedSourceChainIds.includes(chainId) ||
          byChain.has(entry.token.chainId)
        ) {
          throw new AppError(
            'UA_PROVIDER_SCHEMA_INVALID',
            'Particle selected an uncertifiable source asset.',
          );
        }
        EvmAddressSchema.parse(entry.token.address);
        byChain.set(entry.token.chainId, entry);
      }
      const preparedFixtureDigest = digestUnknown({
        schemaVersion: 2,
        sender: prepared.sender,
        transactionId: prepared.transactionId,
        smartAccountOptions: prepared.smartAccountOptions,
        depositTokens: prepared.depositTokens,
        tokenChanges: prepared.tokenChanges,
        rootHash: prepared.rootHash,
        userOps: prepared.userOps.map((operation, index) => ({
          chainId: operation.chainId,
          execution: particleUserOpExecutionEvidence(operation, `userOps.${index}`),
        })),
      });
      const allowedSourceTokens = [...byChain.values()].map((entry) => ({
        chainId: entry.token.chainId.toString(),
        asset: assetForToken(entry.token) as 'USDC' | 'USDT' | 'ETH',
        address: EvmAddressSchema.parse(entry.token.address),
      }));
      const sourceCallPolicies: {
        policyId: string;
        chainId: string;
        asset: 'USDC' | 'USDT' | 'ETH';
        tokenAddress: EvmAddress;
        uaType: string;
        target: EvmAddress;
        functionSelector: `0x${string}`;
        nativeValueAllowed: boolean;
        maxCalls: number;
        capturedFixtureDigest: EvidenceDigest;
      }[] = [];
      for (const [operationIndex, operation] of prepared.userOps.entries()) {
        if (operation.chainId === ARBITRUM_CHAIN_NUMBER) continue;
        const source = byChain.get(operation.chainId);
        const asset = source === undefined ? undefined : assetForToken(source.token);
        if (source === undefined || asset === undefined) {
          throw new AppError(
            'UA_PROVIDER_SCHEMA_INVALID',
            'Particle added an unbound source operation.',
          );
        }
        const normalizedCalls = new Map<
          string,
          {
            uaType: string;
            target: EvmAddress;
            selector: `0x${string}`;
            nativeValue: boolean;
            count: number;
          }
        >();
        for (const call of particleUserOpCalls(operation, `userOps.${operationIndex}`)) {
          const selector = call.data.slice(0, 10).toLowerCase();
          if (!/^0x[0-9a-f]{8}$/.test(selector)) {
            throw new AppError(
              'UA_PROVIDER_SCHEMA_INVALID',
              'Particle source call has no function selector.',
            );
          }
          const nativeValue = BigInt(call.value ?? '0x0') > 0n;
          const key = JSON.stringify([call.uaType, call.to.toLowerCase(), selector, nativeValue]);
          const existing = normalizedCalls.get(key);
          normalizedCalls.set(key, {
            uaType: call.uaType,
            target: call.to,
            selector: selector as `0x${string}`,
            nativeValue,
            count: (existing?.count ?? 0) + 1,
          });
        }
        let policyIndex = 0;
        for (const normalized of normalizedCalls.values()) {
          const policyId = `source-${operation.chainId}-${asset.toLowerCase()}-${normalized.selector.slice(2)}-${policyIndex}`;
          sourceCallPolicies.push({
            policyId,
            chainId: operation.chainId.toString(),
            asset,
            tokenAddress: EvmAddressSchema.parse(source.token.address),
            uaType: normalized.uaType,
            target: normalized.target,
            functionSelector: normalized.selector,
            nativeValueAllowed: normalized.nativeValue && asset === 'ETH',
            maxCalls: normalized.count,
            capturedFixtureDigest: digestUnknown({
              domain: 'opentab/particle-source-call-policy',
              policyId,
              preparedFixtureDigest,
            }),
          });
          policyIndex += 1;
        }
      }
      const capturedAt = (this.config.now?.() ?? new Date()).toISOString();
      return {
        preparedFixtureDigest,
        profile: ParticleCompatibilityProfileSchema.parse({
          ...bootstrap.profile,
          profileId: `${this.config.profileId}:canary-ready`,
          stage: 'canary_ready',
          sourceTokenProfile: {
            allowedSourceChainIds: [
              ARBITRUM_ONE_CHAIN_ID,
              ...[...byChain.keys()]
                .map(String)
                .sort((left, right) => (BigInt(left) < BigInt(right) ? -1 : 1)),
            ],
            allowedSourceAssets: [
              ...new Set(allowedSourceTokens.map((entry) => entry.asset)),
            ].sort(),
            allowedSourceTokens,
            sourceCallPolicies,
          },
          capturedAt,
        }),
      };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw mapParticleError(error, 'UA_PROVIDER_SCHEMA_INVALID');
    }
  }

  async #bootstrap(): Promise<BootstrapCapture> {
    this.#bootstrapCapture ??= this.#captureBootstrap();
    return this.#bootstrapCapture;
  }

  async #captureBootstrap(): Promise<BootstrapCapture> {
    await this.#assertOwnerContinuity();
    await this.config.magic.switchToArbitrum();
    if ((await this.config.magic.getChainId()) !== ARBITRUM_ONE_CHAIN_ID) {
      throw new AppError('WALLET_CHAIN_SWITCH_FAILED', 'Magic did not enter Arbitrum One.');
    }
    try {
      const [accountCapture, balanceCapture, deploymentsCapture, authCapture] = await Promise.all([
        captureBootstrapProviderResponse(
          'universal_getUniversalAccount',
          () => this.dependencies.sdk.getSmartAccountOptions(),
          SmartAccountSchema,
        ),
        captureBootstrapProviderResponse(
          'universal_getPrimaryAssets',
          () => this.dependencies.sdk.getPrimaryAssets(),
          PrimaryAssetsCaptureSchema,
        ),
        captureBootstrapProviderResponse(
          'universal_getEIP7702Deployments',
          () => this.dependencies.sdk.getEIP7702Deployments(),
          z.array(DeploymentSchema).min(1),
        ),
        captureBootstrapProviderResponse(
          'universal_createEIP7702DelegationAuth',
          () => this.dependencies.sdk.getEIP7702Auth([ARBITRUM_CHAIN_NUMBER]),
          z.array(AuthSchema).length(1),
        ),
      ]);
      const accountRaw = accountCapture.raw;
      const account = accountCapture.value;
      const balanceRaw = balanceCapture.raw;
      const deploymentsRaw = deploymentsCapture.raw;
      const deployments = deploymentsCapture.value;
      const authRaw = authCapture.raw;
      const [auth] = authCapture.value;
      if (auth === undefined) {
        throw new AppError(
          'UA_PROVIDER_SCHEMA_INVALID',
          'Particle omitted the Arbitrum delegation authorization.',
        );
      }
      if (
        auth.chainId !== undefined &&
        auth.chainId !== 0 &&
        auth.chainId !== ARBITRUM_CHAIN_NUMBER
      ) {
        throw new AppError(
          'UA_PROVIDER_SCHEMA_INVALID',
          'Particle returned a wrong-chain delegation authorization.',
        );
      }
      if (
        !sameEvmAddress(account.ownerAddress, this.config.ownerAddress) ||
        !sameEvmAddress(account.smartAccountAddress, this.config.ownerAddress)
      ) {
        throw new AppError('WALLET_ADDRESS_MISMATCH', 'Particle did not preserve the Magic EOA.');
      }
      const deployment = deployments.find((entry) => entry.chainId === ARBITRUM_CHAIN_NUMBER);
      if (deployment === undefined) {
        throw new AppError(
          'UA_PROVIDER_SCHEMA_INVALID',
          'Particle omitted Arbitrum delegation state.',
        );
      }
      const delegateAddress = EvmAddressSchema.parse(auth.address);
      if (
        deployment.address !== undefined &&
        !sameEvmAddress(deployment.address, delegateAddress)
      ) {
        throw new AppError(
          'UA_PROVIDER_SCHEMA_INVALID',
          'Particle returned conflicting delegates.',
        );
      }
      const [delegateCode, ownerCode] = await Promise.all([
        this.#getCode(delegateAddress),
        this.#getCode(this.config.ownerAddress),
      ]);
      if (delegateCode === '0x') {
        throw new AppError(
          'UA_PROVIDER_SCHEMA_INVALID',
          'The Particle delegate has no Arbitrum code.',
        );
      }
      if (
        ownerCode !== '0x' &&
        ownerCode.toLowerCase() !==
          `${EIP7702_DESIGNATOR_PREFIX}${delegateAddress.slice(2)}`.toLowerCase()
      ) {
        throw new AppError(
          'UA_PROVIDER_SCHEMA_INVALID',
          'The Magic EOA has an unexpected delegation designator.',
        );
      }
      const probe = await this.config.magic.probeDelegationAuthorizationNonce({
        ownerAddress: this.config.ownerAddress,
        implementationAddress: delegateAddress,
      });
      if (
        probe.chainId !== ARBITRUM_ONE_CHAIN_ID ||
        !sameEvmAddress(probe.implementationAddress, delegateAddress)
      ) {
        throw new AppError(
          'UA_PROVIDER_SCHEMA_INVALID',
          'Magic probed a different delegation target.',
        );
      }
      const offset = BigInt(probe.nonce) - BigInt(auth.nonce);
      if (offset !== 0n && offset !== 1n) {
        throw new AppError(
          'UA_PROVIDER_SCHEMA_INVALID',
          'Magic and Particle nonce conventions are incompatible.',
        );
      }
      await this.#assertOwnerContinuity();
      const profile = ParticleCompatibilityProfileSchema.parse({
        schemaVersion: 1,
        profileId: `${this.config.profileId}:bootstrap`,
        stage: 'bootstrap',
        environment: this.config.environment,
        chainId: ARBITRUM_ONE_CHAIN_ID,
        particleSdkVersion: '2.0.3',
        particleProtocolVersion: UNIVERSAL_ACCOUNT_VERSION,
        particleProjectConfigDigest: digestParticleProjectConfiguration({
          projectId: this.config.projectId,
          projectClientKey: this.config.projectClientKey,
          projectAppUuid: this.config.projectAppUuid,
        }),
        useEIP7702: true,
        delegateAddress,
        delegateCodeHash: keccak256(delegateCode),
        responseDigests: {
          deployments: digestUnknown({
            account: accountRaw,
            balance: balanceRaw,
            deployments: deploymentsRaw,
          }),
          auth: digestUnknown(authRaw),
        },
        nonceConvention: {
          magicAuthorizationNonceOffset: Number(offset),
          delegationPlanTtlSeconds: this.config.delegationPlanTtlSeconds,
        },
        capturedAt: (this.config.now?.() ?? new Date()).toISOString(),
      });
      return { profile, delegateAddress };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw mapParticleError(error, 'UA_PROVIDER_SCHEMA_INVALID');
    }
  }

  async #assertOwnerContinuity(): Promise<void> {
    const owner = await this.config.magic.getOwnerAddress();
    if (!sameEvmAddress(owner, this.config.ownerAddress)) {
      throw new AppError('WALLET_ADDRESS_MISMATCH', 'The authenticated Magic owner changed.');
    }
  }

  async #getCode(address: EvmAddress): Promise<Hex> {
    const response = await this.dependencies.fetch(this.config.arbitrumRpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getCode',
        params: [address, 'latest'],
      }),
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    if (!response.ok) {
      throw new AppError('RPC_UNAVAILABLE', 'Arbitrum code verification was unavailable.', {
        retryable: true,
      });
    }
    return RpcResponseSchema.parse(await response.json()).result as Hex;
  }
}

export function createParticleOperatorCertificationAdapter(
  config: ParticleOperatorCertificationConfig,
): ParticleOperatorCertificationAdapter {
  if (typeof window === 'undefined') {
    throw new AppError('CONFIGURATION_INVALID', 'Particle operator certification is browser-only.');
  }
  assertConfigured(config);
  const sdk = new UniversalAccount({
    projectId: config.projectId,
    projectClientKey: config.projectClientKey,
    projectAppUuid: config.projectAppUuid,
    smartAccountOptions: {
      name: 'UNIVERSAL',
      version: UNIVERSAL_ACCOUNT_VERSION,
      ownerAddress: getAddress(config.ownerAddress),
      useEIP7702: true,
    },
    tradeConfig: {
      slippageBps: config.slippageBps,
      preferTokenType: PREFER_TOKEN_TYPE.USD,
      // The certification canary intentionally proves the funded Base-USDC to
      // Arbitrum-USDC route. ETH remains available for the one-time delegation
      // transaction, but must not become the canary payment or fee source.
      usePrimaryTokens: [SUPPORTED_TOKEN_TYPE.USDC],
    },
    ...(config.particleRpcUrl === undefined ? {} : { rpcUrl: config.particleRpcUrl }),
  });
  return new ParticleOperatorCertificationAdapter(config, {
    sdk: sdk as unknown as CertificationSdkLike,
    fetch: globalThis.fetch.bind(globalThis),
  });
}
