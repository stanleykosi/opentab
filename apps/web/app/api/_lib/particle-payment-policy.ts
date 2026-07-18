import type { BackendApiQueryPort } from '@opentab/application';
import type { LoadedParticleCompatibilityProfile } from '@opentab/db';
import { AppError, type CurrentUser } from '@opentab/shared';

export class ParticleReleasePaymentPolicy {
  constructor(
    private readonly dependencies: {
      readonly loaded: LoadedParticleCompatibilityProfile | undefined;
      readonly queries: BackendApiQueryPort;
      readonly subjectHash: (actor: CurrentUser) => string;
    },
  ) {}

  #assertCanaryActor(actor: CurrentUser): void {
    const loaded = this.dependencies.loaded;
    if (loaded === undefined) {
      throw new AppError(
        'FEATURE_DISABLED',
        'Payments remain disabled until this Particle project has a compatibility profile.',
      );
    }
    if (loaded.profile.stage === 'certified') return;
    if (this.dependencies.subjectHash(actor) !== loaded.binding.certifiedSubjectHash) {
      throw new AppError(
        'AUTH_FORBIDDEN',
        'This Particle profile is restricted to its bound canary operator.',
      );
    }
  }

  #assertCanaryOrder(input: {
    readonly actor: CurrentUser;
    readonly productOnchainId: string | undefined;
    readonly amountBaseUnits: string;
  }): void {
    this.#assertCanaryActor(input.actor);
    const loaded = this.dependencies.loaded;
    if (loaded === undefined || loaded.profile.stage === 'certified') return;
    if (
      input.productOnchainId !== loaded.binding.canaryProductId ||
      BigInt(input.amountBaseUnits) > BigInt(loaded.binding.canaryMaxBaseUnits)
    ) {
      throw new AppError(
        'FEATURE_DISABLED',
        'Only the profile-bound activation item is enabled before customer checkout opens.',
      );
    }
  }

  authorizeCreation(input: {
    readonly user: CurrentUser;
    readonly session: { readonly amountBaseUnits: string };
    readonly authoritative: { readonly productOnchainId: string };
  }): void {
    this.#assertCanaryOrder({
      actor: input.user,
      productOnchainId: input.authoritative.productOnchainId,
      amountBaseUnits: input.session.amountBaseUnits,
    });
  }

  async authorizeSubmission(input: {
    readonly actor: CurrentUser;
    readonly workflow: {
      readonly order: {
        readonly id: Parameters<BackendApiQueryPort['getOrderForActor']>[0];
        readonly amountBaseUnits: string;
      };
    };
  }): Promise<void> {
    this.#assertCanaryActor(input.actor);
    const loaded = this.dependencies.loaded;
    if (loaded?.profile.stage === 'bootstrap') {
      throw new AppError(
        'FEATURE_DISABLED',
        'Capture and approve the constrained Particle preview before submitting the canary.',
      );
    }
    if (loaded?.profile.stage === 'certified') return;
    const order = await this.dependencies.queries.getOrderForActor(
      input.workflow.order.id,
      input.actor,
    );
    if (order === undefined) throw new AppError('NOT_FOUND', 'The canary order was not found.');
    this.#assertCanaryOrder({
      actor: input.actor,
      productOnchainId: order.product.onchainProductId,
      amountBaseUnits: input.workflow.order.amountBaseUnits,
    });
  }
}
