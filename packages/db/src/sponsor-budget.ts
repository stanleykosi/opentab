import { AppError } from '@opentab/shared';
import { and, eq, sql } from 'drizzle-orm';
import { sponsorBudgets } from './schema/index.js';
import type { PostgresUnitOfWork } from './unit-of-work.js';

export interface SponsorBudgetDimension {
  readonly scope: 'global' | 'address' | 'identity' | 'network' | 'device';
  readonly subjectHash: string;
  readonly limitWei: bigint;
  readonly countLimit: number;
}

export class PostgresSponsorBudget {
  constructor(private readonly uow: PostgresUnitOfWork) {}

  async reserve(input: {
    environment: 'local' | 'test' | 'preview' | 'staging' | 'demo-mainnet' | 'production';
    budgetDate: string;
    amountWei: bigint;
    dimensions: readonly SponsorBudgetDimension[];
  }): Promise<void> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.budgetDate))
      throw new Error('Budget date must be YYYY-MM-DD');
    if (input.amountWei <= 0n) throw new RangeError('Sponsor reservation must be positive');
    const dimensions = [...input.dimensions].sort((left, right) =>
      `${left.scope}:${left.subjectHash}`.localeCompare(`${right.scope}:${right.subjectHash}`),
    );
    if (dimensions.length === 0)
      throw new Error('At least one sponsor budget dimension is required');
    if (
      new Set(dimensions.map((dimension) => `${dimension.scope}:${dimension.subjectHash}`)).size !==
      dimensions.length
    ) {
      throw new Error('Sponsor budget dimensions must be unique');
    }

    await this.uow.transaction(async () => {
      for (const dimension of dimensions) {
        await this.uow
          .current()
          .insert(sponsorBudgets)
          .values({
            environment: input.environment,
            budgetDate: input.budgetDate,
            scope: dimension.scope,
            subjectHash: dimension.subjectHash,
          })
          .onConflictDoNothing();
        const [budget] = await this.uow
          .current()
          .select()
          .from(sponsorBudgets)
          .where(
            and(
              eq(sponsorBudgets.environment, input.environment),
              eq(sponsorBudgets.budgetDate, input.budgetDate),
              eq(sponsorBudgets.scope, dimension.scope),
              eq(sponsorBudgets.subjectHash, dimension.subjectHash),
            ),
          )
          .for('update')
          .limit(1);
        if (budget === undefined) throw new Error('Failed to lock sponsor budget');
        if (
          BigInt(budget.grantedWei) + input.amountWei > dimension.limitWei ||
          budget.grantCount + 1 > dimension.countLimit
        ) {
          throw new AppError(
            'SPONSOR_BUDGET_EXHAUSTED',
            'The bootstrap gas budget is currently unavailable.',
          );
        }
      }

      for (const dimension of dimensions) {
        await this.uow
          .current()
          .update(sponsorBudgets)
          .set({
            grantedWei: sql`${sponsorBudgets.grantedWei} + ${input.amountWei.toString()}::numeric`,
            grantCount: sql`${sponsorBudgets.grantCount} + 1`,
            version: sql`${sponsorBudgets.version} + 1`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(sponsorBudgets.environment, input.environment),
              eq(sponsorBudgets.budgetDate, input.budgetDate),
              eq(sponsorBudgets.scope, dimension.scope),
              eq(sponsorBudgets.subjectHash, dimension.subjectHash),
            ),
          );
      }
    });
  }
}
