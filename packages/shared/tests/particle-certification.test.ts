import {
  ARBITRUM_ONE_CHAIN_ID,
  deriveParticleCompatibilityScopeId,
  digestParticleCompatibilityProfile,
  digestParticleProjectConfiguration,
  ParticleCompatibilityProfileSchema,
  ParticleProfileReleaseBindingSchema,
} from '../src/index.js';
import { describe, expect, it } from 'vitest';

const digest = (value: string) => `0x${value.repeat(64)}`;
const address = (value: string) => `0x${value.repeat(40)}`;

function bootstrapProfile() {
  return {
    schemaVersion: 1,
    profileId: 'particle-live-bootstrap-v1',
    stage: 'bootstrap',
    environment: 'demo-mainnet',
    chainId: ARBITRUM_ONE_CHAIN_ID,
    particleSdkVersion: '2.0.3',
    particleProtocolVersion: '2.0.1',
    particleProjectConfigDigest: digest('a'),
    useEIP7702: true,
    delegateAddress: address('b'),
    delegateCodeHash: digest('c'),
    responseDigests: { deployments: digest('d'), auth: digest('e') },
    nonceConvention: { magicAuthorizationNonceOffset: 1, delegationPlanTtlSeconds: 300 },
    capturedAt: '2026-07-18T10:00:00.000Z',
  } as const;
}

describe('Particle compatibility certification', () => {
  it('binds all three exact public Particle project identifiers', () => {
    const baseline = digestParticleProjectConfiguration({
      projectId: 'project',
      projectClientKey: 'client',
      projectAppUuid: 'app',
    });
    expect(
      digestParticleProjectConfiguration({
        projectId: 'project',
        projectClientKey: 'different-client',
        projectAppUuid: 'app',
      }),
    ).not.toBe(baseline);
  });

  it('derives one stable redeploy-safe scope per Particle project tuple', () => {
    const input = {
      environment: 'demo-mainnet' as const,
      chainId: ARBITRUM_ONE_CHAIN_ID,
      projectId: 'project',
      projectClientKey: 'client',
      projectAppUuid: 'app',
      checkoutAddress: address('1'),
      passAddress: address('2'),
      tokenAddress: address('3'),
    };
    const scope = deriveParticleCompatibilityScopeId(input);
    expect(scope).toMatch(/^[0-9a-f]{40}$/);
    expect(deriveParticleCompatibilityScopeId(input)).toBe(scope);
    expect(
      deriveParticleCompatibilityScopeId({ ...input, projectAppUuid: 'different-app' }),
    ).not.toBe(scope);
  });

  it('accepts bootstrap evidence without fabricating later-stage evidence', () => {
    expect(ParticleCompatibilityProfileSchema.parse(bootstrapProfile()).stage).toBe('bootstrap');
    expect(
      ParticleCompatibilityProfileSchema.safeParse({
        ...bootstrapProfile(),
        responseDigests: {
          ...bootstrapProfile().responseDigests,
          submission: digest('f'),
          status: digest('1'),
        },
      }).success,
    ).toBe(false);
  });

  it('requires reviewed source policy before a canary and canonical evidence to certify', () => {
    expect(
      ParticleCompatibilityProfileSchema.safeParse({
        ...bootstrapProfile(),
        profileId: 'particle-live-canary-v1',
        stage: 'canary_ready',
      }).success,
    ).toBe(false);
    expect(
      ParticleCompatibilityProfileSchema.safeParse({
        ...bootstrapProfile(),
        profileId: 'particle-live-certified-v1',
        stage: 'certified',
        responseDigests: {
          ...bootstrapProfile().responseDigests,
          submission: digest('f'),
          status: digest('1'),
        },
      }).success,
    ).toBe(false);
  });

  it('canonicalizes unordered policy sets and address casing for the profile digest', () => {
    const sourceTokenProfile = {
      allowedSourceChainIds: [ARBITRUM_ONE_CHAIN_ID, '8453'],
      allowedSourceAssets: ['USDC'],
      allowedSourceTokens: [{ chainId: '8453', asset: 'USDC', address: address('A') }],
      sourceCallPolicies: [
        {
          policyId: 'base-usdc-approve-v1',
          chainId: '8453',
          asset: 'USDC',
          tokenAddress: address('A'),
          uaType: 'evm',
          target: address('B'),
          functionSelector: '0x095EA7B3',
          nativeValueAllowed: false,
          maxCalls: 1,
          capturedFixtureDigest: digest('F'),
        },
      ],
    } as const;
    const first = {
      ...bootstrapProfile(),
      profileId: 'particle-live-canary-v1',
      stage: 'canary_ready',
      sourceTokenProfile,
    } as const;
    const second = {
      ...first,
      profileId: 'a-different-readable-id',
      delegateAddress: address('B'),
      sourceTokenProfile: {
        ...sourceTokenProfile,
        allowedSourceChainIds: ['8453', ARBITRUM_ONE_CHAIN_ID],
        allowedSourceTokens: [
          { ...sourceTokenProfile.allowedSourceTokens[0], address: address('a') },
        ],
        sourceCallPolicies: [
          {
            ...sourceTokenProfile.sourceCallPolicies[0],
            tokenAddress: address('a'),
            target: address('b'),
            functionSelector: '0x095ea7b3',
            capturedFixtureDigest: digest('f'),
          },
        ],
      },
    } as const;
    expect(digestParticleCompatibilityProfile(first)).toBe(
      digestParticleCompatibilityProfile(second),
    );
  });

  it('hard-caps the compatibility-profile canary to one USDC', () => {
    const base = {
      schemaVersion: 1,
      environment: 'demo-mainnet',
      applicationReleaseId: 'a'.repeat(40),
      chainId: ARBITRUM_ONE_CHAIN_ID,
      stage: 'bootstrap',
      profileId: 'particle-live-bootstrap-v1',
      profileDigest: digest('2'),
      certifiedSubjectHash: digest('3'),
      canaryProductId: '1',
      canaryMaxBaseUnits: '1000000',
      boundAt: '2026-07-18T10:01:00.000Z',
    } as const;
    expect(ParticleProfileReleaseBindingSchema.parse(base).canaryMaxBaseUnits).toBe('1000000');
    expect(
      ParticleProfileReleaseBindingSchema.safeParse({
        ...base,
        canaryMaxBaseUnits: '1000001',
      }).success,
    ).toBe(false);
  });
});
