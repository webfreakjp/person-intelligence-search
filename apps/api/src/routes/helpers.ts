import { z } from 'zod';

export const IdParamSchema = z.object({ id: z.uuid() });

export const PageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0)
});

export function pageOf<T>(results: T[], limit: number, offset: number, total?: number) {
  return { results, limit, offset, ...(total != null ? { total } : {}) };
}
