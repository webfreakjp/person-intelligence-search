import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../../../packages/core/context.ts';
import {
  FieldCreateSchema,
  FieldPatchSchema,
  SchemaCreateSchema,
  SchemaPatchSchema,
  createField,
  createSchema,
  deleteField,
  deleteSchema,
  getFieldOrThrow,
  getSchemaOrThrow,
  updateField,
  updateSchema
} from '../../../../packages/core/schemaService.ts';
import { IdParamSchema } from './helpers.ts';

export async function registerSchemaRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.post('/v1/schemas', async (request, reply) => {
    const schema = await createSchema(ctx, request.tenantId, SchemaCreateSchema.parse(request.body ?? {}));
    return reply.status(201).send(schema);
  });

  app.get('/v1/schemas', async (request) => ({
    results: await ctx.store.find('schemas', { tenant_id: request.tenantId }, { orderBy: 'created_at', dir: 'asc' })
  }));

  app.get('/v1/schemas/:id', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    const schema = await getSchemaOrThrow(ctx, request.tenantId, id);
    const fields = await ctx.store.find(
      'field_definitions',
      { tenant_id: request.tenantId, schema_id: id },
      { orderBy: 'created_at', dir: 'asc' }
    );
    return { ...schema, fields };
  });

  app.patch('/v1/schemas/:id', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    return updateSchema(ctx, request.tenantId, id, SchemaPatchSchema.parse(request.body ?? {}));
  });

  app.delete('/v1/schemas/:id', async (request, reply) => {
    const { id } = IdParamSchema.parse(request.params);
    await deleteSchema(ctx, request.tenantId, id);
    return reply.status(204).send();
  });

  app.post('/v1/schemas/:id/fields', async (request, reply) => {
    const { id } = IdParamSchema.parse(request.params);
    const field = await createField(ctx, request.tenantId, id, FieldCreateSchema.parse(request.body ?? {}));
    return reply.status(201).send(field);
  });

  app.get('/v1/schemas/:id/fields', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    await getSchemaOrThrow(ctx, request.tenantId, id);
    return {
      results: await ctx.store.find(
        'field_definitions',
        { tenant_id: request.tenantId, schema_id: id },
        { orderBy: 'created_at', dir: 'asc' }
      )
    };
  });

  app.get('/v1/fields/:id', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    return getFieldOrThrow(ctx, request.tenantId, id);
  });

  app.patch('/v1/fields/:id', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    return updateField(ctx, request.tenantId, id, FieldPatchSchema.parse(request.body ?? {}));
  });

  app.delete('/v1/fields/:id', async (request, reply) => {
    const { id } = IdParamSchema.parse(request.params);
    await deleteField(ctx, request.tenantId, id);
    return reply.status(204).send();
  });
}
