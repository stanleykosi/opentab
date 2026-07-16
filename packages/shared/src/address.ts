import { z } from 'zod';

export const EvmAddressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .brand<'EvmAddress'>();
export const EvmAddressLowerSchema = z
  .string()
  .regex(/^0x[0-9a-f]{40}$/)
  .brand<'EvmAddressLower'>();
export const ChainIdSchema = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .brand<'ChainId'>();

export const ARBITRUM_ONE_CHAIN_ID = ChainIdSchema.parse('42161');
export const ARBITRUM_SEPOLIA_CHAIN_ID = ChainIdSchema.parse('421614');
export const ARBITRUM_ONE_USDC = EvmAddressSchema.parse(
  '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
);

export type EvmAddress = z.infer<typeof EvmAddressSchema>;
export type EvmAddressLower = z.infer<typeof EvmAddressLowerSchema>;
export type ChainId = z.infer<typeof ChainIdSchema>;

export function toAddressLower(address: EvmAddress): EvmAddressLower {
  return EvmAddressLowerSchema.parse(address.toLowerCase());
}

export function sameEvmAddress(left: EvmAddress, right: EvmAddress): boolean {
  return left.toLowerCase() === right.toLowerCase();
}
