import { z } from 'zod';
import type { LlmProvider } from '../llm/index.ts';
import type { FieldDefinitionRow } from '../shared/types.ts';
import { clamp } from '../shared/utils.ts';

// LLM extraction tasks. Outputs are schema-validated; the LLM never becomes
// the source of truth for search results (it only extracts/plans). Soft limits (lengths,
// list sizes, score ranges) are clamped instead of rejected so a verbose model
// answer does not fail the whole job; only structurally broken output fails
// and is retried by the job runner.

const softString = (max: number) => z.string().transform((value) => value.trim().slice(0, max));
const softTags = z
  .array(z.unknown())
  .catch([])
  .transform((tags) =>
    tags
      .map((tag) =>
        String(tag ?? '')
          .trim()
          .slice(0, 40)
      )
      .filter(Boolean)
      .slice(0, 10)
  );
const softScore = (fallback: number) =>
  z
    .number()
    .catch(fallback)
    .optional()
    .transform((value) => clamp(value ?? fallback, 0, 1));

function lenientList<T extends z.ZodType>(item: T, max: number) {
  return z
    .array(item.nullable().catch(null))
    .catch([])
    .transform((items) => items.filter((entry): entry is NonNullable<typeof entry> => entry != null).slice(0, max));
}

const MentionItem = z.object({ mention: softString(120), confidence: softScore(0.7) });
const MentionsSchema = z.object({ mentions: lenientList(MentionItem, 50) });

export async function llmExtractMentions(llm: LlmProvider, text: string): Promise<Array<{ mention: string; confidence: number }>> {
  const result = await llm.completeJson(
    {
      system:
        'Extract person names mentioned in the document. Return {"mentions":[{"mention":"...","confidence":0..1}]}. ' +
        'Only real person names that literally appear in the text; no organizations, no invented names.',
      user: text.slice(0, 12000)
    },
    MentionsSchema
  );
  return result.mentions.filter((mention) => mention.mention.length > 0);
}

const SENTIMENTS = ['positive', 'neutral', 'negative', 'mixed', 'unknown'] as const;

const ContextItem = z.object({
  person: z.string(),
  role: z.string().optional().catch(undefined),
  context_text: softString(2000),
  context_tags: softTags.optional(),
  sentiment: z.enum(SENTIMENTS).catch('unknown').optional(),
  importance: softScore(0.5),
  evidence_text: softString(400).optional()
});
const ContextSchema = z.object({ contexts: lenientList(ContextItem, 20) });

export interface LlmContext {
  person: string;
  role: string;
  context_text: string;
  context_tags: string[];
  sentiment: string;
  importance: number;
  evidence_text: string;
}

const ROLES = new Set([
  'main_subject',
  'actor',
  'speaker',
  'target',
  'mentioned_only',
  'related_person',
  'author',
  'critic',
  'criticized',
  'winner',
  'nominee',
  'victim',
  'suspect',
  'unknown'
]);

export async function llmExtractContexts(llm: LlmProvider, text: string, personNames: string[]): Promise<LlmContext[]> {
  if (!personNames.length) return [];
  const result = await llm.completeJson(
    {
      system: [
        'For each given person, describe how they appear in the document.',
        'Return {"contexts":[{"person":"<name from the list>","role":"main_subject|actor|speaker|target|mentioned_only|related_person|author|critic|criticized|winner|nominee|victim|suspect|unknown",',
        '"context_text":"person-specific summary of what the document says about them (same language as the document)",',
        '"context_tags":["topic tags in english snake_case"],"sentiment":"positive|neutral|negative|mixed|unknown",',
        '"importance":0..1,"evidence_text":"short verbatim quote from the document"}]}.',
        'Only include people from the provided list. evidence_text must be copied from the document.'
      ].join('\n'),
      user: `People: ${personNames.join(' / ')}\n---\n${text.slice(0, 12000)}`
    },
    ContextSchema
  );
  return result.contexts
    .filter((context) => personNames.includes(context.person) && context.context_text.length > 0)
    .map((context) => ({
      person: context.person,
      role: ROLES.has(context.role ?? '') ? (context.role as string) : 'unknown',
      context_text: context.context_text,
      context_tags: context.context_tags ?? [],
      sentiment: context.sentiment ?? 'unknown',
      importance: context.importance,
      evidence_text: context.evidence_text || context.context_text.slice(0, 200)
    }));
}

const SummarySchema = z.object({
  summary_text: softString(4000),
  summary_tags: softTags.optional()
});

export async function llmSummarize(
  llm: LlmProvider,
  personName: string,
  contextTexts: string[],
  windowLabel: string
): Promise<{ summary_text: string; summary_tags: string[] } | null> {
  if (!contextTexts.length) return null;
  const result = await llm.completeJson(
    {
      system:
        'Summarize what the provided source contexts say about the person. Stay strictly within the provided evidence; never add outside knowledge. ' +
        'Return {"summary_text":"...","summary_tags":["english_snake_case", ...]}. Use the same language as the contexts.',
      user: `Person: ${personName}\nWindow: ${windowLabel}\nContexts:\n${contextTexts.join('\n---\n').slice(0, 12000)}`
    },
    SummarySchema
  );
  if (!result.summary_text) return null;
  return { summary_text: result.summary_text, summary_tags: result.summary_tags ?? [] };
}

const FieldValueItem = z.object({
  field_key: z.string(),
  value: z.unknown(),
  confidence: softScore(0.6)
});
const FieldExtractionSchema = z.object({ values: lenientList(FieldValueItem, 30) });

export async function llmExtractFields(
  llm: LlmProvider,
  text: string,
  personName: string,
  definitions: FieldDefinitionRow[]
): Promise<Array<{ field_key: string; value: unknown; confidence: number }>> {
  if (!definitions.length) return [];
  const catalog = definitions.map((definition) => ({
    key: definition.key,
    label: definition.label,
    type: definition.type,
    description: definition.description ?? undefined,
    options: definition.options?.values ?? undefined,
    hints: definition.extraction_hints?.prompt ?? undefined
  }));
  const result = await llm.completeJson(
    {
      system: [
        'Extract values for the given custom field definitions from the document, for the given person only.',
        'Return {"values":[{"field_key":"...","value":...,"confidence":0..1}]}. Only include fields whose value is explicitly stated.',
        'Value formats: number -> number, boolean -> true/false, date -> "YYYY-MM-DD", enum -> one of options,',
        'enum_multi/tag_list -> array of strings, text/short_text/url -> string. Do not guess.'
      ].join('\n'),
      user: `Person: ${personName}\nFields: ${JSON.stringify(catalog)}\n---\n${text.slice(0, 12000)}`
    },
    FieldExtractionSchema
  );
  const known = new Set(definitions.map((definition) => definition.key));
  return result.values.filter((value) => known.has(value.field_key));
}
