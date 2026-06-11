import { z } from 'zod';
import { coerceFieldValue, fieldValueText, presentFieldValue } from '../schemas/fieldTypes.ts';
import { badRequest, notFound, validationError } from '../shared/errors.ts';
import type { FieldDefinitionRow, HydratedPerson, PersonRow, SnsAccountRow, SnsMetricRow } from '../shared/types.ts';
import { newId, normalizeText, now } from '../shared/utils.ts';
import type { AppContext } from './context.ts';

const MetadataSchema = z.record(z.string(), z.unknown()).default({});

export const SnsAccountInputSchema = z.object({
  platform: z
    .string()
    .min(1)
    .max(32)
    .transform((value) => normalizeText(value)),
  handle: z.string().max(120).optional(),
  url: z.string().max(500).optional(),
  display_name: z.string().max(200).optional(),
  bio: z.string().max(2000).optional(),
  verified: z.boolean().optional(),
  status: z.string().max(32).optional(),
  follower_count: z.coerce.number().int().nonnegative().optional(),
  following_count: z.coerce.number().int().nonnegative().optional(),
  post_count: z.coerce.number().int().nonnegative().optional(),
  engagement_rate: z.coerce.number().min(0).optional(),
  metadata: MetadataSchema.optional()
});

export const PersonCreateSchema = z.object({
  canonical_name: z.string().trim().min(1).max(200),
  display_name: z.string().trim().max(200).optional(),
  person_type: z.string().trim().max(64).optional(),
  status: z.enum(['active', 'inactive', 'unknown']).optional(),
  metadata: MetadataSchema.optional(),
  aliases: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
  profile: z.object({ short_bio: z.string().max(5000).optional(), profile_text: z.string().max(50000).optional() }).optional(),
  sns_accounts: z.array(SnsAccountInputSchema).max(20).optional()
});

export const PersonPatchSchema = z.object({
  canonical_name: z.string().trim().min(1).max(200).optional(),
  display_name: z.string().trim().max(200).nullable().optional(),
  person_type: z.string().trim().max(64).nullable().optional(),
  status: z.enum(['active', 'inactive', 'merged', 'deleted', 'unknown']).optional(),
  metadata: MetadataSchema.optional()
});

export const AliasInputSchema = z.object({
  alias: z.string().trim().min(1).max(200),
  alias_type: z.string().max(32).optional(),
  language: z.string().max(16).optional(),
  confidence: z.number().min(0).max(1).optional()
});

export const ProfilePatchSchema = z.object({
  short_bio: z.string().max(5000).nullable().optional(),
  profile_text: z.string().max(50000).nullable().optional()
});

export const MetricInputSchema = z.object({
  measured_at: z.iso.datetime({ offset: true }).optional(),
  follower_count: z.coerce.number().int().nonnegative().optional(),
  following_count: z.coerce.number().int().nonnegative().optional(),
  post_count: z.coerce.number().int().nonnegative().optional(),
  engagement_rate: z.coerce.number().min(0).optional(),
  metadata: MetadataSchema.optional()
});

export const FieldsPatchSchema = z.object({
  values: z
    .array(
      z.object({
        field_key: z.string().min(1).max(64),
        value: z.unknown().nullable(),
        source_id: z.uuid().optional(),
        confidence: z.number().min(0).max(1).optional()
      })
    )
    .min(1)
    .max(100)
});

export async function getPersonOrThrow(ctx: AppContext, tenantId: string, personId: string): Promise<PersonRow> {
  const person = await ctx.store.get('persons', personId);
  if (!person || person.tenant_id !== tenantId || person.status === 'deleted') throw notFound('person not found');
  return person;
}

export async function hydrateOne(ctx: AppContext, tenantId: string, personId: string): Promise<HydratedPerson> {
  const map = await ctx.store.hydratePersons(tenantId, [personId]);
  const person = map.get(personId);
  if (!person) throw notFound('person not found');
  return person;
}

async function insertAlias(
  ctx: AppContext,
  tenantId: string,
  personId: string,
  alias: string,
  aliasType: string,
  options: { language?: string; confidence?: number; sourceId?: string } = {}
) {
  const existing = await ctx.store.findOne('person_aliases', {
    tenant_id: tenantId,
    person_id: personId,
    normalized_alias: normalizeText(alias)
  });
  if (existing) return existing;
  return ctx.store.insert('person_aliases', {
    id: newId(),
    tenant_id: tenantId,
    person_id: personId,
    alias,
    normalized_alias: normalizeText(alias),
    alias_type: aliasType,
    language: options.language ?? null,
    confidence: options.confidence ?? 1,
    source_id: options.sourceId ?? null,
    metadata: {},
    created_at: now()
  });
}

export async function addSnsAccount(
  ctx: AppContext,
  tenantId: string,
  personId: string,
  input: z.infer<typeof SnsAccountInputSchema>,
  discoveredFromSourceId?: string
): Promise<SnsAccountRow> {
  const timestamp = now();
  let account = await ctx.store.findOne('person_sns_accounts', {
    tenant_id: tenantId,
    person_id: personId,
    platform: input.platform,
    handle: input.handle ?? null
  });
  if (!account) {
    account = await ctx.store.insert('person_sns_accounts', {
      id: newId(),
      tenant_id: tenantId,
      person_id: personId,
      platform: input.platform,
      handle: input.handle ?? null,
      url: input.url ?? null,
      display_name: input.display_name ?? input.handle ?? null,
      bio: input.bio ?? null,
      verified: input.verified ?? null,
      status: input.status ?? 'active',
      discovered_from_source_id: discoveredFromSourceId ?? null,
      metadata: (input.metadata ?? {}) as SnsAccountRow['metadata'],
      created_at: timestamp,
      updated_at: timestamp
    });
  }
  if (input.follower_count != null || input.following_count != null || input.post_count != null || input.engagement_rate != null) {
    await ctx.store.insert('person_sns_metrics', {
      id: newId(),
      tenant_id: tenantId,
      account_id: account.id,
      measured_at: timestamp,
      follower_count: input.follower_count ?? null,
      following_count: input.following_count ?? null,
      post_count: input.post_count ?? null,
      engagement_rate: input.engagement_rate ?? null,
      metadata: {}
    });
  }
  return account;
}

export async function createPerson(ctx: AppContext, tenantId: string, input: z.infer<typeof PersonCreateSchema>): Promise<HydratedPerson> {
  const timestamp = now();
  const person = await ctx.store.insert('persons', {
    id: newId(),
    tenant_id: tenantId,
    canonical_name: input.canonical_name,
    display_name: input.display_name ?? input.canonical_name,
    person_type: input.person_type ?? null,
    status: input.status ?? 'active',
    metadata: (input.metadata ?? {}) as PersonRow['metadata'],
    created_at: timestamp,
    updated_at: timestamp
  });

  await insertAlias(ctx, tenantId, person.id, person.canonical_name, 'canonical');
  for (const alias of new Set(input.aliases ?? [])) {
    if (alias !== person.canonical_name) await insertAlias(ctx, tenantId, person.id, alias, 'nickname');
  }

  const shortBio = input.profile?.short_bio ?? null;
  const profileText = input.profile?.profile_text ?? shortBio;
  await upsertProfile(ctx, tenantId, person.id, { short_bio: shortBio, profile_text: profileText });

  for (const sns of input.sns_accounts ?? []) await addSnsAccount(ctx, tenantId, person.id, sns);

  await rebuildSearchDocument(ctx, tenantId, person.id);
  return hydrateOne(ctx, tenantId, person.id);
}

export async function updatePerson(
  ctx: AppContext,
  tenantId: string,
  personId: string,
  patch: z.infer<typeof PersonPatchSchema>
): Promise<HydratedPerson> {
  const person = await getPersonOrThrow(ctx, tenantId, personId);
  await ctx.store.update('persons', person.id, {
    ...(patch.canonical_name != null ? { canonical_name: patch.canonical_name } : {}),
    ...(patch.display_name !== undefined ? { display_name: patch.display_name } : {}),
    ...(patch.person_type !== undefined ? { person_type: patch.person_type } : {}),
    ...(patch.status != null ? { status: patch.status } : {}),
    ...(patch.metadata != null ? { metadata: patch.metadata as PersonRow['metadata'] } : {}),
    updated_at: now()
  });
  if (patch.canonical_name) await insertAlias(ctx, tenantId, personId, patch.canonical_name, 'canonical');
  await rebuildSearchDocument(ctx, tenantId, personId);
  return hydrateOne(ctx, tenantId, personId);
}

// Soft delete: keeps source-backed history; excluded from search and listings.
export async function deletePerson(ctx: AppContext, tenantId: string, personId: string): Promise<void> {
  const person = await getPersonOrThrow(ctx, tenantId, personId);
  await ctx.store.update('persons', person.id, { status: 'deleted', updated_at: now() });
  await ctx.store.removeWhere('person_search_documents', { tenant_id: tenantId, person_id: personId });
}

export async function addAlias(ctx: AppContext, tenantId: string, personId: string, input: z.infer<typeof AliasInputSchema>) {
  await getPersonOrThrow(ctx, tenantId, personId);
  const alias = await insertAlias(ctx, tenantId, personId, input.alias, input.alias_type ?? 'nickname', {
    language: input.language,
    confidence: input.confidence
  });
  await rebuildSearchDocument(ctx, tenantId, personId);
  return alias;
}

/**
 * Removes a wrong alias (also stops it from causing future mis-linking).
 * The alias matching the current canonical name cannot be removed.
 */
export async function deleteAlias(ctx: AppContext, tenantId: string, personId: string, aliasId: string): Promise<void> {
  const person = await getPersonOrThrow(ctx, tenantId, personId);
  const alias = await ctx.store.get('person_aliases', aliasId);
  if (!alias || alias.tenant_id !== tenantId || alias.person_id !== personId) throw notFound('alias not found');
  if (normalizeText(alias.alias) === normalizeText(person.canonical_name)) {
    throw badRequest('the canonical name alias cannot be removed; rename the person instead');
  }
  await ctx.store.remove('person_aliases', aliasId);
  await rebuildSearchDocument(ctx, tenantId, personId);
}

export const SnsAccountPatchSchema = z
  .object({
    handle: z.string().max(120).nullable().optional(),
    url: z.string().max(500).nullable().optional(),
    display_name: z.string().max(200).nullable().optional(),
    bio: z.string().max(2000).nullable().optional(),
    verified: z.boolean().nullable().optional(),
    status: z.enum(['active', 'inactive', 'deleted', 'private', 'unknown']).optional()
  })
  .refine((patch) => Object.values(patch).some((value) => value !== undefined), { message: 'at least one field is required' });

async function getSnsAccountOrThrow(ctx: AppContext, tenantId: string, personId: string, accountId: string): Promise<SnsAccountRow> {
  const account = await ctx.store.get('person_sns_accounts', accountId);
  if (!account || account.tenant_id !== tenantId || account.person_id !== personId) throw notFound('sns account not found');
  return account;
}

export async function updateSnsAccount(
  ctx: AppContext,
  tenantId: string,
  personId: string,
  accountId: string,
  patch: z.infer<typeof SnsAccountPatchSchema>
): Promise<SnsAccountRow> {
  await getPersonOrThrow(ctx, tenantId, personId);
  await getSnsAccountOrThrow(ctx, tenantId, personId, accountId);
  const updated = await ctx.store.update('person_sns_accounts', accountId, {
    ...(patch.handle !== undefined ? { handle: patch.handle } : {}),
    ...(patch.url !== undefined ? { url: patch.url } : {}),
    ...(patch.display_name !== undefined ? { display_name: patch.display_name } : {}),
    ...(patch.bio !== undefined ? { bio: patch.bio } : {}),
    ...(patch.verified !== undefined ? { verified: patch.verified } : {}),
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    updated_at: now()
  });
  await rebuildSearchDocument(ctx, tenantId, personId);
  return updated as SnsAccountRow;
}

/** Hard-deletes an SNS account and its metric history (wrongly attributed accounts). */
export async function deleteSnsAccount(ctx: AppContext, tenantId: string, personId: string, accountId: string): Promise<void> {
  await getPersonOrThrow(ctx, tenantId, personId);
  await getSnsAccountOrThrow(ctx, tenantId, personId, accountId);
  await ctx.store.removeWhere('person_sns_metrics', { tenant_id: tenantId, account_id: accountId });
  await ctx.store.remove('person_sns_accounts', accountId);
  await rebuildSearchDocument(ctx, tenantId, personId);
}

export async function upsertProfile(
  ctx: AppContext,
  tenantId: string,
  personId: string,
  patch: { short_bio?: string | null; profile_text?: string | null }
) {
  const existing = await ctx.store.get('person_profiles', personId);
  const shortBio = patch.short_bio !== undefined ? patch.short_bio : (existing?.short_bio ?? null);
  const profileText = patch.profile_text !== undefined ? patch.profile_text : (existing?.profile_text ?? null);
  const embedding = profileText || shortBio ? await ctx.embeddings.embedOne(`${shortBio ?? ''}\n${profileText ?? ''}`) : null;
  return ctx.store.upsert('person_profiles', {
    person_id: personId,
    tenant_id: tenantId,
    short_bio: shortBio,
    profile_text: profileText,
    profile_embedding: embedding,
    updated_at: now()
  });
}

export async function patchProfile(ctx: AppContext, tenantId: string, personId: string, patch: z.infer<typeof ProfilePatchSchema>) {
  await getPersonOrThrow(ctx, tenantId, personId);
  const profile = await upsertProfile(ctx, tenantId, personId, patch);
  await rebuildSearchDocument(ctx, tenantId, personId);
  const { profile_embedding: _omit, ...rest } = profile;
  return rest;
}

export async function addMetric(ctx: AppContext, tenantId: string, accountId: string, input: z.infer<typeof MetricInputSchema>) {
  const account = await ctx.store.get('person_sns_accounts', accountId);
  if (!account || account.tenant_id !== tenantId) throw notFound('sns account not found');
  return ctx.store.insert('person_sns_metrics', {
    id: newId(),
    tenant_id: tenantId,
    account_id: accountId,
    measured_at: input.measured_at ?? now(),
    follower_count: input.follower_count ?? null,
    following_count: input.following_count ?? null,
    post_count: input.post_count ?? null,
    engagement_rate: input.engagement_rate ?? null,
    metadata: (input.metadata ?? {}) as SnsMetricRow['metadata']
  });
}

async function fieldDefinitionsByKey(ctx: AppContext, tenantId: string): Promise<Map<string, FieldDefinitionRow>> {
  const definitions = await ctx.store.find('field_definitions', { tenant_id: tenantId });
  return new Map(definitions.map((definition) => [definition.key, definition]));
}

/**
 * Replaces the stored values for each given field. `value: null` clears the
 * field; otherwise the value is validated/coerced by the field type.
 */
export async function patchFieldValues(ctx: AppContext, tenantId: string, personId: string, input: z.infer<typeof FieldsPatchSchema>) {
  await getPersonOrThrow(ctx, tenantId, personId);
  const definitions = await fieldDefinitionsByKey(ctx, tenantId);
  const unknown = input.values.filter((value) => !definitions.has(value.field_key));
  if (unknown.length) {
    throw validationError(unknown.map((value) => ({ field: value.field_key, message: 'unknown field key' })));
  }
  for (const entry of input.values) {
    const definition = definitions.get(entry.field_key) as FieldDefinitionRow;
    await ctx.store.removeWhere('person_field_values', {
      tenant_id: tenantId,
      person_id: personId,
      field_definition_id: definition.id
    });
    if (entry.value == null) continue;
    const multiple =
      definition.validation?.multiple === true &&
      Array.isArray(entry.value) &&
      !['enum_multi', 'tag_list', 'json', 'person_relation', 'organization_relation'].includes(definition.type);
    const rawValues = multiple ? (entry.value as unknown[]) : [entry.value];
    for (const raw of rawValues) {
      const columns = coerceFieldValue(definition, raw);
      await ctx.store.insert('person_field_values', {
        id: newId(),
        tenant_id: tenantId,
        person_id: personId,
        field_definition_id: definition.id,
        ...columns,
        value_vector_text: definition.embedding_target ? fieldValueText(definition, columns) : null,
        source_id: entry.source_id ?? null,
        confidence: entry.confidence ?? null,
        metadata: {},
        updated_at: now()
      });
    }
  }
  await rebuildSearchDocument(ctx, tenantId, personId);
  return listFieldValues(ctx, tenantId, personId);
}

export async function listFieldValues(ctx: AppContext, tenantId: string, personId: string) {
  const definitions = await ctx.store.find('field_definitions', { tenant_id: tenantId });
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));
  const values = await ctx.store.find('person_field_values', { tenant_id: tenantId, person_id: personId });
  return values
    .filter((value) => byId.has(value.field_definition_id))
    .map((value) => presentFieldValue(byId.get(value.field_definition_id) as FieldDefinitionRow, value));
}

/** Rebuilds the denormalized person_search_documents row. */
export async function rebuildSearchDocument(ctx: AppContext, tenantId: string, personId: string): Promise<void> {
  const person = await ctx.store.get('persons', personId);
  if (!person || person.tenant_id !== tenantId) return;
  if (person.status === 'deleted' || person.status === 'merged') {
    await ctx.store.removeWhere('person_search_documents', { tenant_id: tenantId, person_id: personId });
    return;
  }
  const [aliases, profile, accounts, contexts, summaries, values, definitions] = await Promise.all([
    ctx.store.find('person_aliases', { tenant_id: tenantId, person_id: personId }),
    ctx.store.get('person_profiles', personId),
    ctx.store.find('person_sns_accounts', { tenant_id: tenantId, person_id: personId }),
    ctx.store.find('person_contexts', { tenant_id: tenantId, person_id: personId }, { orderBy: 'occurred_at', dir: 'desc', limit: 20 }),
    ctx.store.find('person_summaries', { tenant_id: tenantId, person_id: personId }, { orderBy: 'generated_at', dir: 'desc', limit: 10 }),
    ctx.store.find('person_field_values', { tenant_id: tenantId, person_id: personId }),
    ctx.store.find('field_definitions', { tenant_id: tenantId })
  ]);
  const definitionById = new Map(definitions.map((definition) => [definition.id, definition]));
  const customFieldText = values
    .map((value) => {
      const definition = definitionById.get(value.field_definition_id);
      if (!definition || !(definition.searchable || definition.embedding_target)) return null;
      const text = fieldValueText(definition, value);
      return text ? `${definition.label}: ${text}` : null;
    })
    .filter(Boolean)
    .join('\n');
  const recentContextText = contexts
    .slice(0, 5)
    .map((context) => context.context_text ?? '')
    .filter(Boolean)
    .join('\n');
  const tags = new Set<string>();
  for (const context of contexts) for (const tag of context.context_tags ?? []) tags.add(tag);
  for (const summary of summaries) for (const tag of summary.summary_tags ?? []) tags.add(tag);
  if (person.person_type) tags.add(person.person_type);

  const searchableText = [
    person.canonical_name,
    person.display_name,
    person.person_type,
    aliases.map((alias) => alias.alias).join(' '),
    profile?.short_bio,
    profile?.profile_text,
    accounts.map((account) => `${account.platform} ${account.handle ?? ''} ${account.bio ?? ''}`).join(' '),
    contexts.map((context) => context.context_text ?? '').join('\n'),
    summaries.map((summary) => summary.summary_text).join('\n'),
    customFieldText
  ]
    .filter(Boolean)
    .join('\n')
    .slice(0, 30000);

  await ctx.store.upsert('person_search_documents', {
    person_id: personId,
    tenant_id: tenantId,
    searchable_text: searchableText,
    searchable_tags: [...tags].slice(0, 50),
    profile_text: profile?.profile_text ?? null,
    recent_context_text: recentContextText || null,
    custom_field_text: customFieldText || null,
    embedding: await ctx.embeddings.embedOne(searchableText),
    updated_at: now()
  });
}
