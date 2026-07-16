import { z } from 'zod';
import { EvmAddressSchema } from './address.js';
import { EvidenceDigestSchema, MerchantIdSchema, SessionIdSchema, UserIdSchema } from './ids.js';

export const AuthMethodSchema = z.enum(['google', 'email_otp']);
export const UserStatusSchema = z.enum(['active', 'suspended', 'closed']);
export const MerchantRoleSchema = z.enum(['owner', 'admin', 'operator', 'viewer']);

export const VerifiedMagicIdentitySchema = z.object({
  issuerHash: z.string().min(32).max(128),
  walletAddress: EvmAddressSchema,
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  audience: z.string().min(1).max(256),
  applicationId: z.string().min(1).max(256),
  authMethod: AuthMethodSchema,
  evidenceDigest: EvidenceDigestSchema,
});

export const CurrentUserSchema = z.object({
  id: UserIdSchema,
  walletAddress: EvmAddressSchema,
  authMethod: AuthMethodSchema,
  status: UserStatusSchema,
  merchantMemberships: z.array(
    z.object({ merchantId: MerchantIdSchema, role: MerchantRoleSchema }),
  ),
});

export const ApplicationSessionSchema = z.object({
  id: SessionIdSchema,
  userId: UserIdSchema,
  walletAddress: EvmAddressSchema,
  expiresAt: z.string().datetime(),
  csrfToken: z.string().min(32).max(256),
});

export type AuthMethod = z.infer<typeof AuthMethodSchema>;
export type VerifiedMagicIdentity = z.infer<typeof VerifiedMagicIdentitySchema>;
export type CurrentUser = z.infer<typeof CurrentUserSchema>;
export type ApplicationSession = z.infer<typeof ApplicationSessionSchema>;
