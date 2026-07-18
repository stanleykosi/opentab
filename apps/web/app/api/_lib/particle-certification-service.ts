import { createHash, timingSafeEqual } from 'node:crypto';
import type {
  ArbitrumReadPort,
  BackendApiQueryPort,
  CheckoutWorkflowStorePort,
} from '@opentab/application';
import {
  certifyParticleCompatibilityProfile,
  type LoadedParticleCompatibilityProfile,
  loadParticleCertificationProviderOperation,
  loadParticleCompatibilityProfileForRelease,
  type OpenTabDatabase,
} from '@opentab/db';
import {
  AppError,
  ARBITRUM_ONE_CHAIN_ID,
  type CurrentUser,
  digestParticleCompatibilityProfile,
  digestParticleProjectConfiguration,
  digestUnknown,
  EvidenceDigestSchema,
  ParticleCompatibilityProfileSchema,
  type ParticleProfileReleaseBinding,
  PaymentAttemptIdSchema,
  ProductIdSchema,
  sameEvmAddress,
} from '@opentab/shared';
import type { ParticleCertificationService } from './registry.js';

const MAX_CANARY_BASE_UNITS = 1_000_000n;

export interface ParticleCertificationRuntimeConfig {
  readonly environment: 'demo-mainnet' | 'production';
  readonly profileScopeId: string;
  readonly particleLiveEnabled: boolean;
  readonly paymentsEnabled: boolean;
  readonly projectId: string;
  readonly projectClientKey: string;
  readonly projectAppUuid: string;
  readonly particleRpcUrl?: string;
  readonly arbitrumRpcUrl: string;
  readonly checkoutAddress: string;
  readonly passAddress: string;
  readonly tokenAddress: string;
  readonly maximumSlippageBps: number;
  readonly maximumFeeUsdMicros: string;
  readonly delegationPlanTtlSeconds: number;
  readonly allowedSourceChainIds: readonly string[];
  readonly allowedSourceAssets: readonly ('USDC' | 'USDT' | 'ETH')[];
  readonly allowedSourceTokens: readonly {
    readonly chainId: string;
    readonly asset: 'USDC' | 'USDT' | 'ETH';
    readonly address: string;
  }[];
}

interface Dependencies {
  readonly db: OpenTabDatabase;
  readonly workflow: CheckoutWorkflowStorePort;
  readonly queries: BackendApiQueryPort;
  readonly chain: ArbitrumReadPort;
  readonly operatorToken: string;
  readonly subjectHash: (actor: CurrentUser) => string;
  readonly config: ParticleCertificationRuntimeConfig;
  readonly reloadRuntime: () => Promise<void>;
}

function constantTimeTokenMatches(expected: string, received: string): boolean {
  const expectedDigest = createHash('sha256').update(expected).digest();
  const receivedDigest = createHash('sha256').update(received).digest();
  return timingSafeEqual(expectedDigest, receivedDigest);
}

function assertOperatorToken(expected: string, received: string): void {
  if (!constantTimeTokenMatches(expected, received)) {
    throw new AppError('AUTH_FORBIDDEN', 'Operator certification authorization was rejected.');
  }
}

function stageRank(stage: ParticleProfileReleaseBinding['stage']): number {
  return stage === 'bootstrap' ? 1 : stage === 'canary_ready' ? 2 : 3;
}

function safeStatus(
  config: ParticleCertificationRuntimeConfig,
  loaded: LoadedParticleCompatibilityProfile | undefined,
  subjectMatches: boolean,
) {
  return {
    environment: config.environment,
    profileScopeId: config.profileScopeId,
    chainId: ARBITRUM_ONE_CHAIN_ID,
    captureConfig: {
      projectId: config.projectId,
      projectClientKey: config.projectClientKey,
      projectAppUuid: config.projectAppUuid,
      ...(config.particleRpcUrl === undefined ? {} : { particleRpcUrl: config.particleRpcUrl }),
      arbitrumRpcUrl: config.arbitrumRpcUrl,
      checkoutAddress: config.checkoutAddress,
      passAddress: config.passAddress,
      tokenAddress: config.tokenAddress,
      maximumSlippageBps: config.maximumSlippageBps,
      maximumFeeUsdMicros: config.maximumFeeUsdMicros,
      delegationPlanTtlSeconds: config.delegationPlanTtlSeconds,
      allowedSourceChainIds: config.allowedSourceChainIds,
      allowedSourceAssets: config.allowedSourceAssets,
      allowedSourceTokens: config.allowedSourceTokens,
      useEIP7702: true as const,
    },
    certification:
      loaded === undefined
        ? { stage: 'uncertified' as const, subjectMatches: false }
        : {
            stage: loaded.profile.stage,
            profileId: loaded.profile.profileId,
            profileDigest: loaded.binding.profileDigest,
            subjectMatches,
            canaryProductId: loaded.binding.canaryProductId,
            canaryMaxBaseUnits: loaded.binding.canaryMaxBaseUnits,
            boundAt: loaded.binding.boundAt,
          },
    effectiveCapabilities: {
      captureBootstrap: loaded === undefined,
      captureCanaryPreview:
        loaded?.profile.stage === 'bootstrap' && subjectMatches && config.paymentsEnabled,
      runCanary:
        loaded?.profile.stage === 'canary_ready' &&
        subjectMatches &&
        config.particleLiveEnabled &&
        config.paymentsEnabled,
      payments:
        loaded?.profile.stage === 'certified' &&
        config.particleLiveEnabled &&
        config.paymentsEnabled,
    },
  };
}

export class LiveParticleCertificationService implements ParticleCertificationService {
  constructor(private readonly dependencies: Dependencies) {}

  async #load(): Promise<LoadedParticleCompatibilityProfile | undefined> {
    const { config } = this.dependencies;
    return loadParticleCompatibilityProfileForRelease(this.dependencies.db, {
      environment: config.environment,
      applicationReleaseId: config.profileScopeId,
      chainId: ARBITRUM_ONE_CHAIN_ID,
    });
  }

  #subject(actor: CurrentUser) {
    return EvidenceDigestSchema.parse(this.dependencies.subjectHash(actor));
  }

  async #assertProfileIntegrity(profileInput: unknown) {
    const profile = ParticleCompatibilityProfileSchema.parse(profileInput);
    const { config, chain } = this.dependencies;
    if (
      profile.environment !== config.environment ||
      profile.chainId !== ARBITRUM_ONE_CHAIN_ID ||
      profile.particleProjectConfigDigest.toLowerCase() !==
        digestParticleProjectConfiguration({
          projectId: config.projectId,
          projectClientKey: config.projectClientKey,
          projectAppUuid: config.projectAppUuid,
        }).toLowerCase()
    ) {
      throw new AppError(
        'UA_CONFIGURATION_INVALID',
        'The captured Particle profile does not belong to this Particle project scope.',
      );
    }
    if (chain.getCodeHash === undefined) {
      throw new AppError(
        'CONFIGURATION_INVALID',
        'The certification runtime cannot independently verify delegate bytecode.',
      );
    }
    const observedCodeHash = await chain.getCodeHash(profile.delegateAddress);
    if (observedCodeHash.toLowerCase() !== profile.delegateCodeHash.toLowerCase()) {
      throw new AppError(
        'UA_CONFIGURATION_INVALID',
        'The Particle delegate bytecode does not match the captured profile.',
      );
    }
    return profile;
  }

  async getStatus(input: { readonly actor: CurrentUser; readonly operatorToken?: string }) {
    if (input.operatorToken !== undefined) {
      assertOperatorToken(this.dependencies.operatorToken, input.operatorToken);
    }
    const loaded = await this.#load();
    const subjectMatches =
      loaded !== undefined && loaded.binding.certifiedSubjectHash === this.#subject(input.actor);
    const status = safeStatus(this.dependencies.config, loaded, subjectMatches);
    if (input.operatorToken !== undefined) return status;
    const { captureConfig: _captureConfig, ...publicSafe } = status;
    return publicSafe;
  }

  async certify(input: {
    readonly actor: CurrentUser;
    readonly operatorToken: string;
    readonly profile: unknown;
    readonly productId: string;
  }) {
    assertOperatorToken(this.dependencies.operatorToken, input.operatorToken);
    const profile = await this.#assertProfileIntegrity(input.profile);
    if (profile.stage === 'certified') {
      throw new AppError(
        'VALIDATION_FAILED',
        'Certified status can only be produced from indexed canary evidence.',
      );
    }

    const productId = ProductIdSchema.parse(input.productId);
    const authoritative = await this.dependencies.workflow.findAuthoritativeProduct(productId);
    if (authoritative === undefined || !authoritative.active) {
      throw new AppError('PRODUCT_UNAVAILABLE', 'The canary product is not active onchain.');
    }
    const canaryAmount = BigInt(authoritative.product.unitPriceBaseUnits);
    if (canaryAmount < 1n || canaryAmount > MAX_CANARY_BASE_UNITS) {
      throw new AppError('VALIDATION_FAILED', 'The canary product must cost no more than 1 USDC.');
    }

    const subject = this.#subject(input.actor);
    const current = await this.#load();
    if (current !== undefined) {
      if (
        current.binding.certifiedSubjectHash !== subject ||
        current.binding.canaryProductId !== authoritative.productOnchainId ||
        current.binding.canaryMaxBaseUnits !== authoritative.product.unitPriceBaseUnits
      ) {
        throw new AppError(
          'AUTH_FORBIDDEN',
          'This Particle profile is already bound to another operator or canary product.',
        );
      }
      if (stageRank(profile.stage) < stageRank(current.profile.stage)) {
        throw new AppError('IDEMPOTENCY_CONFLICT', 'Particle certification cannot be downgraded.');
      }
      if (
        profile.stage === current.profile.stage &&
        digestParticleCompatibilityProfile(profile).toLowerCase() !==
          digestParticleCompatibilityProfile(current.profile).toLowerCase()
      ) {
        throw new AppError(
          'IDEMPOTENCY_CONFLICT',
          'This immutable certification stage already has different evidence.',
        );
      }
      if (profile.stage === current.profile.stage) {
        return safeStatus(this.dependencies.config, current, true);
      }
    } else if (profile.stage !== 'bootstrap') {
      throw new AppError(
        'UA_CONFIGURATION_INVALID',
        'Capture bootstrap compatibility before preparing a canary preview.',
      );
    }

    const loaded = await certifyParticleCompatibilityProfile(this.dependencies.db, {
      profile,
      applicationReleaseId: this.dependencies.config.profileScopeId,
      certifiedSubjectHash: subject,
      canaryProductId: authoritative.productOnchainId,
      canaryMaxBaseUnits: authoritative.product.unitPriceBaseUnits,
    });
    await this.dependencies.reloadRuntime();
    return safeStatus(this.dependencies.config, loaded, true);
  }

  async finalize(input: {
    readonly actor: CurrentUser;
    readonly operatorToken: string;
    readonly paymentAttemptId: string;
    readonly submissionEvidenceDigest: string;
    readonly statusEvidenceDigest: string;
  }) {
    assertOperatorToken(this.dependencies.operatorToken, input.operatorToken);
    const paymentAttemptId = PaymentAttemptIdSchema.parse(input.paymentAttemptId);
    const submissionEvidenceDigest = EvidenceDigestSchema.parse(input.submissionEvidenceDigest);
    const statusEvidenceDigest = EvidenceDigestSchema.parse(input.statusEvidenceDigest);
    const current = await this.#load();
    if (current === undefined || current.profile.stage !== 'canary_ready') {
      throw new AppError(
        'UA_CONFIGURATION_INVALID',
        'This Particle profile is not waiting for a canonical canary payment.',
      );
    }
    const subject = this.#subject(input.actor);
    if (current.binding.certifiedSubjectHash !== subject) {
      throw new AppError('AUTH_FORBIDDEN', 'Only the bound canary operator can certify payment.');
    }

    const workflow = await this.dependencies.queries.getPaymentWorkflowForActor(
      paymentAttemptId,
      input.actor,
    );
    if (workflow === undefined) {
      throw new AppError('NOT_FOUND', 'The canary payment attempt was not found.');
    }
    const order = await this.dependencies.queries.getOrderForActor(workflow.order.id, input.actor);
    const canonical = workflow.canonicalOrderPaid;
    if (
      order === undefined ||
      order.product.onchainProductId !== current.binding.canaryProductId ||
      BigInt(workflow.order.amountBaseUnits) > BigInt(current.binding.canaryMaxBaseUnits) ||
      workflow.order.userId !== input.actor.id ||
      workflow.order.status !== 'paid' ||
      workflow.receipt?.status !== 'issued' ||
      canonical === undefined ||
      BigInt(canonical.confirmations) < BigInt(canonical.requiredConfirmations) ||
      workflow.order.transactionHash === undefined ||
      !sameEvmAddress(workflow.order.payer, input.actor.walletAddress) ||
      workflow.order.transactionHash.toLowerCase() !== canonical.transactionHash.toLowerCase()
    ) {
      throw new AppError(
        'PAYMENT_NOT_CANONICAL',
        'The indexed canary has not met every payment and receipt invariant.',
      );
    }

    const provider = await loadParticleCertificationProviderOperation(this.dependencies.db, {
      paymentAttemptId,
    });
    if (
      provider === undefined ||
      provider.status !== 'succeeded' ||
      workflow.attempt.providerOperationId !== provider.externalId ||
      provider.evidenceDigest.toLowerCase() !== statusEvidenceDigest.toLowerCase()
    ) {
      throw new AppError(
        'UA_STATUS_UNKNOWN',
        'The reconciled Particle operation does not match the canary evidence.',
      );
    }

    const acceptanceEvidenceDigest = EvidenceDigestSchema.parse(
      digestUnknown({
        domain: 'opentab/particle-certification-canary-acceptance',
        environment: this.dependencies.config.environment,
        profileScopeId: this.dependencies.config.profileScopeId,
        priorProfileDigest: current.binding.profileDigest,
        certifiedSubjectHash: subject,
        paymentAttemptId,
        providerOperation: provider,
        order: {
          id: workflow.order.id,
          orderKey: workflow.order.orderKey,
          productId: current.binding.canaryProductId,
          amountBaseUnits: workflow.order.amountBaseUnits,
          transactionHash: workflow.order.transactionHash,
        },
        canonical,
        receipt: workflow.receipt,
      }),
    );
    const certifiedProfile = ParticleCompatibilityProfileSchema.parse({
      ...current.profile,
      profileId: `cert-${this.dependencies.config.profileScopeId.slice(0, 12)}-${acceptanceEvidenceDigest.slice(2, 18)}`,
      stage: 'certified',
      responseDigests: {
        ...current.profile.responseDigests,
        submission: submissionEvidenceDigest,
        status: statusEvidenceDigest,
      },
      canonicalCanaryEvidence: {
        paymentAttemptId,
        orderKey: workflow.order.orderKey,
        transactionHash: canonical.transactionHash,
        blockHash: canonical.blockHash,
        acceptanceEvidenceDigest,
      },
      capturedAt: new Date().toISOString(),
    });
    await this.#assertProfileIntegrity(certifiedProfile);
    const loaded = await certifyParticleCompatibilityProfile(this.dependencies.db, {
      profile: certifiedProfile,
      applicationReleaseId: this.dependencies.config.profileScopeId,
      certifiedSubjectHash: subject,
      canaryProductId: current.binding.canaryProductId,
      canaryMaxBaseUnits: current.binding.canaryMaxBaseUnits,
    });
    await this.dependencies.reloadRuntime();
    return safeStatus(this.dependencies.config, loaded, true);
  }
}
