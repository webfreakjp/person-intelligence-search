import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../../../packages/core/context.ts';
import { cancelJob, retryJob } from '../../../../packages/core/jobService.ts';
import { notFound } from '../../../../packages/shared/errors.ts';
import { IdParamSchema, PageQuerySchema, pageOf } from './helpers.ts';

const JobListQuerySchema = PageQuerySchema.extend({
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'retrying', 'cancelled']).optional(),
  job_type: z.string().max(64).optional()
});

export async function registerJobRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/v1/jobs', async (request) => {
    const { limit, offset, status, job_type } = JobListQuerySchema.parse(request.query ?? {});
    const where: Record<string, unknown> = { tenant_id: request.tenantId };
    if (status) where.status = status;
    if (job_type) where.job_type = job_type;
    const [jobs, total] = await Promise.all([
      ctx.store.find('processing_jobs', where, { orderBy: 'created_at', dir: 'desc', limit, offset }),
      ctx.store.count('processing_jobs', where)
    ]);
    return pageOf(jobs, limit, offset, total);
  });

  app.get('/v1/jobs/:id', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    const job = await ctx.store.get('processing_jobs', id);
    if (!job || job.tenant_id !== request.tenantId) throw notFound('job not found');
    return job;
  });

  app.post('/v1/jobs/:id/retry', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    return retryJob(ctx, request.tenantId, id);
  });

  app.post('/v1/jobs/:id/cancel', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    return cancelJob(ctx, request.tenantId, id);
  });
}
