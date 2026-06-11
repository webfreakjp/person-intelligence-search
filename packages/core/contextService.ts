import { z } from 'zod';
import { badRequest, notFound } from '../shared/errors.ts';
import type { PersonContextRow, PersonRelationshipRow } from '../shared/types.ts';
import { newId, now } from '../shared/utils.ts';
import type { AppContext } from './context.ts';
import { enqueueJob } from './jobService.ts';
import { getPersonOrThrow } from './personService.ts';

export const ContextPatchSchema = z
  .object({
    person_id: z.uuid().optional(),
    role: z.string().max(32).optional(),
    context_text: z.string().trim().min(1).max(4000).optional(),
    context_tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
    sentiment: z.enum(['positive', 'neutral', 'negative', 'mixed', 'unknown']).optional(),
    importance: z.number().min(0).max(1).optional(),
    evidence_text: z.string().trim().max(400).nullable().optional()
  })
  .refine((patch) => Object.values(patch).some((value) => value !== undefined), { message: 'at least one field is required' });

async function getContextOrThrow(ctx: AppContext, tenantId: string, contextId: string): Promise<PersonContextRow> {
  const context = await ctx.store.get('person_contexts', contextId);
  if (!context || context.tenant_id !== tenantId) throw notFound('context not found');
  return context;
}

/** Queues summary + search-document refresh for the given persons. */
async function refreshDerivedData(ctx: AppContext, tenantId: string, personIds: string[]): Promise<void> {
  for (const personId of new Set(personIds)) {
    await enqueueJob(ctx, tenantId, 'summary_update', { personId });
  }
}

/** Adds a person to the source's exclusion list so reprocessing keeps the manual decision. */
async function excludePersonFromSource(ctx: AppContext, tenantId: string, sourceId: string, personId: string): Promise<void> {
  const source = await ctx.store.get('source_documents', sourceId);
  if (!source || source.tenant_id !== tenantId) return;
  const excluded = new Set(Array.isArray(source.metadata.excluded_person_ids) ? (source.metadata.excluded_person_ids as string[]) : []);
  if (excluded.has(personId)) return;
  excluded.add(personId);
  await ctx.store.update('source_documents', source.id, {
    metadata: { ...source.metadata, excluded_person_ids: [...excluded] }
  });
}

/**
 * Manual correction of an extracted context: edit text/tags/sentiment/role or
 * reassign it to another person. Edited contexts are flagged and survive
 * source reprocessing; on reassignment, the previous person is excluded from
 * future automatic linking for that source.
 */
export async function updateContext(
  ctx: AppContext,
  tenantId: string,
  contextId: string,
  patch: z.infer<typeof ContextPatchSchema>
): Promise<PersonContextRow> {
  const context = await getContextOrThrow(ctx, tenantId, contextId);
  const affected = [context.person_id];

  const update: Partial<PersonContextRow> = {
    metadata: { ...context.metadata, manually_edited: true, edited_at: now() } as PersonContextRow['metadata']
  };
  if (patch.person_id && patch.person_id !== context.person_id) {
    await getPersonOrThrow(ctx, tenantId, patch.person_id);
    update.person_id = patch.person_id;
    affected.push(patch.person_id);
    await excludePersonFromSource(ctx, tenantId, context.source_id, context.person_id);
  }
  if (patch.role !== undefined) update.role = patch.role;
  if (patch.context_tags !== undefined) update.context_tags = patch.context_tags;
  if (patch.sentiment !== undefined) update.sentiment = patch.sentiment;
  if (patch.importance !== undefined) update.importance = patch.importance;
  if (patch.evidence_text !== undefined) update.evidence_text = patch.evidence_text;
  if (patch.context_text !== undefined && patch.context_text !== context.context_text) {
    update.context_text = patch.context_text;
    update.context_embedding = await ctx.embeddings.embedOne(patch.context_text);
  }

  const updated = await ctx.store.update('person_contexts', context.id, update);
  await refreshDerivedData(ctx, tenantId, affected);
  const { context_embedding: _omit, ...rest } = updated as PersonContextRow;
  return rest as PersonContextRow;
}

/**
 * Deletes a context. With `excludePerson` the person is also excluded from
 * future automatic linking for that source (use when the link itself was wrong).
 */
export async function deleteContext(ctx: AppContext, tenantId: string, contextId: string, { excludePerson = false } = {}): Promise<void> {
  const context = await getContextOrThrow(ctx, tenantId, contextId);
  await ctx.store.remove('person_contexts', context.id);
  if (excludePerson) await excludePersonFromSource(ctx, tenantId, context.source_id, context.person_id);
  await refreshDerivedData(ctx, tenantId, [context.person_id]);
}

export const RelationshipCreateSchema = z.object({
  related_person_id: z.uuid(),
  relationship_type: z.string().trim().min(1).max(64),
  confidence: z.number().min(0).max(1).optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

/** Creates a relationship (e.g. member_of with metadata.role for group members). */
export async function createRelationship(
  ctx: AppContext,
  tenantId: string,
  personId: string,
  input: z.infer<typeof RelationshipCreateSchema>
) {
  await getPersonOrThrow(ctx, tenantId, personId);
  await getPersonOrThrow(ctx, tenantId, input.related_person_id);
  if (personId === input.related_person_id) throw badRequest('cannot relate a person to themselves');
  const existing = await ctx.store.findOne('person_relationships', {
    tenant_id: tenantId,
    person_id: personId,
    related_person_id: input.related_person_id,
    relationship_type: input.relationship_type
  });
  if (existing) return existing;
  return ctx.store.insert('person_relationships', {
    id: newId(),
    tenant_id: tenantId,
    person_id: personId,
    related_person_id: input.related_person_id,
    related_organization_id: null,
    relationship_type: input.relationship_type,
    source_id: null,
    confidence: input.confidence ?? 1,
    metadata: (input.metadata ?? {}) as PersonRelationshipRow['metadata'],
    created_at: now()
  });
}

/** Lists relationships in both directions with display names resolved. */
export async function listRelationships(ctx: AppContext, tenantId: string, personId: string) {
  await getPersonOrThrow(ctx, tenantId, personId);
  const [outgoing, incoming] = await Promise.all([
    ctx.store.find('person_relationships', { tenant_id: tenantId, person_id: personId }),
    ctx.store.find('person_relationships', { tenant_id: tenantId, related_person_id: personId })
  ]);
  const otherIds = [...outgoing.map((rel) => rel.related_person_id), ...incoming.map((rel) => rel.person_id)].filter((id): id is string =>
    Boolean(id)
  );
  const persons = await ctx.store.hydratePersons(tenantId, [...new Set(otherIds)]);
  const nameOf = (id: string | null) => (id ? (persons.get(id)?.display_name ?? persons.get(id)?.canonical_name ?? null) : null);
  return [
    ...outgoing.map((rel) => ({
      ...rel,
      direction: 'outgoing' as const,
      other_person_id: rel.related_person_id,
      other_person_name: nameOf(rel.related_person_id)
    })),
    ...incoming.map((rel) => ({
      ...rel,
      direction: 'incoming' as const,
      other_person_id: rel.person_id,
      other_person_name: nameOf(rel.person_id)
    }))
  ];
}

export async function deleteRelationship(ctx: AppContext, tenantId: string, relationshipId: string): Promise<void> {
  const relationship = await ctx.store.get('person_relationships', relationshipId);
  if (!relationship || relationship.tenant_id !== tenantId) throw notFound('relationship not found');
  await ctx.store.remove('person_relationships', relationship.id);
}
