import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import type { AppContext } from '../../../packages/core/context.ts';
import { config } from '../../../packages/shared/config.ts';
import { ApiError, unauthorized } from '../../../packages/shared/errors.ts';
import { isUuid } from '../../../packages/shared/utils.ts';
import { registerCandidateRoutes } from './routes/candidates.ts';
import { registerContextRoutes } from './routes/contexts.ts';
import { registerJobRoutes } from './routes/jobs.ts';
import { registerPersonRoutes } from './routes/persons.ts';
import { registerSchemaRoutes } from './routes/schemas.ts';
import { registerSearchRoutes } from './routes/search.ts';
import { registerSourceRoutes } from './routes/sources.ts';
import { registerSystemRoutes } from './routes/system.ts';

declare module 'fastify' {
  interface FastifyRequest {
    tenantId: string;
  }
}

const knownTenants = new Set<string>();

async function resolveTenant(ctx: AppContext, request: FastifyRequest): Promise<string> {
  const header = request.headers['x-tenant-id'];
  const tenantId = typeof header === 'string' && header ? header : config.tenantId;
  if (tenantId === config.tenantId) return tenantId;
  if (!isUuid(tenantId)) throw new ApiError(400, 'BAD_REQUEST', 'x-tenant-id must be a UUID');
  if (!knownTenants.has(tenantId)) {
    const tenant = await ctx.store.get('tenants', tenantId);
    if (!tenant) throw new ApiError(404, 'NOT_FOUND', 'tenant not found');
    knownTenants.add(tenantId);
  }
  return tenantId;
}

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.logLevel },
    bodyLimit: config.maxBodyBytes,
    disableRequestLogging: config.logLevel !== 'debug' && config.logLevel !== 'trace'
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) {
      return reply.status(error.status).send({ error: { code: error.code, message: error.message, details: error.details } });
    }
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid request',
          details: error.issues.map((issue) => ({ field: issue.path.join('.') || 'body', message: issue.message }))
        }
      });
    }
    const fastifyError = error as { statusCode?: number; code?: string; message?: string };
    if (typeof fastifyError.statusCode === 'number' && fastifyError.statusCode < 500) {
      return reply.status(fastifyError.statusCode).send({
        error: { code: fastifyError.code ?? 'BAD_REQUEST', message: fastifyError.message ?? 'Bad request', details: [] }
      });
    }
    app.log.error(error);
    return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error', details: [] } });
  });

  app.setNotFoundHandler((_request, reply) => reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Not found', details: [] } }));

  await app.register(fastifyMultipart, {
    limits: {
      fileSize: config.maxUploadBytes,
      files: 1
    }
  });
  await app.register(fastifyStatic, { root: config.publicDir, prefix: '/' });

  app.addHook('onRequest', async (request) => {
    if (!request.url.startsWith('/v1/')) return;
    if (config.apiKey && request.url !== '/v1/health') {
      const header = request.headers.authorization ?? '';
      const key = typeof request.headers['x-api-key'] === 'string' ? request.headers['x-api-key'] : header.replace(/^Bearer\s+/i, '');
      if (key !== config.apiKey) throw unauthorized('invalid API key');
    }
    request.tenantId = await resolveTenant(ctx, request);
  });

  await registerSystemRoutes(app, ctx);
  await registerPersonRoutes(app, ctx);
  await registerSourceRoutes(app, ctx);
  await registerJobRoutes(app, ctx);
  await registerSchemaRoutes(app, ctx);
  await registerSearchRoutes(app, ctx);
  await registerCandidateRoutes(app, ctx);
  await registerContextRoutes(app, ctx);

  return app;
}
