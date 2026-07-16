import type {
  ArbitrumReadPort,
  BackendApiQueryPort,
  BackendApiResourceQueryPort,
  PublicBrowserConfig,
  UniversalOperationPort,
} from '@opentab/application';
import type { PostgresBackendApiStore } from '@opentab/db';
import { AppError, type CurrentUser, sameEvmAddress } from '@opentab/shared';

interface DependencyCheck {
  readonly database: () => Promise<void>;
  readonly redis: () => Promise<void>;
}

export class LiveBackendApiResourceQueries implements BackendApiResourceQueryPort {
  constructor(
    private readonly dependencies: {
      readonly config: PublicBrowserConfig;
      readonly queries: BackendApiQueryPort;
      readonly backend: PostgresBackendApiStore;
      readonly operationsForActor?: (actor: CurrentUser) => UniversalOperationPort;
      readonly chain: ArbitrumReadPort;
      readonly checks: DependencyCheck;
    },
  ) {}

  getPublicConfig() {
    return Promise.resolve(this.dependencies.config);
  }

  async getMerchantProfile(actor: CurrentUser) {
    return this.dependencies.backend.getMerchantProfile(actor);
  }

  getMerchantMembership(actor: CurrentUser) {
    return Promise.resolve({ memberships: actor.merchantMemberships });
  }

  async getCheckoutLink(reference: string, _actor?: CurrentUser) {
    const link = await this.dependencies.backend.getCheckoutLink(reference);
    if (link === undefined) return undefined;
    const product = await this.dependencies.queries.getPublicProductById(link.productId);
    return product === undefined
      ? undefined
      : { link, product: product.product, merchant: product.merchant };
  }

  async getWalletReadiness(actor: CurrentUser) {
    const operations = this.dependencies.operationsForActor?.(actor);
    if (operations === undefined) {
      throw new AppError('CONFIGURATION_INVALID', 'Wallet readiness adapter is not configured.');
    }
    const [account, delegation, onchainDelegation] = await Promise.all([
      operations.getAccount(),
      operations.getDelegation(),
      this.dependencies.chain.getDelegationCode(actor.walletAddress),
    ]);
    const expectedImplementation = this.dependencies.config.particle
      .expectedImplementationAddress as CurrentUser['walletAddress'];
    const expectedImplementationCodeHash =
      this.dependencies.config.particle.expectedImplementationCodeHash.toLowerCase();
    const onchainImplementation =
      onchainDelegation.accountType === 'delegated_eoa'
        ? onchainDelegation.implementation
        : undefined;
    const implementationCodeHash =
      onchainImplementation !== undefined && this.dependencies.chain.getCodeHash !== undefined
        ? await this.dependencies.chain.getCodeHash(onchainImplementation)
        : undefined;
    const ownerMatches = sameEvmAddress(account.ownerAddress, actor.walletAddress);
    const blockers: Array<
      | 'owner_mismatch'
      | 'delegation_required'
      | 'delegation_target_mismatch'
      | 'balance_unavailable'
    > = [];
    if (!ownerMatches) blockers.push('owner_mismatch');
    const providerDelegated = delegation.delegated;
    const onchainDelegated = onchainImplementation !== undefined;
    if (!providerDelegated || !onchainDelegated) blockers.push('delegation_required');
    if (
      (providerDelegated &&
        (delegation.implementationAddress === undefined ||
          !sameEvmAddress(delegation.implementationAddress, expectedImplementation) ||
          delegation.implementationCodeHash?.toLowerCase() !== expectedImplementationCodeHash)) ||
      (onchainDelegated &&
        (!sameEvmAddress(onchainImplementation, expectedImplementation) ||
          implementationCodeHash?.toLowerCase() !== expectedImplementationCodeHash))
    ) {
      blockers.push('delegation_target_mismatch');
    }
    return {
      ownerAddress: account.ownerAddress,
      universalAccountAddress: account.evmAddress,
      ownerMatches,
      delegation,
      ready: blockers.length === 0,
      blockers,
      observedAt: new Date().toISOString(),
    };
  }

  async getWalletBalance(actor: CurrentUser) {
    const operations = this.dependencies.operationsForActor?.(actor);
    if (operations === undefined) {
      throw new AppError('CONFIGURATION_INVALID', 'Wallet balance adapter is not configured.');
    }
    return { balance: await operations.getUnifiedBalance() };
  }

  getPaymentRecovery(paymentAttemptId: string, actor: CurrentUser) {
    return this.dependencies.queries.getPaymentWorkflowForActor(paymentAttemptId, actor);
  }

  getReceipt(
    orderId: Parameters<BackendApiResourceQueryPort['getReceipt']>[0],
    actor: CurrentUser,
  ) {
    return this.dependencies.queries.getOrderForActor(orderId, actor);
  }

  getRefund(refundId: string, actor: CurrentUser) {
    return this.dependencies.backend.getRefund(refundId, actor);
  }

  getSettlement(actor: CurrentUser) {
    return this.dependencies.backend.getSettlement(actor);
  }

  getWithdrawal(withdrawalId: string, actor: CurrentUser) {
    return this.dependencies.backend.getWithdrawal(withdrawalId, actor);
  }

  getLoyaltyStatus(actor: CurrentUser) {
    return this.dependencies.backend.getLoyaltyStatus(actor);
  }

  getSplitPayment(splitPaymentAttemptId: string, actor: CurrentUser) {
    return this.dependencies.backend.getSplitPayment(splitPaymentAttemptId, actor);
  }

  getContractOperation(operationId: string, actor: CurrentUser) {
    return this.dependencies.backend.getContractOperation(operationId, actor);
  }

  async getHealth() {
    return { service: 'opentab-web', status: 'live', timestamp: new Date().toISOString() };
  }

  async getReadiness() {
    const checks = await Promise.allSettled([
      this.dependencies.checks.database(),
      this.dependencies.checks.redis(),
    ]);
    const database = checks[0]?.status === 'fulfilled' ? 'ready' : 'unavailable';
    const redis = checks[1]?.status === 'fulfilled' ? 'ready' : 'unavailable';
    if (database !== 'ready' || redis !== 'ready') {
      throw new AppError('CONFIGURATION_INVALID', 'Backend dependencies are not ready.', {
        retryable: true,
        safeDetails: { database, redis },
      });
    }
    return {
      status: 'ready',
      dependencies: { database, redis },
      timestamp: new Date().toISOString(),
    };
  }
}
