import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../../../packages/core/context.ts';
import { parseSearchQuery, searchPersons } from '../../../../packages/core/searchService.ts';

const SearchRequestSchema = z
  .object({
    query: z.string().max(1000).optional(),
    dsl: z.unknown().optional()
  })
  .refine((input) => input.query?.trim() || input.dsl != null, { message: 'either query or dsl is required', path: ['query'] });

const ParseRequestSchema = z.object({ query: z.string().trim().min(1).max(1000) });

export async function registerSearchRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.post('/v1/search/persons', async (request) => {
    const input = SearchRequestSchema.parse(request.body ?? {});
    return searchPersons(ctx, request.tenantId, input);
  });

  app.post('/v1/search/parse', async (request) => {
    const { query } = ParseRequestSchema.parse(request.body ?? {});
    return parseSearchQuery(ctx, request.tenantId, query);
  });
}
