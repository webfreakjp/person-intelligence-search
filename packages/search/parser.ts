import { z } from 'zod';
import type { LlmProvider } from '../llm/index.ts';
import { ApiError } from '../shared/errors.ts';
import type { FieldDefinitionRow } from '../shared/types.ts';
import { describeSearchableFields, presentDsl, type SearchDsl, validateDsl } from './dsl.ts';

const LlmDslSchema = z.looseObject({});

export interface ParseOptions {
  /** Existing context/summary tag vocabulary; tag filters must use these values. */
  knownTags?: string[];
}

function llmParsePrompt(query: string, fieldDefinitions: FieldDefinitionRow[], options: ParseOptions) {
  const fields = describeSearchableFields(fieldDefinitions);
  const knownTags = options.knownTags ?? [];
  return {
    system: [
      'You translate a natural-language people-search query into a JSON Search DSL.',
      'Never invent people or answer the query yourself; only produce the DSL.',
      'DSL shape: {"target":"person","filters":[{"field","op","value"}],"semantic":[{"fields":["core.search_document"],"query":"..."}],"time_range":{"field":"person_contexts.occurred_at","relative":"recent_90d"},"ranking":["semantic_similarity","sns_reach","recent_relevance"]}.',
      'Use only these fields and operators:',
      JSON.stringify(fields),
      knownTags.length
        ? `core.context.context_tags / core.summary.summary_tags filters may ONLY use values from this existing tag vocabulary: ${JSON.stringify(knownTags)}. If the topic does not map clearly to one of these tags, express it in semantic[].query instead of a tag filter.`
        : 'Do not use core.context.context_tags / core.summary.summary_tags filters; express topical intent in semantic[].query.',
      'Put everything that is not a precise structured condition into semantic[].query (keep the original language).',
      'time_range.relative must be recent_7d, recent_30d or recent_90d; omit time_range when the query has no recency intent.',
      'Numbers like 100万 mean 1000000. Respond with the JSON object only.'
    ].join('\n'),
    user: `Query: ${query}`
  };
}

export interface ParseResult {
  dsl: SearchDsl;
  parser: string;
  warnings: string[];
}

/**
 * Natural language -> validated Search DSL. The LLM only plans the query
 * (query planning only, never answering); the DSL is validated against
 * core/custom fields before
 * execution. Invalid output gets one corrective retry, then the request
 * fails explicitly (no degraded heuristic fallback).
 */
export async function parseQuery(
  llm: LlmProvider,
  query: string,
  fieldDefinitions: FieldDefinitionRow[] = [],
  options: ParseOptions = {}
): Promise<ParseResult> {
  const prompt = llmParsePrompt(query, fieldDefinitions, options);
  let lastErrors = '';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let raw: unknown;
    try {
      raw = await llm.completeJson(
        {
          ...prompt,
          user: attempt === 0 ? prompt.user : `${prompt.user}\nYour previous DSL was invalid (${lastErrors}). Return a corrected DSL.`
        },
        LlmDslSchema
      );
    } catch (error) {
      throw new ApiError(502, 'LLM_PARSE_FAILED', `query parsing failed: ${(error as Error).message}`);
    }
    const { dsl, errors } = validateDsl(raw, fieldDefinitions);
    if (dsl) return { dsl, parser: llm.name, warnings: [] };
    lastErrors = errors.map((error) => `${error.field}: ${error.message}`).join('; ');
  }
  throw new ApiError(502, 'LLM_PARSE_FAILED', `query parsing produced an invalid Search DSL (${lastErrors})`);
}

export { presentDsl };
