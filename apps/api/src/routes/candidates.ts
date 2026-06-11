import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  applyFieldCandidate,
  createPersonFromCandidate,
  linkPersonCandidate,
  presentFieldCandidate,
  rejectFieldCandidate,
  rejectPersonCandidate
} from '../../../../packages/core/candidateService.ts';
import type { AppContext } from '../../../../packages/core/context.ts';
import { notFound } from '../../../../packages/shared/errors.ts';
import { IdParamSchema, PageQuerySchema, pageOf } from './helpers.ts';

const PersonCandidateQuerySchema = PageQuerySchema.extend({
  status: z.enum(['pending', 'linked', 'created', 'rejected']).optional()
});
const FieldCandidateQuerySchema = PageQuerySchema.extend({
  status: z.enum(['pending', 'conflict', 'auto_applied', 'applied', 'rejected', 'superseded']).optional()
});
const LinkBodySchema = z.object({ person_id: z.uuid() });
const CreatePersonBodySchema = z.object({
  canonical_name: z.string().trim().max(200).optional(),
  person_type: z.string().trim().max(64).optional()
});

export async function registerCandidateRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/v1/person-candidates', async (request) => {
    const { limit, offset, status } = PersonCandidateQuerySchema.parse(request.query ?? {});
    const where: Record<string, unknown> = { tenant_id: request.tenantId };
    if (status) where.status = status;
    const [candidates, total] = await Promise.all([
      ctx.store.find('person_candidates', where, { orderBy: 'created_at', dir: 'desc', limit, offset }),
      ctx.store.count('person_candidates', where)
    ]);
    return pageOf(candidates, limit, offset, total);
  });

  app.get('/v1/person-candidates/:id', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    const candidate = await ctx.store.get('person_candidates', id);
    if (!candidate || candidate.tenant_id !== request.tenantId) throw notFound('person candidate not found');
    const persons = await ctx.store.hydratePersons(request.tenantId, candidate.candidate_person_ids ?? []);
    return { ...candidate, candidate_persons: [...persons.values()] };
  });

  app.post('/v1/person-candidates/:id/link', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    const { person_id } = LinkBodySchema.parse(request.body ?? {});
    return linkPersonCandidate(ctx, request.tenantId, id, person_id);
  });

  app.post('/v1/person-candidates/:id/create-person', async (request, reply) => {
    const { id } = IdParamSchema.parse(request.params);
    const overrides = CreatePersonBodySchema.parse(request.body ?? {});
    return reply.status(201).send(await createPersonFromCandidate(ctx, request.tenantId, id, overrides));
  });

  app.post('/v1/person-candidates/:id/reject', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    return rejectPersonCandidate(ctx, request.tenantId, id);
  });

  app.get('/v1/extracted-field-candidates', async (request) => {
    const { limit, offset, status } = FieldCandidateQuerySchema.parse(request.query ?? {});
    const where: Record<string, unknown> = { tenant_id: request.tenantId };
    if (status) where.status = status;
    const [candidates, total, definitions] = await Promise.all([
      ctx.store.find('extracted_field_candidates', where, { orderBy: 'created_at', dir: 'desc', limit, offset }),
      ctx.store.count('extracted_field_candidates', where),
      ctx.store.find('field_definitions', { tenant_id: request.tenantId })
    ]);
    const definitionById = new Map(definitions.map((definition) => [definition.id, definition]));
    return pageOf(
      candidates.map((candidate) => ({
        ...presentFieldCandidate(candidate, definitionById.get(candidate.field_definition_id)?.type),
        field_key: definitionById.get(candidate.field_definition_id)?.key ?? null,
        field_label: definitionById.get(candidate.field_definition_id)?.label ?? null
      })),
      limit,
      offset,
      total
    );
  });

  app.post('/v1/extracted-field-candidates/:id/apply', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    return applyFieldCandidate(ctx, request.tenantId, id);
  });

  app.post('/v1/extracted-field-candidates/:id/reject', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    return rejectFieldCandidate(ctx, request.tenantId, id);
  });
}
