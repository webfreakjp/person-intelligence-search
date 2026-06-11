import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../../../packages/core/context.ts';
import { describeSearchableFields } from '../../../../packages/search/dsl.ts';

export async function registerSystemRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/v1/health', async () => ({
    ok: await ctx.store.ping(),
    store: ctx.store.kind,
    capabilities: await ctx.store.capabilities()
  }));
  // Backwards-compatible alias used by older tooling.
  app.get('/api/health', async () => ({ ok: await ctx.store.ping(), capabilities: await ctx.store.capabilities() }));

  app.get('/v1/capabilities', async () => ctx.store.capabilities());

  app.get('/v1/meta/searchable-fields', async (request) => {
    const definitions = await ctx.store.find('field_definitions', { tenant_id: request.tenantId });
    return describeSearchableFields(definitions);
  });

  app.get('/v1/stats', async (request) => {
    const tenantId = request.tenantId;
    const [persons, sources, contexts, jobStats, pendingPersonCandidates, openFieldCandidates] = await Promise.all([
      ctx.store.count('persons', { tenant_id: tenantId, status: 'active' }),
      ctx.store.count('source_documents', { tenant_id: tenantId }),
      ctx.store.count('person_contexts', { tenant_id: tenantId }),
      ctx.store.jobStats(tenantId),
      ctx.store.count('person_candidates', { tenant_id: tenantId, status: 'pending' }),
      ctx.store.count('extracted_field_candidates', { tenant_id: tenantId, status: 'pending' })
    ]);
    const conflictFieldCandidates = await ctx.store.count('extracted_field_candidates', { tenant_id: tenantId, status: 'conflict' });
    return {
      persons,
      sources,
      contexts,
      jobs: jobStats,
      pending_person_candidates: pendingPersonCandidates,
      pending_field_candidates: openFieldCandidates,
      conflict_field_candidates: conflictFieldCandidates
    };
  });
}
