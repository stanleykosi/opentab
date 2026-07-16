import {
  type AdapterEvidence,
  type EvidenceProvenance,
  digestUnknown as stableDigestUnknown,
} from '@opentab/shared';

/**
 * Produces a stable one-way diagnostic digest. Raw provider payloads are never
 * returned, persisted, or logged by this helper.
 */
export const digestUnknown = stableDigestUnknown;

export function adapterEvidence(input: {
  adapter: string;
  packageVersion: string;
  schemaVersion: number;
  environment: string;
  observedAt: Date;
  payload: unknown;
  provenance: EvidenceProvenance;
}): AdapterEvidence {
  return {
    adapter: input.adapter,
    packageVersion: input.packageVersion,
    schemaVersion: input.schemaVersion,
    environment: input.environment,
    observedAt: input.observedAt.toISOString(),
    evidenceDigest: digestUnknown(input.payload),
    provenance: input.provenance,
  };
}
