import type {
  CheckoutSessionId,
  CurrentUser,
  Merchant,
  MerchantId,
  OrderId,
  OrderKey,
  PaymentAttemptId,
  PaymentAttemptStatus,
  Product,
  ProductId,
  ProviderOperationId,
  PublicJudgeProof,
  Split,
  SplitId,
} from '@opentab/shared';

export interface IdempotencyResult<T> {
  state: 'created' | 'replayed';
  value: T;
}

export interface UnitOfWorkPort {
  transaction<T>(operation: () => Promise<T>): Promise<T>;
}

export interface UserRepositoryPort {
  findCurrentUserById(id: string): Promise<CurrentUser | undefined>;
}

export interface MerchantRepositoryPort {
  findById(id: MerchantId): Promise<Merchant | undefined>;
  save(merchant: Merchant): Promise<void>;
}

export interface ProductRepositoryPort {
  findById(id: ProductId): Promise<Product | undefined>;
  save(product: Product): Promise<void>;
}

export interface CheckoutRepositoryPort {
  findSession(id: CheckoutSessionId): Promise<unknown | undefined>;
  findOrderById(id: OrderId): Promise<unknown | undefined>;
  findOrderByKey(key: OrderKey): Promise<unknown | undefined>;
  transitionAttempt(input: {
    attemptId: PaymentAttemptId;
    expected: readonly PaymentAttemptStatus[];
    next: PaymentAttemptStatus;
    providerOperationId?: ProviderOperationId;
  }): Promise<boolean>;
}

export interface SplitRepositoryPort {
  findById(id: SplitId): Promise<Split | undefined>;
  save(split: Split): Promise<void>;
}

export interface JudgeEvidenceRepositoryPort {
  getPublicProof(orderId: OrderId, shareToken?: string): Promise<PublicJudgeProof | undefined>;
}

export interface IdempotencyRepositoryPort {
  execute<T>(input: {
    scope: string;
    keyHash: string;
    requestHash: string;
    expiresAt: Date;
    operation: () => Promise<T>;
  }): Promise<IdempotencyResult<T>>;
}
