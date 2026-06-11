import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../../../packages/core/context.ts';
import {
  SOURCE_TYPES,
  SourceCreateSchema,
  getExtractions,
  getSourceOrThrow,
  ingestSource,
  reprocessSource
} from '../../../../packages/core/sourceService.ts';
import { notFound } from '../../../../packages/shared/errors.ts';
import { IdParamSchema, PageQuerySchema, pageOf } from './helpers.ts';

const SourceListQuerySchema = PageQuerySchema.extend({
  source_type: z.enum(SOURCE_TYPES).optional(),
  processing_status: z.enum(['queued', 'processing', 'processed', 'failed', 'skipped']).optional()
});

export async function registerSourceRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.post('/v1/sources', async (request, reply) => {
    const input = SourceCreateSchema.parse(request.body ?? {});
    const result = await ingestSource(ctx, request.tenantId, input);
    return reply.status(result.duplicate ? 200 : 201).send(result);
  });

  app.get('/v1/sources', async (request) => {
    const { limit, offset, source_type, processing_status } = SourceListQuerySchema.parse(request.query ?? {});
    const where: Record<string, unknown> = { tenant_id: request.tenantId };
    if (source_type) where.source_type = source_type;
    if (processing_status) where.processing_status = processing_status;
    const [sources, total] = await Promise.all([
      ctx.store.find('source_documents', where, { orderBy: 'created_at', dir: 'desc', limit, offset }),
      ctx.store.count('source_documents', where)
    ]);
    return pageOf(sources, limit, offset, total);
  });

  app.get('/v1/sources/:id', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    return getSourceOrThrow(ctx, request.tenantId, id);
  });

  app.get('/v1/sources/:id/payload', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    await getSourceOrThrow(ctx, request.tenantId, id);
    const payload = await ctx.store.get('source_payloads', id);
    if (!payload) throw notFound('payload not found');
    return payload;
  });

  app.get('/v1/sources/:id/versions', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    await getSourceOrThrow(ctx, request.tenantId, id);
    return {
      results: await ctx.store.find(
        'source_document_versions',
        { tenant_id: request.tenantId, source_id: id },
        { orderBy: 'version', dir: 'desc' }
      )
    };
  });

  app.get('/v1/sources/:id/extractions', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    return getExtractions(ctx, request.tenantId, id);
  });

  app.post('/v1/sources/:id/reprocess', async (request, reply) => {
    const { id } = IdParamSchema.parse(request.params);
    return reply.status(202).send(await reprocessSource(ctx, request.tenantId, id));
  });
}
