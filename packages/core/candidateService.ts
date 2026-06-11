import { FIELD_TYPES, fieldValueText } from '../schemas/fieldTypes.ts';
import { badRequest, notFound } from '../shared/errors.ts';
import type { FieldCandidateRow, PersonCandidateRow } from '../shared/types.ts';
import { newId, normalizeText, now } from '../shared/utils.ts';
import type { AppContext } from './context.ts';
import { enqueueJob } from './jobService.ts';
import { getPersonOrThrow, rebuildSearchDocument } from './personService.ts';

async function getPersonCandidateOrThrow(ctx: AppContext, tenantId: string, candidateId: string): Promise<PersonCandidateRow> {
  const candidate = await ctx.store.get('person_candidates', candidateId);
  if (!candidate || candidate.tenant_id !== tenantId) throw notFound('person candidate not found');
  return candidate;
}

/** Links a pending mention to an existing person and reprocesses its source. */
export async function linkPersonCandidate(ctx: AppContext, tenantId: string, candidateId: string, personId: string) {
  const candidate = await getPersonCandidateOrThrow(ctx, tenantId, candidateId);
  if (candidate.status !== 'pending') throw badRequest(`candidate is ${candidate.status}`);
  const person = await getPersonOrThrow(ctx, tenantId, personId);

  const existingAlias = await ctx.store.findOne('person_aliases', {
    tenant_id: tenantId,
    person_id: person.id,
    normalized_alias: normalizeText(candidate.mention)
  });
  if (!existingAlias) {
    await ctx.store.insert('person_aliases', {
      id: newId(),
      tenant_id: tenantId,
      person_id: person.id,
      alias: candidate.mention,
      normalized_alias: normalizeText(candidate.mention),
      alias_type: 'nickname',
      language: null,
      confidence: candidate.confidence ?? 0.7,
      source_id: candidate.source_id,
      metadata: { from_candidate_id: candidate.id },
      created_at: now()
    });
  }
  const updated = await ctx.store.update('person_candidates', candidate.id, {
    status: 'linked',
    metadata: { ...candidate.metadata, linked_person_id: person.id }
  });
  if (candidate.source_id) await enqueueJob(ctx, tenantId, 'document_processing', { sourceId: candidate.source_id });
  return updated;
}

export async function createPersonFromCandidate(
  ctx: AppContext,
  tenantId: string,
  candidateId: string,
  overrides: { canonical_name?: string; person_type?: string } = {}
) {
  const candidate = await getPersonCandidateOrThrow(ctx, tenantId, candidateId);
  if (candidate.status !== 'pending') throw badRequest(`candidate is ${candidate.status}`);
  const timestamp = now();
  const name = overrides.canonical_name?.trim() || candidate.mention;
  const person = await ctx.store.insert('persons', {
    id: newId(),
    tenant_id: tenantId,
    canonical_name: name,
    display_name: name,
    person_type: overrides.person_type ?? null,
    status: 'active',
    metadata: { created_from_candidate_id: candidate.id },
    created_at: timestamp,
    updated_at: timestamp
  });
  await ctx.store.insert('person_aliases', {
    id: newId(),
    tenant_id: tenantId,
    person_id: person.id,
    alias: name,
    normalized_alias: normalizeText(name),
    alias_type: 'canonical',
    language: null,
    confidence: 1,
    source_id: candidate.source_id,
    metadata: {},
    created_at: timestamp
  });
  if (normalizeText(candidate.mention) !== normalizeText(name)) {
    await ctx.store.insert('person_aliases', {
      id: newId(),
      tenant_id: tenantId,
      person_id: person.id,
      alias: candidate.mention,
      normalized_alias: normalizeText(candidate.mention),
      alias_type: 'nickname',
      language: null,
      confidence: candidate.confidence ?? 0.7,
      source_id: candidate.source_id,
      metadata: {},
      created_at: timestamp
    });
  }
  const updated = await ctx.store.update('person_candidates', candidate.id, {
    status: 'created',
    metadata: { ...candidate.metadata, created_person_id: person.id }
  });
  if (candidate.source_id) await enqueueJob(ctx, tenantId, 'document_processing', { sourceId: candidate.source_id });
  return { candidate: updated, person };
}

export async function rejectPersonCandidate(ctx: AppContext, tenantId: string, candidateId: string) {
  const candidate = await getPersonCandidateOrThrow(ctx, tenantId, candidateId);
  if (candidate.status !== 'pending') throw badRequest(`candidate is ${candidate.status}`);
  return ctx.store.update('person_candidates', candidate.id, { status: 'rejected' });
}

async function getFieldCandidateOrThrow(ctx: AppContext, tenantId: string, candidateId: string): Promise<FieldCandidateRow> {
  const candidate = await ctx.store.get('extracted_field_candidates', candidateId);
  if (!candidate || candidate.tenant_id !== tenantId) throw notFound('field candidate not found');
  return candidate;
}

/** Applies a pending/conflict candidate as the person's field value. */
export async function applyFieldCandidate(ctx: AppContext, tenantId: string, candidateId: string) {
  const candidate = await getFieldCandidateOrThrow(ctx, tenantId, candidateId);
  if (!['pending', 'conflict'].includes(candidate.status)) throw badRequest(`candidate is ${candidate.status}`);
  if (!candidate.person_id) throw badRequest('candidate has no person');
  const definition = await ctx.store.get('field_definitions', candidate.field_definition_id);
  if (!definition) throw notFound('field definition no longer exists');

  const replaced = await ctx.store.find('person_field_values', {
    tenant_id: tenantId,
    person_id: candidate.person_id,
    field_definition_id: candidate.field_definition_id
  });
  for (const value of replaced) await ctx.store.remove('person_field_values', value.id);

  const columns = {
    value_text: candidate.value_text,
    value_number: candidate.value_number,
    value_boolean: candidate.value_boolean,
    value_date: candidate.value_date,
    value_json: candidate.value_json
  };
  await ctx.store.insert('person_field_values', {
    id: newId(),
    tenant_id: tenantId,
    person_id: candidate.person_id,
    field_definition_id: candidate.field_definition_id,
    ...columns,
    value_vector_text: definition.embedding_target ? fieldValueText(definition, columns) : null,
    source_id: candidate.source_id,
    confidence: candidate.confidence,
    metadata: { applied_from_candidate_id: candidate.id },
    updated_at: now()
  });

  // Other open candidates for the same field become superseded.
  const siblings = await ctx.store.find('extracted_field_candidates', {
    tenant_id: tenantId,
    person_id: candidate.person_id,
    field_definition_id: candidate.field_definition_id
  });
  for (const sibling of siblings) {
    if (sibling.id !== candidate.id && ['pending', 'conflict'].includes(sibling.status)) {
      await ctx.store.update('extracted_field_candidates', sibling.id, { status: 'superseded' });
    }
  }
  const updated = await ctx.store.update('extracted_field_candidates', candidate.id, {
    status: 'applied',
    metadata: { ...candidate.metadata, applied_at: now() }
  });
  await rebuildSearchDocument(ctx, tenantId, candidate.person_id);
  return updated;
}

export async function rejectFieldCandidate(ctx: AppContext, tenantId: string, candidateId: string) {
  const candidate = await getFieldCandidateOrThrow(ctx, tenantId, candidateId);
  if (!['pending', 'conflict'].includes(candidate.status)) throw badRequest(`candidate is ${candidate.status}`);
  return ctx.store.update('extracted_field_candidates', candidate.id, { status: 'rejected' });
}

export function presentFieldCandidate(candidate: FieldCandidateRow, definitionType: string | undefined) {
  const column = definitionType ? FIELD_TYPES[definitionType]?.column : undefined;
  return { ...candidate, value: column ? candidate[column] : null };
}
