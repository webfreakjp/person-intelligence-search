import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../../../packages/core/context.ts';
import { ContextPatchSchema, deleteContext, deleteRelationship, updateContext } from '../../../../packages/core/contextService.ts';
import { IdParamSchema } from './helpers.ts';

const ContextDeleteSchema = z.object({ exclude_person: z.boolean().optional() }).nullish();

export async function registerContextRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.patch('/v1/contexts/:id', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    return updateContext(ctx, request.tenantId, id, ContextPatchSchema.parse(request.body ?? {}));
  });

  app.delete('/v1/contexts/:id', async (request, reply) => {
    const { id } = IdParamSchema.parse(request.params);
    const body = ContextDeleteSchema.parse(request.body ?? null);
    await deleteContext(ctx, request.tenantId, id, { excludePerson: body?.exclude_person ?? false });
    return reply.status(204).send();
  });

  app.delete('/v1/relationships/:id', async (request, reply) => {
    const { id } = IdParamSchema.parse(request.params);
    await deleteRelationship(ctx, request.tenantId, id);
    return reply.status(204).send();
  });
}
