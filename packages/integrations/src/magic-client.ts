import type { MagicWalletPort } from '@opentab/application';
import {
  AppError,
  ARBITRUM_ONE_CHAIN_ID,
  type BoundOperationTemplate,
  BoundOperationTemplateSchema,
  type EvmAddress,
  EvmAddressSchema,
  sameEvmAddress,
  type TransactionHash,
  TransactionHashSchema,
  type ValidatedOperationPlan,
  ValidatedOperationPlanSchema,
  type VerifiedDelegationPlan,
  VerifiedDelegationPlanSchema,
} from '@opentab/shared';
import { BrowserProvider, getBytes, Signature, verifyMessage } from 'ethers';
import { getAbiItem, toFunctionSelector } from 'viem';
import { z } from 'zod';
import { openTabCheckoutOperationAbi } from './generated/operation-abis.js';
import { mapMagicError } from './vendor-errors.js';

const ARBITRUM_CHAIN_NUMBER = Number(ARBITRUM_ONE_CHAIN_ID);
const ZERO_ADDRESS = EvmAddressSchema.parse('0x0000000000000000000000000000000000000000');

export const MagicOperatorBootstrapActionSchema = z.enum([
  'create_merchant',
  'create_product',
  'set_product_active',
]);

export type MagicOperatorBootstrapAction = z.infer<typeof MagicOperatorBootstrapActionSchema>;

const OPERATOR_BOOTSTRAP_SELECTORS = {
  create_merchant: toFunctionSelector(
    getAbiItem({ abi: openTabCheckoutOperationAbi, name: 'createMerchant' }),
  ),
  create_product: toFunctionSelector(
    getAbiItem({ abi: openTabCheckoutOperationAbi, name: 'createProduct' }),
  ),
  set_product_active: toFunctionSelector(
    getAbiItem({ abi: openTabCheckoutOperationAbi, name: 'setProductActive' }),
  ),
} satisfies Record<MagicOperatorBootstrapAction, `0x${string}`>;

const MagicUserMetadataSchema = z.object({
  issuer: z.string().nullable(),
  email: z.string().nullable(),
  phoneNumber: z.string().nullable(),
  isMfaEnabled: z.boolean(),
  recoveryFactors: z.array(z.unknown()),
  firstLoginAt: z.string().nullable(),
  wallets: z.record(
    z.string(),
    z
      .object({
        publicAddress: z.string().nullable(),
        subAccounts: z.array(z.object({ name: z.string(), publicAddress: z.string() })),
      })
      .optional(),
  ),
});

const OAuthResultSchema = z.object({
  oauth: z.object({ provider: z.literal('google') }).passthrough(),
  magic: z.object({
    idToken: z.string().min(16).max(16_384),
    userMetadata: MagicUserMetadataSchema,
  }),
});

const SignedAuthorizationSchema = z.object({
  contractAddress: EvmAddressSchema,
  chainId: z.number().int().positive(),
  nonce: z.number().int().nonnegative().safe(),
  v: z.number().int(),
  r: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  s: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  signature: z
    .string()
    .regex(/^0x[0-9a-fA-F]+$/)
    .optional(),
});

const Type4ResponseSchema = z.object({
  transactionHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
});

const ChainIdHexSchema = z.string().regex(/^0x[0-9a-fA-F]+$/);
const AccountListSchema = z.array(EvmAddressSchema).min(1);

interface MagicRpcProviderLike {
  request(input: { method: string; params?: readonly unknown[] }): Promise<unknown>;
}

interface MagicBrowserLike {
  readonly auth: {
    loginWithEmailOTP(input: { email: string; showUI: boolean }): Promise<unknown>;
  };
  readonly user: {
    getIdToken(input?: { lifespan?: number }): Promise<unknown>;
    getInfo(): Promise<unknown>;
    logout(): Promise<unknown>;
  };
  readonly wallet: {
    sign7702Authorization(input: {
      contractAddress: string;
      chainId: number;
      nonce?: number;
    }): Promise<unknown>;
    send7702Transaction(input: {
      to: string;
      value?: string;
      data?: string;
      authorizationList: readonly unknown[];
    }): Promise<unknown>;
  };
  readonly oauth2: {
    loginWithRedirect(input: {
      provider: 'google';
      redirectURI: string;
      scope?: string[];
      customData?: string;
    }): Promise<unknown>;
    getRedirectResult(): Promise<unknown>;
  };
  readonly evm: {
    switchChain(chainId: number): Promise<unknown>;
  };
  readonly rpcProvider: MagicRpcProviderLike;
}

export interface MagicBrowserConfig {
  readonly publishableKey: string;
  readonly environment: string;
  readonly allowedRedirectUris: readonly string[];
  readonly rpcNetworks: readonly {
    chainId: number;
    rpcUrl: string;
    default?: boolean;
  }[];
}

type MagicLoader = (config: MagicBrowserConfig) => Promise<MagicBrowserLike>;

function assertBrowser(): void {
  if (typeof window === 'undefined') {
    throw new AppError(
      'CONFIGURATION_INVALID',
      'Magic client can only be initialized in a browser.',
    );
  }
}

function assertConfigured(config: MagicBrowserConfig): void {
  if (!config.publishableKey || /REPLACE|EXAMPLE|CHANGE_ME/i.test(config.publishableKey)) {
    throw new AppError('CONFIGURATION_INVALID', 'A real Magic publishable key is required.');
  }
  if (config.allowedRedirectUris.length === 0 || config.rpcNetworks.length === 0) {
    throw new AppError(
      'CONFIGURATION_INVALID',
      'Magic redirect and network allowlists are required.',
    );
  }
  if (!config.rpcNetworks.some((entry) => entry.chainId === ARBITRUM_CHAIN_NUMBER)) {
    throw new AppError('CONFIGURATION_INVALID', 'Magic must configure Arbitrum One.');
  }
  for (const redirect of config.allowedRedirectUris) {
    let url: URL;
    try {
      url = new URL(redirect);
    } catch (error) {
      throw new AppError('CONFIGURATION_INVALID', 'Magic redirect URL is invalid.', {
        cause: error,
      });
    }
    const local = ['local', 'test'].includes(config.environment);
    if (
      (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
      url.username ||
      url.password ||
      url.hash
    ) {
      throw new AppError('CONFIGURATION_INVALID', 'Magic redirect URLs are not safe.');
    }
  }
  for (const entry of config.rpcNetworks) {
    let url: URL;
    try {
      url = new URL(entry.rpcUrl);
    } catch (error) {
      throw new AppError('CONFIGURATION_INVALID', 'Magic RPC URL is invalid.', { cause: error });
    }
    const local = ['local', 'test'].includes(config.environment);
    if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
      throw new AppError('CONFIGURATION_INVALID', 'Magic RPC URLs must use HTTPS.');
    }
    if (url.username || url.password) {
      throw new AppError('CONFIGURATION_INVALID', 'Magic RPC credentials cannot be URL-embedded.');
    }
  }
}

async function loadMagic(config: MagicBrowserConfig): Promise<MagicBrowserLike> {
  assertBrowser();
  const [{ Magic }, { EVMExtension }, { OAuthExtension }] = await Promise.all([
    import('magic-sdk'),
    import('@magic-ext/evm'),
    import('@magic-ext/oauth2'),
  ]);
  const instance = new Magic(config.publishableKey, {
    deferPreload: true,
    extensions: [
      new EVMExtension(
        config.rpcNetworks.map((entry) => ({
          chainId: entry.chainId,
          rpcUrl: entry.rpcUrl,
          ...(entry.default === undefined ? {} : { default: entry.default }),
        })),
      ),
      new OAuthExtension(),
    ],
  });
  // The cast is deliberately isolated at the SDK edge. Every value used by
  // the adapter is runtime-validated before it crosses the port.
  return instance as unknown as MagicBrowserLike;
}

let singleton: { fingerprint: string; promise: Promise<MagicBrowserLike> } | undefined;

function configFingerprint(config: MagicBrowserConfig): string {
  return JSON.stringify({
    key: config.publishableKey,
    environment: config.environment,
    redirects: [...config.allowedRedirectUris].sort(),
    networks: [...config.rpcNetworks]
      .map((entry) => ({ chainId: entry.chainId, rpcUrl: entry.rpcUrl, default: entry.default }))
      .sort((left, right) => left.chainId - right.chainId),
  });
}

async function getMagicSingleton(config: MagicBrowserConfig): Promise<MagicBrowserLike> {
  assertBrowser();
  assertConfigured(config);
  const fingerprint = configFingerprint(config);
  if (singleton !== undefined && singleton.fingerprint !== fingerprint) {
    throw new AppError(
      'CONFIGURATION_INVALID',
      'Magic was already initialized for another context.',
    );
  }
  singleton ??= { fingerprint, promise: loadMagic(config) };
  return singleton.promise;
}

function assertAllowedRedirect(value: string, allowlist: readonly string[]): string {
  let normalized: string;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash)
      throw new Error('URL credentials/fragments forbidden');
    normalized = url.toString();
  } catch (error) {
    throw new AppError('AUTH_STATE_MISMATCH', 'The authentication return URL is invalid.', {
      cause: error,
    });
  }
  const allowed = allowlist.some((entry) => {
    try {
      return new URL(entry).toString() === normalized;
    } catch {
      return false;
    }
  });
  if (!allowed)
    throw new AppError('AUTH_STATE_MISMATCH', 'The authentication return URL is not allowed.');
  return normalized;
}

function assertUnexpired(expiresAt: string): void {
  const expiry = new Date(expiresAt).getTime();
  if (!Number.isFinite(expiry) || expiry <= Date.now()) {
    throw new AppError('UA_QUOTE_EXPIRED', 'The prepared action has expired.');
  }
}

function safeNonce(value: string): number {
  const nonce = BigInt(value);
  if (nonce > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new AppError(
      'OPERATION_PLAN_INVALID',
      'The delegation nonce cannot be represented safely.',
    );
  }
  return Number(nonce);
}

function ethereumMetadataAddress(metadata: z.infer<typeof MagicUserMetadataSchema>): EvmAddress {
  const value = metadata.wallets.ethereum?.publicAddress;
  if (value === null || value === undefined) {
    throw new AppError(
      'WALLET_ADDRESS_MISMATCH',
      'Magic did not return an Ethereum wallet address.',
    );
  }
  return EvmAddressSchema.parse(value);
}

export function serializeMagicAuthorization(authorization: unknown): `0x${string}` {
  const parsed = SignedAuthorizationSchema.parse(authorization);
  return (parsed.signature ??
    Signature.from({ r: parsed.r, s: parsed.s, v: parsed.v }).serialized) as `0x${string}`;
}

export class MagicBrowserWalletAdapter implements MagicWalletPort {
  constructor(
    private readonly config: MagicBrowserConfig,
    private readonly loader: MagicLoader = getMagicSingleton,
  ) {
    assertConfigured(config);
  }

  async loginWithGoogle(input: { redirectUri: string; continuationId: string }): Promise<void> {
    if (!/^[A-Za-z0-9_-]{8,160}$/.test(input.continuationId)) {
      throw new AppError('AUTH_STATE_MISMATCH', 'The authentication continuation is invalid.');
    }
    const redirectURI = assertAllowedRedirect(input.redirectUri, this.config.allowedRedirectUris);
    try {
      const magic = await this.loader(this.config);
      await magic.oauth2.loginWithRedirect({
        provider: 'google',
        redirectURI,
        scope: ['openid', 'email'],
        customData: input.continuationId,
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw mapMagicError(error, 'AUTH_PROVIDER_UNAVAILABLE');
    }
  }

  async completeGoogleRedirect() {
    try {
      const magic = await this.loader(this.config);
      const result = OAuthResultSchema.parse(await magic.oauth2.getRedirectResult());
      const resultAddress = ethereumMetadataAddress(result.magic.userMetadata);
      const ownerAddress = await this.getOwnerAddress();
      if (!sameEvmAddress(resultAddress, ownerAddress)) {
        throw new AppError('WALLET_ADDRESS_MISMATCH', 'The authenticated wallet address changed.');
      }
      return { didToken: result.magic.idToken, authMethod: 'google' as const };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw mapMagicError(error, 'AUTH_PROVIDER_UNAVAILABLE');
    }
  }

  async loginWithEmailOtp(input: { email: string }) {
    const email = input.email.trim().toLowerCase();
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new AppError('VALIDATION_FAILED', 'Enter a valid email address.');
    }
    try {
      const magic = await this.loader(this.config);
      const token = await magic.auth.loginWithEmailOTP({ email, showUI: true });
      if (typeof token !== 'string' || token.length < 16 || token.length > 16_384) {
        throw new AppError('AUTH_DID_INVALID', 'Magic did not return a valid identity proof.');
      }
      await this.getOwnerAddress();
      return { didToken: token, authMethod: 'email_otp' as const };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw mapMagicError(error, 'AUTH_PROVIDER_UNAVAILABLE');
    }
  }

  async getFreshIdentityProof(): Promise<{ didToken: string }> {
    try {
      const magic = await this.loader(this.config);
      const token = await magic.user.getIdToken({ lifespan: 300 });
      if (typeof token !== 'string' || token.length < 16 || token.length > 16_384) {
        throw new AppError('AUTH_DID_INVALID', 'Magic did not return a fresh identity proof.');
      }
      await this.getOwnerAddress();
      return { didToken: token };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw mapMagicError(error, 'AUTH_PROVIDER_UNAVAILABLE');
    }
  }

  async getOwnerAddress(): Promise<EvmAddress> {
    try {
      const magic = await this.loader(this.config);
      const metadata = MagicUserMetadataSchema.parse(await magic.user.getInfo());
      const metadataAddress = ethereumMetadataAddress(metadata);
      const accounts = AccountListSchema.parse(
        await magic.rpcProvider.request({ method: 'eth_accounts' }),
      );
      const providerAddress = accounts[0];
      if (providerAddress === undefined || !sameEvmAddress(metadataAddress, providerAddress)) {
        throw new AppError(
          'WALLET_ADDRESS_MISMATCH',
          'Magic wallet/provider addresses do not match.',
        );
      }
      return metadataAddress;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw mapMagicError(error, 'AUTH_PROVIDER_UNAVAILABLE');
    }
  }

  async getChainId(): Promise<string> {
    try {
      const magic = await this.loader(this.config);
      const chainHex = ChainIdHexSchema.parse(
        await magic.rpcProvider.request({ method: 'eth_chainId' }),
      );
      const chain = BigInt(chainHex);
      if (chain <= 0n) throw new Error('Invalid chain ID');
      return chain.toString();
    } catch (error) {
      throw mapMagicError(error, 'WALLET_CHAIN_SWITCH_FAILED');
    }
  }

  async switchToArbitrum(): Promise<void> {
    try {
      const magic = await this.loader(this.config);
      await magic.evm.switchChain(ARBITRUM_CHAIN_NUMBER);
      if ((await this.getChainId()) !== ARBITRUM_ONE_CHAIN_ID) {
        throw new AppError('WALLET_CHAIN_SWITCH_FAILED', 'Magic did not switch to Arbitrum One.');
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw mapMagicError(error, 'WALLET_CHAIN_SWITCH_FAILED');
    }
  }

  /**
   * One-time operator certification probe. Magic may return either the EOA
   * nonce or the authorization nonce depending on its release convention. We
   * validate the signed envelope but intentionally discard its signature and
   * expose only the non-secret convention fields to the capture adapter.
   */
  async probeDelegationAuthorizationNonce(input: {
    ownerAddress: EvmAddress;
    implementationAddress: EvmAddress;
  }): Promise<{
    chainId: typeof ARBITRUM_ONE_CHAIN_ID;
    implementationAddress: EvmAddress;
    nonce: string;
  }> {
    await this.#assertCurrentOwner(input.ownerAddress);
    if ((await this.getChainId()) !== ARBITRUM_ONE_CHAIN_ID) {
      throw new AppError('WALLET_CHAIN_SWITCH_FAILED', 'Switch to Arbitrum before certification.');
    }
    try {
      const magic = await this.loader(this.config);
      const authorization = SignedAuthorizationSchema.parse(
        await magic.wallet.sign7702Authorization({
          contractAddress: input.implementationAddress,
          chainId: ARBITRUM_CHAIN_NUMBER,
        }),
      );
      if (
        authorization.chainId !== ARBITRUM_CHAIN_NUMBER ||
        !sameEvmAddress(authorization.contractAddress, input.implementationAddress)
      ) {
        throw new AppError(
          'OPERATION_PLAN_INVALID',
          'Magic returned a mismatched certification authorization.',
        );
      }
      return {
        chainId: ARBITRUM_ONE_CHAIN_ID,
        implementationAddress: EvmAddressSchema.parse(authorization.contractAddress),
        nonce: authorization.nonce.toString(),
      };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw mapMagicError(error, 'WALLET_SIGNATURE_REJECTED');
    }
  }

  async authorizeDelegation(
    planInput: VerifiedDelegationPlan,
  ): Promise<{ authorization: unknown }> {
    const plan = VerifiedDelegationPlanSchema.parse(planInput);
    if (
      plan.chainId !== ARBITRUM_ONE_CHAIN_ID ||
      !sameEvmAddress(plan.ownerAddress, plan.transactionTarget)
    ) {
      throw new AppError(
        'OPERATION_PLAN_INVALID',
        'The delegation plan target or chain is invalid.',
      );
    }
    assertUnexpired(plan.expiresAt);
    await this.#assertCurrentOwner(plan.ownerAddress);
    if ((await this.getChainId()) !== ARBITRUM_ONE_CHAIN_ID) {
      throw new AppError('WALLET_CHAIN_SWITCH_FAILED', 'Switch to Arbitrum before delegation.');
    }
    try {
      const magic = await this.loader(this.config);
      const authorization = SignedAuthorizationSchema.parse(
        await magic.wallet.sign7702Authorization({
          contractAddress: plan.implementationAddress,
          chainId: ARBITRUM_CHAIN_NUMBER,
          nonce: safeNonce(plan.nonce),
        }),
      );
      if (
        authorization.chainId !== ARBITRUM_CHAIN_NUMBER ||
        authorization.nonce !== safeNonce(plan.nonce) ||
        !sameEvmAddress(authorization.contractAddress, plan.implementationAddress)
      ) {
        throw new AppError('OPERATION_PLAN_INVALID', 'Magic returned a mismatched delegation.');
      }
      return { authorization };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw mapMagicError(error, 'WALLET_SIGNATURE_REJECTED');
    }
  }

  async submitDelegation(
    planInput: VerifiedDelegationPlan,
    signed: { authorization: unknown },
  ): Promise<{ transactionHash: string; submissionPossible: boolean }> {
    const plan = VerifiedDelegationPlanSchema.parse(planInput);
    const authorization = SignedAuthorizationSchema.parse(signed.authorization);
    if (
      plan.chainId !== ARBITRUM_ONE_CHAIN_ID ||
      authorization.chainId !== ARBITRUM_CHAIN_NUMBER ||
      authorization.nonce !== safeNonce(plan.nonce) ||
      !sameEvmAddress(plan.ownerAddress, plan.transactionTarget) ||
      !sameEvmAddress(authorization.contractAddress, plan.implementationAddress)
    ) {
      throw new AppError(
        'OPERATION_PLAN_INVALID',
        'The signed delegation does not match its plan.',
      );
    }
    assertUnexpired(plan.expiresAt);
    await this.#assertCurrentOwner(plan.ownerAddress);

    try {
      const magic = await this.loader(this.config);
      const response = Type4ResponseSchema.parse(
        await magic.wallet.send7702Transaction({
          to: plan.ownerAddress,
          value: '0x0',
          data: '0x',
          authorizationList: [authorization],
        }),
      );
      return { transactionHash: response.transactionHash, submissionPossible: true };
    } catch (error) {
      throw mapMagicError(error, 'WALLET_TYPE4_SUBMISSION_FAILED', { submissionPossible: true });
    }
  }

  async signValidatedRoot(
    planInput: ValidatedOperationPlan,
  ): Promise<{ signature: string; recoveredOwner: EvmAddress }> {
    const plan = ValidatedOperationPlanSchema.parse(planInput);
    assertUnexpired(plan.expiresAt);
    await this.#assertCurrentOwner(plan.template.ownerAddress);
    try {
      const magic = await this.loader(this.config);
      const provider = new BrowserProvider(magic.rpcProvider);
      const signer = await provider.getSigner();
      const signerAddress = EvmAddressSchema.parse(await signer.getAddress());
      if (!sameEvmAddress(signerAddress, plan.template.ownerAddress)) {
        throw new AppError('WALLET_ADDRESS_MISMATCH', 'The Magic signer does not own this action.');
      }
      const signature = await signer.signMessage(getBytes(plan.rootHash));
      const recoveredOwner = EvmAddressSchema.parse(
        verifyMessage(getBytes(plan.rootHash), signature),
      );
      if (!sameEvmAddress(recoveredOwner, plan.template.ownerAddress)) {
        throw new AppError(
          'WALLET_SIGNATURE_REJECTED',
          'The action signature could not be verified.',
        );
      }
      return { signature, recoveredOwner };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw mapMagicError(error, 'WALLET_SIGNATURE_REJECTED');
    }
  }

  /**
   * Sends one server-bound operator bootstrap mutation directly through the
   * authenticated Magic EOA. This deliberately excludes payments, refunds,
   * withdrawals, arbitrary targets, native value, and multi-call execution.
   */
  async submitOperatorBootstrapMutation(input: {
    template: BoundOperationTemplate;
    action: MagicOperatorBootstrapAction;
    checkoutAddress: EvmAddress;
  }): Promise<{ transactionHash: TransactionHash }> {
    const template = BoundOperationTemplateSchema.parse(input.template);
    const action = MagicOperatorBootstrapActionSchema.parse(input.action);
    const checkoutAddress = EvmAddressSchema.parse(input.checkoutAddress);
    const call = template.calls[0];
    const expectedKind = action === 'create_merchant' ? 'merchant_mutation' : 'product_mutation';

    if (
      template.kind !== expectedKind ||
      template.chainId !== ARBITRUM_ONE_CHAIN_ID ||
      template.calls.length !== 1 ||
      call === undefined ||
      call.valueWei !== '0' ||
      sameEvmAddress(checkoutAddress, ZERO_ADDRESS) ||
      !sameEvmAddress(call.to, checkoutAddress) ||
      call.data.slice(0, 10).toLowerCase() !== OPERATOR_BOOTSTRAP_SELECTORS[action].toLowerCase()
    ) {
      throw new AppError(
        'OPERATION_PLAN_INVALID',
        'The operator bootstrap action violates the direct-send policy.',
      );
    }
    assertUnexpired(template.expiresAt);
    await this.#assertCurrentOwner(template.ownerAddress);
    if ((await this.getChainId()) !== ARBITRUM_ONE_CHAIN_ID) {
      throw new AppError(
        'WALLET_CHAIN_SWITCH_FAILED',
        'Switch to Arbitrum before sending the operator action.',
      );
    }

    try {
      const magic = await this.loader(this.config);
      const provider = new BrowserProvider(magic.rpcProvider);
      const signer = await provider.getSigner();
      const signerAddress = EvmAddressSchema.parse(await signer.getAddress());
      if (!sameEvmAddress(signerAddress, template.ownerAddress)) {
        throw new AppError(
          'WALLET_ADDRESS_MISMATCH',
          'The Magic signer does not own this operator action.',
        );
      }
      const rawHash = await signer.sendUncheckedTransaction({
        to: checkoutAddress,
        data: call.data,
        value: 0n,
      });
      const parsedHash = TransactionHashSchema.safeParse(rawHash);
      if (!parsedHash.success) {
        throw new AppError(
          'RPC_INCONSISTENT',
          'Magic returned an invalid operator transaction hash.',
          { submissionPossible: true, cause: parsedHash.error },
        );
      }
      return { transactionHash: parsedHash.data };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw mapMagicError(error, 'RPC_UNAVAILABLE', { submissionPossible: true });
    }
  }

  async logout(): Promise<void> {
    try {
      const magic = await this.loader(this.config);
      await magic.user.logout();
      singleton = undefined;
    } catch (error) {
      throw mapMagicError(error, 'AUTH_PROVIDER_UNAVAILABLE');
    }
  }

  async #assertCurrentOwner(expected: EvmAddress): Promise<void> {
    const actual = await this.getOwnerAddress();
    if (!sameEvmAddress(actual, expected)) {
      throw new AppError(
        'WALLET_ADDRESS_MISMATCH',
        'The current Magic wallet does not own this action.',
      );
    }
  }
}

export function createMagicBrowserWallet(config: MagicBrowserConfig): MagicBrowserWalletAdapter {
  assertBrowser();
  return new MagicBrowserWalletAdapter(config);
}
