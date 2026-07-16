import type { ClockPort, DistributedLockPort, RandomPort } from '@opentab/application';
import {
  type AdapterEvidence,
  AdapterEvidenceSchema,
  type BaseUnitAmount,
  BaseUnitAmountSchema,
  type EvidenceDigest,
  EvidenceDigestSchema,
  type EvmAddress,
  EvmAddressSchema,
} from '@opentab/shared';

export const DETERMINISTIC_PROVENANCE_LABEL = 'DETERMINISTIC DEMO — NO LIVE FUNDS' as const;

export const DEMO_CUSTOMER_ADDRESS = EvmAddressSchema.parse(
  '0x1000000000000000000000000000000000000001',
);
export const DEMO_MERCHANT_ADDRESS = EvmAddressSchema.parse(
  '0x2000000000000000000000000000000000000002',
);
export const DEMO_CHECKOUT_ADDRESS = EvmAddressSchema.parse(
  '0x3000000000000000000000000000000000000003',
);
export const DEMO_PASS_ADDRESS = EvmAddressSchema.parse(
  '0x4000000000000000000000000000000000000004',
);
export const DEMO_DELEGATE_ADDRESS = EvmAddressSchema.parse(
  '0x5000000000000000000000000000000000000005',
);

export function deterministicDigest(byte: string): EvidenceDigest {
  if (!/^[0-9a-fA-F]{2}$/.test(byte)) throw new Error('Digest byte must be two hex characters');
  return EvidenceDigestSchema.parse(`0x${byte.repeat(32)}`);
}

export function deterministicEvidence(adapter: string, digestByte = 'ab'): AdapterEvidence {
  return AdapterEvidenceSchema.parse({
    adapter,
    packageVersion: 'deterministic-1',
    schemaVersion: 1,
    environment: 'local',
    observedAt: '2026-07-10T12:00:00.000Z',
    evidenceDigest: deterministicDigest(digestByte),
    provenance: 'deterministic',
  });
}

export class DeterministicClock implements ClockPort {
  constructor(private current = new Date('2026-07-10T12:00:00.000Z')) {}

  now(): Date {
    return new Date(this.current);
  }

  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}

export class DeterministicRandom implements RandomPort {
  private sequence = 0n;

  opaqueId(prefix: string): string {
    this.sequence += 1n;
    return `${prefix}_${this.sequence.toString(32).toUpperCase().padStart(26, '0')}`;
  }

  bytes32(): `0x${string}` {
    this.sequence += 1n;
    return `0x${this.sequence.toString(16).padStart(64, '0')}`;
  }

  secret(bytes: number): string {
    if (!Number.isInteger(bytes) || bytes < 16)
      throw new RangeError('Deterministic secrets require at least 16 bytes');
    this.sequence += 1n;
    return `${this.sequence.toString(16).padStart(bytes * 2, '0')}`;
  }
}

export class InMemoryDistributedLock implements DistributedLockPort {
  private readonly active = new Set<string>();

  async withLock<T>(
    key: string,
    _ttlMs: number,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.active.has(key)) throw new Error(`LOCK_BUSY:${key}`);
    this.active.add(key);
    const controller = new AbortController();
    try {
      return await operation(controller.signal);
    } finally {
      this.active.delete(key);
    }
  }
}

export interface DeterministicDemoScenario {
  provenanceLabel: typeof DETERMINISTIC_PROVENANCE_LABEL;
  customerAddress: EvmAddress;
  merchantAddress: EvmAddress;
  productPriceBaseUnits: BaseUnitAmount;
  aggregateAvailableUsd: string;
  sourceAssets: readonly [{ chain: 'Base'; symbol: 'USDC'; amount: '24.00' }];
}

export const DETERMINISTIC_DEMO_SCENARIO: DeterministicDemoScenario = {
  provenanceLabel: DETERMINISTIC_PROVENANCE_LABEL,
  customerAddress: DEMO_CUSTOMER_ADDRESS,
  merchantAddress: DEMO_MERCHANT_ADDRESS,
  productPriceBaseUnits: BaseUnitAmountSchema.parse('12000000'),
  aggregateAvailableUsd: '24.00',
  sourceAssets: [{ chain: 'Base', symbol: 'USDC', amount: '24.00' }],
};
