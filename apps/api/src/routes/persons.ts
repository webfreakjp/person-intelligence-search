import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../../../packages/core/context.ts';
import { RelationshipCreateSchema, createRelationship, listRelationships } from '../../../../packages/core/contextService.ts';
import {
  AliasInputSchema,
  FieldsPatchSchema,
  MetricInputSchema,
  PersonCreateSchema,
  PersonPatchSchema,
  ProfilePatchSchema,
  SnsAccountInputSchema,
  SnsAccountPatchSchema,
  addAlias,
  addMetric,
  addSnsAccount,
  createPerson,
  deleteAlias,
  deletePerson,
  deleteSnsAccount,
  getPersonOrThrow,
  hydrateOne,
  listFieldValues,
  patchFieldValues,
  patchProfile,
  rebuildSearchDocument,
  updatePerson,
  updateSnsAccount
} from '../../../../packages/core/personService.ts';
import { notFound } from '../../../../packages/shared/errors.ts';
import { IdParamSchema, PageQuerySchema, pageOf } from './helpers.ts';

const ListQuerySchema = PageQuerySchema.extend({ q: z.string().max(200).default('') });
const AccountParamSchema = z.object({ id: z.uuid(), account_id: z.uuid() });

export async function registerPersonRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.post('/v1/persons', async (request, reply) => {
    const input = PersonCreateSchema.parse(request.body ?? {});
    const person = await createPerson(ctx, request.tenantId, input);
    return reply.status(201).send(person);
  });

  app.get('/v1/persons', async (request) => {
    const { q, limit, offset } = ListQuerySchema.parse(request.query ?? {});
    const { results, total } = await ctx.store.searchPersonsByName(request.tenantId, q, limit, offset);
    const hydrated = await ctx.store.hydratePersons(
      request.tenantId,
      results.map((person) => person.id)
    );
    return pageOf(
      results.map((person) => hydrated.get(person.id) ?? person),
      limit,
      offset,
      total
    );
  });

  app.get('/v1/persons/:id', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    await getPersonOrThrow(ctx, request.tenantId, id);
    return hydrateOne(ctx, request.tenantId, id);
  });

  app.patch('/v1/persons/:id', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    return updatePerson(ctx, request.tenantId, id, PersonPatchSchema.parse(request.body ?? {}));
  });

  app.delete('/v1/persons/:id', async (request, reply) => {
    const { id } = IdParamSchema.parse(request.params);
    await deletePerson(ctx, request.tenantId, id);
    return reply.status(204).send();
  });

  app.get('/v1/persons/:id/aliases', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    await getPersonOrThrow(ctx, request.tenantId, id);
    return {
      results: await ctx.store.find('person_aliases', { tenant_id: request.tenantId, person_id: id }, { orderBy: 'created_at', dir: 'asc' })
    };
  });

  app.post('/v1/persons/:id/aliases', async (request, reply) => {
    const { id } = IdParamSchema.parse(request.params);
    const alias = await addAlias(ctx, request.tenantId, id, AliasInputSchema.parse(request.body ?? {}));
    return reply.status(201).send(alias);
  });

  app.delete('/v1/persons/:id/aliases/:alias_id', async (request, reply) => {
    const { id, alias_id } = z.object({ id: z.uuid(), alias_id: z.uuid() }).parse(request.params);
    await deleteAlias(ctx, request.tenantId, id, alias_id);
    return reply.status(204).send();
  });

  app.get('/v1/persons/:id/profile', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    await getPersonOrThrow(ctx, request.tenantId, id);
    const profile = await ctx.store.get('person_profiles', id);
    if (!profile) return { person_id: id, tenant_id: request.tenantId, short_bio: null, profile_text: null, updated_at: null };
    const { profile_embedding: _omit, ...rest } = profile;
    return rest;
  });

  app.patch('/v1/persons/:id/profile', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    return patchProfile(ctx, request.tenantId, id, ProfilePatchSchema.parse(request.body ?? {}));
  });

  app.get('/v1/persons/:id/sns', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    await getPersonOrThrow(ctx, request.tenantId, id);
    const person = await hydrateOne(ctx, request.tenantId, id);
    return { results: person.sns_accounts };
  });

  app.post('/v1/persons/:id/sns', async (request, reply) => {
    const { id } = IdParamSchema.parse(request.params);
    await getPersonOrThrow(ctx, request.tenantId, id);
    const account = await addSnsAccount(ctx, request.tenantId, id, SnsAccountInputSchema.parse(request.body ?? {}));
    await rebuildSearchDocument(ctx, request.tenantId, id);
    return reply.status(201).send(account);
  });

  app.patch('/v1/persons/:id/sns/:account_id', async (request) => {
    const { id, account_id } = AccountParamSchema.parse(request.params);
    return updateSnsAccount(ctx, request.tenantId, id, account_id, SnsAccountPatchSchema.parse(request.body ?? {}));
  });

  app.delete('/v1/persons/:id/sns/:account_id', async (request, reply) => {
    const { id, account_id } = AccountParamSchema.parse(request.params);
    await deleteSnsAccount(ctx, request.tenantId, id, account_id);
    return reply.status(204).send();
  });

  app.get('/v1/persons/:id/relationships', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    return { results: await listRelationships(ctx, request.tenantId, id) };
  });

  app.post('/v1/persons/:id/relationships', async (request, reply) => {
    const { id } = IdParamSchema.parse(request.params);
    const relationship = await createRelationship(ctx, request.tenantId, id, RelationshipCreateSchema.parse(request.body ?? {}));
    return reply.status(201).send(relationship);
  });

  app.get('/v1/persons/:id/sns/:account_id/metrics', async (request) => {
    const { id, account_id } = AccountParamSchema.parse(request.params);
    await getPersonOrThrow(ctx, request.tenantId, id);
    const account = await ctx.store.get('person_sns_accounts', account_id);
    if (!account || account.person_id !== id) throw notFound('sns account not found');
    return {
      results: await ctx.store.find(
        'person_sns_metrics',
        { tenant_id: request.tenantId, account_id },
        { orderBy: 'measured_at', dir: 'desc', limit: 100 }
      )
    };
  });

  app.post('/v1/persons/:id/sns/:account_id/metrics', async (request, reply) => {
    const { id, account_id } = AccountParamSchema.parse(request.params);
    await getPersonOrThrow(ctx, request.tenantId, id);
    const account = await ctx.store.get('person_sns_accounts', account_id);
    if (!account || account.person_id !== id) throw notFound('sns account not found');
    const metric = await addMetric(ctx, request.tenantId, account_id, MetricInputSchema.parse(request.body ?? {}));
    return reply.status(201).send(metric);
  });

  app.get('/v1/persons/:id/contexts', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    const { limit, offset } = PageQuerySchema.parse(request.query ?? {});
    await getPersonOrThrow(ctx, request.tenantId, id);
    const contexts = await ctx.store.find(
      'person_contexts',
      { tenant_id: request.tenantId, person_id: id },
      { orderBy: 'occurred_at', dir: 'desc', limit, offset }
    );
    return pageOf(
      contexts.map(({ context_embedding: _omit, ...rest }) => rest),
      limit,
      offset
    );
  });

  app.get('/v1/persons/:id/summaries', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    await getPersonOrThrow(ctx, request.tenantId, id);
    const summaries = await ctx.store.find(
      'person_summaries',
      { tenant_id: request.tenantId, person_id: id },
      { orderBy: 'generated_at', dir: 'desc', limit: 20 }
    );
    return { results: summaries.map(({ summary_embedding: _omit, ...rest }) => rest) };
  });

  app.get('/v1/persons/:id/fields', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    await getPersonOrThrow(ctx, request.tenantId, id);
    return { results: await listFieldValues(ctx, request.tenantId, id) };
  });

  app.patch('/v1/persons/:id/fields', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    return { results: await patchFieldValues(ctx, request.tenantId, id, FieldsPatchSchema.parse(request.body ?? {})) };
  });
}
