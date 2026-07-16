import { AppError } from '@opentab/shared';
import type { z } from 'zod';

export interface RouteContext {
  readonly params: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}

export async function routeParam<S extends z.ZodType>(
  context: RouteContext,
  name: string,
  schema: S,
): Promise<z.output<S>> {
  const value = (await context.params)[name];
  try {
    return schema.parse(value);
  } catch (error) {
    throw new AppError('VALIDATION_FAILED', `The ${name} path parameter is invalid.`, {
      cause: error,
    });
  }
}

export function queryInput<S extends z.ZodType>(request: Request, schema: S): z.output<S> {
  const entries: Record<string, string> = {};
  const search = new URL(request.url).searchParams;
  for (const key of new Set(search.keys())) {
    const values = search.getAll(key);
    if (values.length !== 1 || values[0] === undefined) {
      throw new AppError('VALIDATION_FAILED', `The ${key} query parameter is invalid.`);
    }
    entries[key] = values[0];
  }
  try {
    return schema.parse(entries);
  } catch (error) {
    throw new AppError('VALIDATION_FAILED', 'The query parameters are invalid.', { cause: error });
  }
}
