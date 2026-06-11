import { z } from 'zod';
import { FIELD_TYPES } from '../schemas/fieldTypes.ts';
import type { ErrorDetail } from '../shared/errors.ts';
import type { FieldDefinitionRow, Json } from '../shared/types.ts';

export const OPERATORS = [
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'between',
  'contains',
  'contains_any',
  'contains_all',
  'exists',
  'not_exists',
  'in',
  'not_in'
] as const;
export type Operator = (typeof OPERATORS)[number];

const COMPARISON: Operator[] = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between'];
const SEMANTIC_FIELDS = ['core.profile_text', 'core.person_summaries', 'core.person_contexts', 'core.search_document'];
const RANKINGS = ['semantic_similarity', 'sns_reach', 'recent_relevance', 'full_text'];
const PLATFORM_PATTERN = /^[a-z0-9_]{1,32}$/;

// Core searchable fields and the operators each accepts.
const CORE_FIELDS: Record<string, Operator[]> = {
  'core.person.canonical_name': ['eq', 'neq', 'contains', 'in'],
  'core.person.display_name': ['eq', 'neq', 'contains'],
  'core.person.person_type': ['eq', 'neq', 'in', 'not_in'],
  'core.person.status': ['eq', 'in'],
  'core.alias.alias': ['eq', 'contains'],
  'core.context.context_tags': ['contains', 'contains_any', 'contains_all'],
  'core.context.sentiment': ['eq', 'neq', 'in'],
  'core.context.occurred_at': ['gt', 'gte', 'lt', 'lte', 'between'],
  'core.summary.summary_tags': ['contains', 'contains_any', 'contains_all']
};

export type ResolvedField =
  | { kind: 'core'; operators: Operator[] }
  | { kind: 'sns_account'; platform: string; operators: Operator[] }
  | { kind: 'sns_metric'; platform: string; metric: string; operators: Operator[] }
  | { kind: 'custom'; definition: FieldDefinitionRow; operators: Operator[] };

export interface DslFilter {
  field: string;
  op: Operator;
  value: Json | null;
  resolved: ResolvedField;
}

export interface DslSemantic {
  fields: string[];
  query: string;
}

export interface DslTimeRange {
  field: 'person_contexts.occurred_at';
  relative?: 'recent_7d' | 'recent_30d' | 'recent_90d';
  from?: string | null;
  to?: string | null;
}

export interface SearchDsl {
  target: 'person';
  filters: DslFilter[];
  semantic: DslSemantic[];
  time_range: DslTimeRange | null;
  ranking: string[];
  limit: number;
  offset: number;
}

const RawDslSchema = z.object({
  target: z.literal('person').optional(),
  filters: z.array(z.looseObject({ field: z.string(), op: z.string(), value: z.unknown().optional() })).optional(),
  semantic: z.array(z.looseObject({ fields: z.array(z.string()).optional(), query: z.string() })).optional(),
  time_range: z
    .looseObject({
      field: z.string().optional(),
      relative: z.string().optional(),
      from: z.string().optional(),
      to: z.string().optional()
    })
    .nullish(),
  ranking: z.array(z.string()).optional(),
  limit: z.coerce.number().optional(),
  offset: z.coerce.number().optional(),
  query: z.string().optional()
});

function resolveField(field: string, customFields: Map<string, FieldDefinitionRow>): ResolvedField | { error: string } {
  const core = CORE_FIELDS[field];
  if (core) return { kind: 'core', operators: core };
  const snsMetric = field.match(/^core\.sns\.([a-z0-9_]+)\.(follower_count|following_count|post_count|engagement_rate)$/);
  if (snsMetric?.[1] && snsMetric[2] && PLATFORM_PATTERN.test(snsMetric[1])) {
    return { kind: 'sns_metric', platform: snsMetric[1], metric: snsMetric[2], operators: COMPARISON };
  }
  const snsAccount = field.match(/^core\.sns\.([a-z0-9_]+)$/);
  if (snsAccount?.[1] && PLATFORM_PATTERN.test(snsAccount[1])) {
    return { kind: 'sns_account', platform: snsAccount[1], operators: ['exists', 'not_exists'] };
  }
  const custom = field.match(/^custom\.([a-z][a-z0-9_]{0,63})$/);
  if (custom?.[1]) {
    const definition = customFields.get(custom[1]);
    if (!definition) return { error: `unknown custom field: ${custom[1]}` };
    if (!definition.filterable) return { error: `custom field is not filterable: ${custom[1]}` };
    return { kind: 'custom', definition, operators: (FIELD_TYPES[definition.type]?.operators ?? []) as Operator[] };
  }
  return { error: `unknown field: ${field}` };
}

function validateValue(op: Operator, value: unknown, push: (message: string) => void): void {
  if (op === 'exists' || op === 'not_exists') return;
  if (op === 'between') {
    if (!Array.isArray(value) || value.length !== 2) push('between requires a [min, max] array');
    return;
  }
  if (['in', 'not_in', 'contains_any', 'contains_all'].includes(op)) {
    if (!Array.isArray(value) || !value.length) push(`${op} requires a non-empty array`);
    return;
  }
  if (value == null || typeof value === 'object') push(`${op} requires a scalar value`);
}

export interface DslValidationResult {
  dsl: SearchDsl | null;
  errors: ErrorDetail[];
}

// Validates and normalizes a Search DSL document against core fields and the
// tenant's custom field definitions.
export function validateDsl(input: unknown, fieldDefinitions: FieldDefinitionRow[] = []): DslValidationResult {
  const errors: ErrorDetail[] = [];
  const push = (message: string, at = 'dsl') => errors.push({ field: at, message });

  const parsed = RawDslSchema.safeParse(input);
  if (!parsed.success) {
    return { dsl: null, errors: parsed.error.issues.map((issue) => ({ field: issue.path.join('.') || 'dsl', message: issue.message })) };
  }
  const raw = parsed.data;
  const customFields = new Map(fieldDefinitions.map((definition) => [definition.key, definition]));
  const dsl: SearchDsl = { target: 'person', filters: [], semantic: [], time_range: null, ranking: [], limit: 20, offset: 0 };

  for (const [index, filter] of (raw.filters ?? []).entries()) {
    const at = `filters[${index}]`;
    const op = filter.op as Operator;
    if (!OPERATORS.includes(op)) {
      push(`unsupported operator: ${filter.op}`, at);
      continue;
    }
    const resolved = resolveField(filter.field, customFields);
    if ('error' in resolved) {
      push(resolved.error, at);
      continue;
    }
    if (!resolved.operators.includes(op)) {
      push(`operator ${op} is not supported for ${filter.field}`, at);
      continue;
    }
    validateValue(op, filter.value, (message) => push(message, at));
    dsl.filters.push({ field: filter.field, op, value: (filter.value ?? null) as Json | null, resolved });
  }

  for (const [index, entry] of (raw.semantic ?? []).slice(0, 3).entries()) {
    const query = entry.query.trim();
    if (!query) {
      push('query is required', `semantic[${index}]`);
      continue;
    }
    const fields = (entry.fields ?? []).filter((field) => SEMANTIC_FIELDS.includes(field));
    dsl.semantic.push({ fields: fields.length ? fields : ['core.search_document'], query: query.slice(0, 1000) });
  }

  if (raw.time_range != null) {
    const range = raw.time_range;
    const field = range.field ?? 'person_contexts.occurred_at';
    if (field !== 'person_contexts.occurred_at') push('time_range.field must be person_contexts.occurred_at', 'time_range');
    else if (range.relative != null) {
      if (!['recent_7d', 'recent_30d', 'recent_90d'].includes(range.relative)) {
        push('time_range.relative must be recent_7d|recent_30d|recent_90d', 'time_range');
      } else dsl.time_range = { field, relative: range.relative as DslTimeRange['relative'] };
    } else if (range.from || range.to) {
      const from = range.from ? new Date(range.from) : null;
      const to = range.to ? new Date(range.to) : null;
      if ((from && Number.isNaN(from.getTime())) || (to && Number.isNaN(to.getTime()))) {
        push('time_range.from/to must be ISO timestamps', 'time_range');
      } else dsl.time_range = { field, from: from?.toISOString() ?? null, to: to?.toISOString() ?? null };
    } else push('time_range requires relative or from/to', 'time_range');
  }

  const ranking = (raw.ranking ?? []).filter((entry) => RANKINGS.includes(entry));
  dsl.ranking = ranking.length ? ranking : ['semantic_similarity', 'recent_relevance'];
  dsl.limit = Number.isFinite(raw.limit) ? Math.min(100, Math.max(1, Math.trunc(raw.limit as number))) : 20;
  dsl.offset = Number.isFinite(raw.offset) ? Math.max(0, Math.trunc(raw.offset as number)) : 0;

  return { dsl: errors.length ? null : dsl, errors };
}

export function describeSearchableFields(fieldDefinitions: FieldDefinitionRow[] = []) {
  return {
    core: [
      ...Object.entries(CORE_FIELDS).map(([field, operators]) => ({ field, operators })),
      { field: 'core.sns.{platform}', operators: ['exists', 'not_exists'] },
      { field: 'core.sns.{platform}.follower_count', operators: COMPARISON },
      { field: 'core.sns.{platform}.engagement_rate', operators: COMPARISON }
    ],
    custom: fieldDefinitions
      .filter((definition) => definition.filterable)
      .map((definition) => ({
        field: `custom.${definition.key}`,
        label: definition.label,
        type: definition.type,
        operators: FIELD_TYPES[definition.type]?.operators ?? []
      }))
  };
}

// Serializable form (without resolved internals) for API responses.
export function presentDsl(dsl: SearchDsl) {
  return {
    target: dsl.target,
    filters: dsl.filters.map(({ field, op, value }) => ({ field, op, value })),
    semantic: dsl.semantic,
    time_range: dsl.time_range,
    ranking: dsl.ranking,
    limit: dsl.limit,
    offset: dsl.offset
  };
}
