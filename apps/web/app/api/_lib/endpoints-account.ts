import { AppError, type CurrentUser } from '@opentab/shared';
import { z } from 'zod';
import { handleQuery } from './http.js';
import { queryInput } from './params.js';

const CustomerOrdersQuerySchema = z
  .object({
    cursor: z.string().min(4).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(25),
  })
  .strict();

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new AppError('INTERNAL_ERROR', `${label} was not resolved.`);
  return value;
}

export function listCustomerOrders(request: Request): Promise<Response> {
  return handleQuery({
    request,
    auth: 'required',
    execute: async ({ registry, actor }) => {
      const query = queryInput(request, CustomerOrdersQuerySchema);
      return registry.queries.listCustomerOrders({
        actor: required<CurrentUser>(actor, 'Actor'),
        limit: query.limit,
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      });
    },
  });
}
