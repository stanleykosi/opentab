import type {
  AuthMethod,
  CurrentUser,
  EvmAddress,
  ValidatedOperationPlan,
  VerifiedDelegationPlan,
  VerifiedMagicIdentity,
} from '@opentab/shared';

export interface MagicIdentityVerifierPort {
  verifyDidToken(input: {
    didToken: string;
    expectedAudience: string;
    expectedApplicationId: string;
  }): Promise<VerifiedMagicIdentity>;
}

export interface AuthContinuationServicePort {
  issue(input: { returnPath: string }): Promise<{
    continuationId: string;
    verifierToken: string;
    expiresAt: string;
  }>;
  consume(input: { continuationId: string; verifierToken: string }): Promise<{
    returnPath: string;
  }>;
}

export interface MagicWalletPort {
  loginWithGoogle(input: { redirectUri: string; continuationId: string }): Promise<void>;
  completeGoogleRedirect(): Promise<{
    didToken: string;
    authMethod: Extract<AuthMethod, 'google'>;
  }>;
  loginWithEmailOtp(input: {
    email: string;
  }): Promise<{ didToken: string; authMethod: Extract<AuthMethod, 'email_otp'> }>;
  /** Requests a short-lived proof for an already authenticated Magic user. */
  getFreshIdentityProof?(): Promise<{ didToken: string }>;
  getOwnerAddress(): Promise<EvmAddress>;
  /** Returns the authenticated EOA's native Arbitrum balance in wei. */
  getNativeBalanceWei(): Promise<string>;
  getChainId(): Promise<string>;
  switchToArbitrum(): Promise<void>;
  authorizeDelegation(plan: VerifiedDelegationPlan): Promise<{ authorization: unknown }>;
  submitDelegation(
    plan: VerifiedDelegationPlan,
    authorization: { authorization: unknown },
  ): Promise<{ transactionHash: string; submissionPossible: boolean }>;
  signValidatedRoot(
    plan: ValidatedOperationPlan,
  ): Promise<{ signature: string; recoveredOwner: EvmAddress }>;
  logout(): Promise<void>;
}

export interface SessionServicePort {
  create(identity: VerifiedMagicIdentity): Promise<{
    user: CurrentUser;
    plaintextToken: string;
    csrfToken: string;
    expiresAt: string;
  }>;
  verify(plaintextToken: string): Promise<CurrentUser>;
  refresh(plaintextToken: string): Promise<{
    user: CurrentUser;
    plaintextToken: string;
    csrfToken: string;
    expiresAt: string;
  }>;
  revoke(plaintextToken: string): Promise<void>;
}

export interface CsrfSessionServicePort extends SessionServicePort {
  verifyCsrf(plaintextToken: string, csrfToken: string): Promise<CurrentUser>;
}
