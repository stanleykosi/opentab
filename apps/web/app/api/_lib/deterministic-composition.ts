import type {
  ArbitrumReadPort,
  Eip7702AuthorizationEvidenceReadPort,
  HumanChallengeVerifierPort,
  OrderIntentSignerPort,
  UniversalOperationPort,
} from '@opentab/application';
import type { ServerEnvironment } from '@opentab/config';
import {
  createDeterministicIntentSigners,
  DeterministicMagicIdentityVerifier,
  DeterministicUniversalOperationAdapter,
} from '@opentab/integrations/server';
import {
  AppError,
  ARBITRUM_ONE_CHAIN_ID,
  BaseUnitAmountSchema,
  ChainIdSchema,
  type CurrentUser,
  EvidenceDigestSchema,
  EvmAddressSchema,
  type OrderIntent,
  type SplitReimbursementIntent,
  sameEvmAddress,
  TransactionHashSchema,
  VerifiedMagicIdentitySchema,
} from '@opentab/shared';

const LOCAL_OWNER = EvmAddressSchema.parse('0x1111111111111111111111111111111111111111');
const LOCAL_IMPLEMENTATION = EvmAddressSchema.parse('0x6666666666666666666666666666666666666666');
const LOCAL_DIGEST = `0x${'88'.repeat(32)}` as const;
const LOCAL_BLOCK_HASH = `0x${'11'.repeat(32)}` as const;
const LOCAL_PARENT_BLOCK_HASH = `0x${'00'.repeat(32)}` as const;
const LOCAL_DID_TOKEN = 'opentab-local-deterministic-did-token-v1';
const LOCAL_CHALLENGE_TOKEN = 'opentab-local-turnstile-token-v1';
const LOCAL_SOURCE_TOKEN = EvmAddressSchema.parse('0x7777777777777777777777777777777777777777');

function parseHexDigest(value: string): `0x${string}` {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new AppError('CONFIGURATION_INVALID', 'The deterministic code hash is invalid.');
  }
  return value as `0x${string}`;
}

function assertAllowed(config: ServerEnvironment): void {
  if (
    !config.DETERMINISTIC_DEMO_ENABLED ||
    config.PROVIDER_MODE !== 'deterministic' ||
    !['local', 'test', 'preview'].includes(config.APP_ENV)
  ) {
    throw new AppError(
      'CONFIGURATION_INVALID',
      'Deterministic backend composition is restricted to an explicit local/test/preview demo.',
    );
  }
}

class DeterministicArbitrumReadAdapter implements ArbitrumReadPort {
  private delegated = false;

  constructor(
    private readonly codeHash: `0x${string}`,
    private readonly platformFeeBps: string,
    private readonly ownerAddress: CurrentUser['walletAddress'],
    private readonly implementationAddress: CurrentUser['walletAddress'],
  ) {}

  async getLatestBlock() {
    return {
      number: '1',
      hash: LOCAL_BLOCK_HASH,
      parentHash: LOCAL_PARENT_BLOCK_HASH,
      timestamp: Math.floor(Date.now() / 1_000).toString(),
    };
  }

  getBlock() {
    return this.getLatestBlock();
  }
  async getLogs() {
    return [];
  }
  async getNativeBalance() {
    return '0';
  }
  async getDelegationCode(address: CurrentUser['walletAddress']) {
    if (this.delegated && sameEvmAddress(address, this.ownerAddress)) {
      return {
        accountType: 'delegated_eoa' as const,
        implementation: this.implementationAddress,
        codeHash: this.codeHash,
      };
    }
    return {
      accountType: 'eoa' as const,
      codeHash: this.codeHash,
    };
  }
  async getCodeHash() {
    return this.codeHash;
  }
  async getEip7702AuthorizationEvidence(
    input: Parameters<Eip7702AuthorizationEvidenceReadPort['getEip7702AuthorizationEvidence']>[0],
  ): ReturnType<Eip7702AuthorizationEvidenceReadPort['getEip7702AuthorizationEvidence']> {
    const transactionHash = TransactionHashSchema.safeParse(input.transactionHash);
    if (
      !transactionHash.success ||
      !sameEvmAddress(input.expectedAuthority, this.ownerAddress) ||
      !sameEvmAddress(input.expectedDelegate, this.implementationAddress)
    ) {
      throw new AppError(
        'UA_CONFIGURATION_INVALID',
        'The deterministic EIP-7702 evidence binding is invalid.',
      );
    }
    this.delegated = true;
    return {
      transactionHash: transactionHash.data,
      transactionFrom: this.ownerAddress,
      transactionType: 'eip7702',
      blockNumber: '1',
      blockHash: LOCAL_BLOCK_HASH,
      authority: this.ownerAddress,
      delegate: this.implementationAddress,
      chainId: ARBITRUM_ONE_CHAIN_ID,
      authorizationIndex: 0,
      authorizationNonce: '0',
      canonical: true,
    };
  }
  async getTransactionReceipt() {
    return {
      success: true,
      blockHash: LOCAL_BLOCK_HASH,
      blockNumber: '1',
    };
  }
  async findOrderEvent() {
    return undefined;
  }
  async readProduct() {
    return undefined;
  }
  async readPlatformFeeBps() {
    return this.platformFeeBps;
  }
  async assertDelegatedErc1155Receiver() {
    throw new AppError('UA_DELEGATION_REQUIRED', 'The deterministic account is not delegated.');
  }
}

export interface DeterministicBackendParts {
  readonly databaseUrl: string;
  readonly redisUrl: string;
  readonly secrets: Readonly<
    Record<'session' | 'csrf' | 'capability' | 'privacy' | 'judge', string>
  >;
  readonly implementationAddress: CurrentUser['walletAddress'];
  readonly implementationCodeHash: `0x${string}`;
  readonly fixtureDigest: `0x${string}`;
  readonly responseProfileId: string;
  readonly allowedSourceTokens: readonly {
    readonly chainId: '8453';
    readonly asset: 'USDC';
    readonly address: CurrentUser['walletAddress'];
  }[];
  readonly magicAuthorizationNonceOffset: 0 | 1;
  readonly delegationPlanTtlSeconds: number;
  readonly verifier: DeterministicMagicIdentityVerifier;
  readonly expectedAudience: string;
  readonly orderSigner: OrderIntentSignerPort<OrderIntent>;
  readonly orderSignerKeyId: string;
  readonly splitSigner: OrderIntentSignerPort<SplitReimbursementIntent>;
  readonly splitSignerKeyId: string;
  readonly splitSignerAddress: CurrentUser['walletAddress'];
  readonly operationsForActor: (actor: CurrentUser) => UniversalOperationPort;
  readonly chain: ArbitrumReadPort;
  readonly challengeVerifier: HumanChallengeVerifierPort;
}

export function createDeterministicBackendParts(
  config: ServerEnvironment,
): DeterministicBackendParts {
  assertAllowed(config);
  const implementationAddress =
    config.PARTICLE_EIP7702_IMPLEMENTATION_ADDRESS ?? LOCAL_IMPLEMENTATION;
  const implementationCodeHash = parseHexDigest(
    config.PARTICLE_EIP7702_IMPLEMENTATION_CODE_HASH ?? LOCAL_DIGEST,
  );
  const localEvidenceDigest = EvidenceDigestSchema.parse(LOCAL_DIGEST);
  const expectedAudience = 'opentab-local';
  const signer = createDeterministicIntentSigners({
    environment: config.APP_ENV,
    providerMode: 'deterministic',
    deterministicDemoEnabled: config.DETERMINISTIC_DEMO_ENABLED,
    orderVerifyingContract: config.NEXT_PUBLIC_CHECKOUT_ADDRESS,
    splitVerifyingContract: config.NEXT_PUBLIC_SPLIT_ADDRESS,
  });
  return {
    databaseUrl: 'postgresql://opentab:opentab@127.0.0.1:5432/opentab',
    redisUrl: 'redis://127.0.0.1:6379',
    secrets: {
      session: 'opentab-local-only-session-secret-material'.padEnd(48, 's'),
      csrf: 'opentab-local-only-csrf-secret-material'.padEnd(48, 'c'),
      capability: 'opentab-local-only-capability-secret-material'.padEnd(48, 'a'),
      privacy: 'opentab-local-only-privacy-secret-material'.padEnd(48, 'p'),
      judge: 'opentab-local-only-judge-secret-material'.padEnd(48, 'j'),
    },
    implementationAddress,
    implementationCodeHash,
    fixtureDigest: LOCAL_DIGEST,
    responseProfileId: config.PARTICLE_RESPONSE_PROFILE_ID ?? 'opentab-deterministic-v1',
    allowedSourceTokens: [{ chainId: '8453', asset: 'USDC', address: LOCAL_SOURCE_TOKEN }],
    magicAuthorizationNonceOffset: config.PARTICLE_MAGIC_AUTHORIZATION_NONCE_OFFSET ?? 0,
    delegationPlanTtlSeconds: config.PARTICLE_DELEGATION_PLAN_TTL_SECONDS ?? 300,
    verifier: new DeterministicMagicIdentityVerifier(
      config.APP_ENV,
      LOCAL_DID_TOKEN,
      VerifiedMagicIdentitySchema.parse({
        issuerHash: 'a'.repeat(64),
        walletAddress: LOCAL_OWNER,
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
        audience: expectedAudience,
        applicationId: expectedAudience,
        authMethod: 'email_otp',
        evidenceDigest: LOCAL_DIGEST,
      }),
    ),
    expectedAudience,
    orderSigner: signer.order,
    orderSignerKeyId: signer.orderSignerKeyId,
    splitSigner: signer.split,
    splitSignerKeyId: signer.splitSignerKeyId,
    splitSignerAddress: signer.splitSignerAddress,
    operationsForActor: (actor) =>
      new DeterministicUniversalOperationAdapter({
        environment: config.APP_ENV,
        ownerAddress: actor.walletAddress,
        implementationAddress,
        implementationCodeHash,
        delegated: false,
        unifiedBalance: {
          totalUsd: '25.00',
          assets: [
            {
              tokenType: 'usdc',
              amount: '25.00',
              amountUsd: '25.00',
              chains: [
                {
                  chainId: ChainIdSchema.parse('8453'),
                  tokenAddress: LOCAL_SOURCE_TOKEN,
                  symbol: 'USDC',
                  amount: '25.00',
                  amountUsd: '25.00',
                  rawAmount: BaseUnitAmountSchema.parse('25000000'),
                },
              ],
            },
          ],
          fetchedAt: new Date().toISOString(),
          evidence: {
            adapter: 'opentab-deterministic',
            packageVersion: '1.0.0',
            schemaVersion: 1,
            environment: config.APP_ENV,
            observedAt: new Date().toISOString(),
            evidenceDigest: localEvidenceDigest,
            provenance: 'deterministic',
          },
        },
      }),
    chain: new DeterministicArbitrumReadAdapter(
      implementationCodeHash,
      config.PLATFORM_FEE_BPS.toString(),
      LOCAL_OWNER,
      implementationAddress,
    ),
    challengeVerifier: {
      async verify(token) {
        if (token !== LOCAL_CHALLENGE_TOKEN) {
          throw new AppError('SPONSOR_INELIGIBLE', 'Account preparation could not be verified.');
        }
      },
    },
  };
}

export const DETERMINISTIC_BACKEND_CHAIN_ID = ARBITRUM_ONE_CHAIN_ID;
