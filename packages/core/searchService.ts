import { type SearchDsl, presentDsl, validateDsl } from '../search/dsl.ts';
import { fuseScores, type ScoreParts } from '../search/fusion.ts';
import { parseQuery } from '../search/parser.ts';
import { badRequest } from '../shared/errors.ts';
import type { SearchResultItem } from '../shared/types.ts';
import type { AppContext } from './context.ts';

function humanizeFilter(filter: SearchDsl['filters'][number]): string {
  const field = filter.field.replace(/^core\./, '');
  if (filter.op === 'exists') return `${field} exists`;
  if (filter.op === 'not_exists') return `${field} does not exist`;
  return `${field} ${filter.op} ${JSON.stringify(filter.value)}`;
}

export interface SearchExecution {
  results: SearchResultItem[];
  total_matched: number;
  dsl: ReturnType<typeof presentDsl>;
  search_capabilities: { structured: boolean; vector: boolean; full_text: boolean };
  fusion_weights: Record<string, number>;
  warnings: string[];
}

/**
 * Execution flow: structured filtering constrains the candidate set
 * (AND semantics); vector + optional PGroonga full-text scores rank it; spec
 * 10.7 weights fuse the parts. The LLM never produces results directly.
 */
export async function executeSearch(ctx: AppContext, tenantId: string, dsl: SearchDsl, warnings: string[] = []): Promise<SearchExecution> {
  const capabilities = await ctx.store.capabilities();
  const fullText = capabilities.full_text.enabled;
  if (!fullText) warnings = [...warnings, 'Full-text search is disabled because PGroonga is not installed.'];

  const filteredIds = await ctx.store.filterPersonIds(tenantId, dsl.filters, dsl.time_range);
  const semanticQuery = dsl.semantic
    .map((entry) => entry.query)
    .join('\n')
    .trim();
  const poolSize = Math.max(50, dsl.offset + dsl.limit);

  const vectorHits = semanticQuery
    ? await ctx.store.vectorSearchPersons(tenantId, await ctx.embeddings.embedOne(semanticQuery), {
        limit: poolSize,
        restrictTo: filteredIds
      })
    : [];
  const fullTextHits = semanticQuery
    ? await ctx.store.fullTextSearchPersons(tenantId, semanticQuery, { limit: poolSize, restrictTo: filteredIds })
    : [];

  const vectorById = new Map(vectorHits.map((hit) => [hit.person_id, hit.similarity ?? 0]));
  const fullTextById = new Map(fullTextHits.map((hit) => [hit.person_id, hit.score ?? 0]));

  let universe: string[];
  if (filteredIds) universe = filteredIds;
  else if (semanticQuery) universe = [...new Set([...vectorById.keys(), ...fullTextById.keys()])];
  else universe = (await ctx.store.searchPersonsByName(tenantId, '', poolSize)).results.map((person) => person.id);

  // structured_score: 1.0 when explicit structured constraints matched,
  // 0.5 neutral baseline otherwise (keeps pure-semantic scores comparable).
  const structuredScore = filteredIds ? 1 : 0.5;
  const parts = new Map<string, ScoreParts>();
  for (const personId of universe) {
    parts.set(personId, {
      structured: structuredScore,
      vector: vectorById.get(personId) ?? 0,
      full_text: fullTextById.get(personId) ?? 0
    });
  }
  const { fused, weights } = fuseScores(parts, fullText);
  const ranked = [...fused.entries()].sort((a, b) => b[1] - a[1]);
  const page = ranked.slice(dsl.offset, dsl.offset + dsl.limit).map(([personId]) => personId);

  const [hydrated, contexts] = await Promise.all([
    ctx.store.hydratePersons(tenantId, page),
    ctx.store.topContextsForPersons(tenantId, page, { timeRange: dsl.time_range, perPerson: 3 })
  ]);

  const filterReasons = dsl.filters.map(humanizeFilter);
  if (dsl.time_range)
    filterReasons.push(`has context within ${dsl.time_range.relative ?? `${dsl.time_range.from ?? ''}..${dsl.time_range.to ?? ''}`}`);

  const results: SearchResultItem[] = [];
  for (const personId of page) {
    const person = hydrated.get(personId);
    if (!person) continue;
    const part = parts.get(personId) ?? {};
    const reasons = [...(filteredIds ? filterReasons : [])];
    if ((part.vector ?? 0) > 0.05) reasons.push(`semantic similarity ${(part.vector ?? 0).toFixed(2)}`);
    if ((part.full_text ?? 0) > 0) reasons.push(`full-text match ${(part.full_text ?? 0).toFixed(2)}`);
    if (!reasons.length) reasons.push('listing match');
    results.push({
      person_id: personId,
      display_name: person.display_name ?? person.canonical_name,
      score: fused.get(personId) ?? 0,
      score_parts: { structured: part.structured, vector: part.vector, ...(fullText ? { full_text: part.full_text } : {}) },
      matched_reasons: reasons,
      matched_contexts: contexts.get(personId) ?? [],
      person
    });
  }

  return {
    results,
    total_matched: universe.length,
    dsl: presentDsl(dsl),
    search_capabilities: { structured: true, vector: true, full_text: fullText },
    fusion_weights: weights,
    warnings
  };
}

export interface SearchRequestInput {
  query?: string;
  dsl?: unknown;
}

export async function searchPersons(
  ctx: AppContext,
  tenantId: string,
  input: SearchRequestInput
): Promise<SearchExecution & { parser?: string }> {
  const fieldDefinitions = await ctx.store.find('field_definitions', { tenant_id: tenantId });
  if (input.dsl != null) {
    const { dsl, errors } = validateDsl(input.dsl, fieldDefinitions);
    if (!dsl) throw badRequest('invalid Search DSL', errors);
    return executeSearch(ctx, tenantId, dsl);
  }
  const query = String(input.query ?? '').trim();
  if (!query) throw badRequest('either query or dsl is required');
  const knownTags = await ctx.store.distinctTags(tenantId);
  const parsed = await parseQuery(ctx.llm, query, fieldDefinitions, { knownTags });
  const execution = await executeSearch(ctx, tenantId, parsed.dsl, parsed.warnings);
  return { ...execution, parser: parsed.parser };
}

export async function parseSearchQuery(ctx: AppContext, tenantId: string, query: string) {
  const [fieldDefinitions, knownTags] = await Promise.all([
    ctx.store.find('field_definitions', { tenant_id: tenantId }),
    ctx.store.distinctTags(tenantId)
  ]);
  const parsed = await parseQuery(ctx.llm, query, fieldDefinitions, { knownTags });
  return { dsl: presentDsl(parsed.dsl), parser: parsed.parser, warnings: parsed.warnings };
}
