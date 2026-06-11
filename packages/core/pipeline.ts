import { extractFollowerCounts, extractSnsHandles } from '../extraction/heuristics.ts';
import { llmExtractContexts, llmExtractFields, llmExtractMentions, llmSummarize } from '../extraction/llmTasks.ts';
import { FIELD_TYPES, coerceFieldValue, fieldValueText } from '../schemas/fieldTypes.ts';
import { config } from '../shared/config.ts';
import type { FieldDefinitionRow, PersonContextRow, PersonRow, ProcessingJobRow, SourceDocumentRow } from '../shared/types.ts';
import { clamp, detectLanguage, newId, normalizeText, now, relativeWindowStart, sha256, stripHtml } from '../shared/utils.ts';
import type { AppContext } from './context.ts';
import { addSnsAccount, rebuildSearchDocument, upsertProfile } from './personService.ts';

interface StepTrace {
  step: string;
  detail?: string;
}

export interface PipelineResult {
  linked_person_ids: string[];
  mention_count: number;
  candidate_count: number;
  context_count: number;
  steps: StepTrace[];
}

interface AliasIndexEntry {
  personId: string;
  alias: string;
}

async function buildAliasIndex(ctx: AppContext, tenantId: string): Promise<Map<string, AliasIndexEntry[]>> {
  const aliases = await ctx.store.find('person_aliases', { tenant_id: tenantId }, { limit: 50000 });
  const index = new Map<string, AliasIndexEntry[]>();
  for (const alias of aliases) {
    const key = alias.normalized_alias ?? normalizeText(alias.alias);
    if (!index.has(key)) index.set(key, []);
    const entries = index.get(key) as AliasIndexEntry[];
    if (!entries.some((entry) => entry.personId === alias.person_id)) {
      entries.push({ personId: alias.person_id, alias: alias.alias });
    }
  }
  return index;
}

/**
 * Full document processing pipeline:
 * normalize -> mentions -> entity linking -> contexts -> SNS -> custom fields
 * -> summaries -> search index. Steps are idempotent per source so reprocess
 * replaces previous derived rows. Extraction/summarization is LLM-based; LLM
 * failures fail the job and are retried with backoff by the job runner.
 */
export async function processDocumentJob(ctx: AppContext, job: ProcessingJobRow): Promise<PipelineResult> {
  const steps: StepTrace[] = [];
  const tenantId = job.tenant_id;
  if (!job.source_id) throw new Error('document_processing job has no source_id');
  const source = await ctx.store.get('source_documents', job.source_id);
  if (!source) throw new Error('source not found');
  await ctx.store.update('source_documents', source.id, { processing_status: 'processing' });

  // 1. NormalizeSource
  const payload = await ctx.store.get('source_payloads', source.id);
  let text = [source.title, source.body].filter(Boolean).join('\n');
  if (!source.body && payload?.raw_html) text = [source.title, stripHtml(payload.raw_html)].filter(Boolean).join('\n');
  text = text
    .normalize('NFKC')
    .replace(/[ \t]+/g, ' ')
    .trim();
  const language = source.language ?? detectLanguage(text);
  const contentHash = source.content_hash ?? sha256(text);
  await ctx.store.update('source_documents', source.id, { language, content_hash: contentHash });
  if (payload) await ctx.store.update('source_payloads', source.id, { extracted_text: text });
  steps.push({ step: 'normalize', detail: `${text.length} chars, language=${language ?? 'unknown'}` });

  // 2. ExtractPersonMentions (idempotent per source)
  await ctx.store.removeWhere('extracted_person_mentions', { tenant_id: tenantId, source_id: source.id });
  const aliasIndex = await buildAliasIndex(ctx, tenantId);
  const mentions = await llmExtractMentions(ctx.llm, text);
  for (const mention of mentions) {
    await ctx.store.insert('extracted_person_mentions', {
      id: newId(),
      tenant_id: tenantId,
      source_id: source.id,
      mention: mention.mention,
      normalized_mention: normalizeText(mention.mention),
      span_start: null,
      span_end: null,
      confidence: mention.confidence,
      metadata: { extractor: ctx.llm.name },
      created_at: now()
    });
  }
  steps.push({ step: 'extract_mentions', detail: `${mentions.length} mentions` });

  // 3. LinkPersons
  const targetIds = Array.isArray(source.metadata.target_person_ids) ? (source.metadata.target_person_ids as string[]) : [];
  const linked = new Set<string>();
  for (const id of targetIds) {
    const person = await ctx.store.get('persons', id);
    if (person && person.tenant_id === tenantId && person.status !== 'deleted') linked.add(id);
  }
  let candidateCount = 0;
  for (const mention of mentions) {
    const matches = aliasIndex.get(normalizeText(mention.mention)) ?? [];
    const personIds = [...new Set(matches.map((match) => match.personId))];

    // A reviewed candidate for this source+mention overrides automatic linking,
    // so reprocessing after review materializes the human decision.
    const existing = await ctx.store.findOne('person_candidates', {
      tenant_id: tenantId,
      source_id: source.id,
      normalized_mention: normalizeText(mention.mention)
    });
    if (existing?.status === 'rejected') continue;
    const resolvedId =
      existing?.status === 'linked'
        ? String(existing.metadata.linked_person_id ?? '')
        : existing?.status === 'created'
          ? String(existing.metadata.created_person_id ?? '')
          : '';
    if (resolvedId) {
      linked.add(resolvedId);
      continue;
    }

    if (personIds.length === 1) {
      linked.add(personIds[0] as string);
      continue;
    }
    if (personIds.length > 1 || !config.autoCreatePersons || mention.confidence < 0.8) {
      if (!existing && personIds.every((id) => !linked.has(id))) {
        await ctx.store.insert('person_candidates', {
          id: newId(),
          tenant_id: tenantId,
          mention: mention.mention,
          normalized_mention: normalizeText(mention.mention),
          source_id: source.id,
          candidate_person_ids: personIds,
          confidence: mention.confidence,
          status: 'pending',
          metadata: { ambiguous: personIds.length > 1 },
          created_at: now()
        });
        candidateCount += 1;
      }
      continue;
    }
    // auto-create (opt-in via AUTO_CREATE_PERSONS)
    const timestamp = now();
    const person = await ctx.store.insert('persons', {
      id: newId(),
      tenant_id: tenantId,
      canonical_name: mention.mention,
      display_name: mention.mention,
      person_type: null,
      status: 'active',
      metadata: { auto_created_from_source_id: source.id },
      created_at: timestamp,
      updated_at: timestamp
    });
    await ctx.store.insert('person_aliases', {
      id: newId(),
      tenant_id: tenantId,
      person_id: person.id,
      alias: mention.mention,
      normalized_alias: normalizeText(mention.mention),
      alias_type: 'canonical',
      language,
      confidence: mention.confidence,
      source_id: source.id,
      metadata: {},
      created_at: timestamp
    });
    linked.add(person.id);
  }
  // Manual reassignments record an exclusion on the source; that decision
  // overrides automatic linking on reprocess.
  const excludedIds = new Set(Array.isArray(source.metadata.excluded_person_ids) ? (source.metadata.excluded_person_ids as string[]) : []);
  for (const id of excludedIds) linked.delete(id);

  const linkedPersons: PersonRow[] = [];
  for (const id of linked) {
    const person = await ctx.store.get('persons', id);
    if (person) linkedPersons.push(person);
  }
  steps.push({ step: 'link_persons', detail: `${linkedPersons.length} linked, ${candidateCount} candidates` });

  // 4. ExtractPersonContexts — idempotent per source, but manually edited
  // contexts are preserved (their persons are skipped instead of re-extracted).
  const previousContexts = await ctx.store.find('person_contexts', { tenant_id: tenantId, source_id: source.id });
  const preservedPersonIds = new Set<string>();
  for (const previous of previousContexts) {
    if (previous.metadata.manually_edited) preservedPersonIds.add(previous.person_id);
    else await ctx.store.remove('person_contexts', previous.id);
  }
  const occurredAt = source.published_at ?? source.received_at;
  const personName = (person: PersonRow) => person.display_name ?? person.canonical_name;
  const extractTargets = linkedPersons.filter((person) => !preservedPersonIds.has(person.id));
  const llmContexts = extractTargets.length ? await llmExtractContexts(ctx.llm, text, extractTargets.map(personName)) : [];
  let contextCount = 0;
  for (const person of extractTargets) {
    const extracted = llmContexts.find((context) => context.person === personName(person));
    if (!extracted) continue; // the person does not actually appear in this source
    const isTarget = targetIds.includes(person.id);
    await ctx.store.insert('person_contexts', {
      id: newId(),
      tenant_id: tenantId,
      person_id: person.id,
      source_id: source.id,
      role: extracted.role,
      context_text: extracted.context_text,
      context_tags: extracted.context_tags,
      sentiment: extracted.sentiment,
      importance: isTarget ? Math.max(extracted.importance, 0.7) : extracted.importance,
      evidence_text: extracted.evidence_text,
      context_embedding: await ctx.embeddings.embedOne(extracted.context_text),
      occurred_at: occurredAt,
      metadata: { extractor: ctx.llm.name },
      created_at: now()
    });
    contextCount += 1;
  }
  steps.push({
    step: 'extract_contexts',
    detail: `${contextCount} contexts${preservedPersonIds.size ? `, ${preservedPersonIds.size} manually edited preserved` : ''}`
  });

  // 5. ExtractSNSAccountsAndMetrics — only when the source maps to exactly one
  // person; attaching handles found in multi-person sources is too error-prone.
  if (linkedPersons.length === 1) {
    const person = linkedPersons[0] as PersonRow;
    for (const hit of extractSnsHandles(text)) {
      await addSnsAccount(ctx, tenantId, person.id, { platform: hit.platform, handle: hit.handle }, source.id);
    }
    for (const hit of extractFollowerCounts(text)) {
      const account = await ctx.store.findOne('person_sns_accounts', {
        tenant_id: tenantId,
        person_id: person.id,
        platform: hit.platform
      });
      if (account) {
        await ctx.store.insert('person_sns_metrics', {
          id: newId(),
          tenant_id: tenantId,
          account_id: account.id,
          measured_at: occurredAt,
          follower_count: hit.follower_count,
          following_count: null,
          post_count: null,
          engagement_rate: null,
          metadata: { extractor: 'rule', source_id: source.id }
        });
      }
    }
    if (source.source_type === 'profile' && text && !(await ctx.store.get('person_profiles', person.id))?.profile_text) {
      await upsertProfile(ctx, tenantId, person.id, { profile_text: text.slice(0, 20000) });
    }
    steps.push({ step: 'extract_sns' });
  }

  // 6. ExtractUserDefinedFields
  const definitions = await ctx.store.find('field_definitions', { tenant_id: tenantId });
  if (definitions.length && linkedPersons.length) {
    let fieldCandidates = 0;
    for (const person of linkedPersons) {
      const values = await llmExtractFields(ctx.llm, text, personName(person), definitions);
      for (const value of values) {
        const definition = definitions.find((definition) => definition.key === value.field_key);
        if (!definition) continue;
        fieldCandidates += await recordFieldCandidate(ctx, tenantId, person.id, definition, value.value, value.confidence, source.id);
      }
    }
    steps.push({ step: 'extract_fields', detail: `${fieldCandidates} candidates` });
  }

  // 7+8. GeneratePersonSummaries (with embeddings)
  for (const person of linkedPersons) await regenerateSummaries(ctx, tenantId, person);
  steps.push({ step: 'summaries' });

  // 9. UpdateSearchIndex
  for (const person of linkedPersons) await rebuildSearchDocument(ctx, tenantId, person.id);
  steps.push({ step: 'search_index' });

  await ctx.store.update('source_documents', source.id, { processing_status: 'processed' });
  return {
    linked_person_ids: [...linked],
    mention_count: mentions.length,
    candidate_count: candidateCount,
    context_count: contextCount,
    steps
  };
}

/** Returns 1 when a candidate row was recorded, 0 when skipped as duplicate. */
async function recordFieldCandidate(
  ctx: AppContext,
  tenantId: string,
  personId: string,
  definition: FieldDefinitionRow,
  raw: unknown,
  confidence: number,
  sourceId: string
): Promise<number> {
  let columns: ReturnType<typeof coerceFieldValue>;
  try {
    columns = coerceFieldValue(definition, raw);
  } catch {
    return 0; // unparseable extraction; drop silently
  }
  const column = FIELD_TYPES[definition.type]?.column ?? 'value_text';
  const existingValues = await ctx.store.find('person_field_values', {
    tenant_id: tenantId,
    person_id: personId,
    field_definition_id: definition.id
  });
  const sameValue = existingValues.find((value) => JSON.stringify(value[column]) === JSON.stringify(columns[column]));
  if (sameValue) return 0;

  const conflicting = existingValues[0] ?? null;
  let status: string;
  if (conflicting) status = 'conflict';
  else if (confidence >= config.autoApplyConfidence) status = 'auto_applied';
  else status = 'pending';

  await ctx.store.insert('extracted_field_candidates', {
    id: newId(),
    tenant_id: tenantId,
    person_id: personId,
    field_definition_id: definition.id,
    source_id: sourceId,
    ...columns,
    confidence: clamp(confidence, 0, 1),
    status,
    conflict_with_value_id: conflicting?.id ?? null,
    metadata: {},
    created_at: now()
  });

  if (status === 'auto_applied') {
    await ctx.store.insert('person_field_values', {
      id: newId(),
      tenant_id: tenantId,
      person_id: personId,
      field_definition_id: definition.id,
      ...columns,
      value_vector_text: definition.embedding_target ? fieldValueText(definition, columns) : null,
      source_id: sourceId,
      confidence: clamp(confidence, 0, 1),
      metadata: { applied_by: 'pipeline' },
      updated_at: now()
    });
  }
  return 1;
}

const SUMMARY_WINDOWS: Array<{ type: string; window: string | null }> = [
  { type: 'overall', window: null },
  { type: 'recent_30d', window: 'recent_30d' }
];

export async function regenerateSummaries(ctx: AppContext, tenantId: string, person: PersonRow): Promise<void> {
  const personName = person.display_name ?? person.canonical_name;
  const allContexts = await ctx.store.find(
    'person_contexts',
    { tenant_id: tenantId, person_id: person.id },
    { orderBy: 'occurred_at', dir: 'desc', limit: 50 }
  );
  for (const { type, window } of SUMMARY_WINDOWS) {
    let contexts: PersonContextRow[] = allContexts;
    if (window) {
      const from = relativeWindowStart(window);
      contexts = allContexts.filter((context) => from && (context.occurred_at ?? context.created_at) >= from);
    }
    if (!contexts.length) continue;
    const texts = contexts.map((context) => context.context_text ?? '').filter(Boolean);
    const summary = await llmSummarize(ctx.llm, personName, texts, type);
    if (!summary) continue;
    await ctx.store.insert('person_summaries', {
      id: newId(),
      tenant_id: tenantId,
      person_id: person.id,
      summary_type: type,
      window: window ?? 'all',
      summary_text: summary.summary_text,
      summary_tags: summary.summary_tags,
      summary_embedding: await ctx.embeddings.embedOne(summary.summary_text),
      source_count: new Set(contexts.map((context) => context.source_id)).size,
      generated_at: now(),
      metadata: { generator: ctx.llm.name }
    });
  }
}
