import { z } from 'zod';
import { FIELD_TYPES, validateFieldDefinitionInput } from '../schemas/fieldTypes.ts';
import { conflictError, notFound, validationError } from '../shared/errors.ts';
import type { FieldDefinitionRow, SchemaRow } from '../shared/types.ts';
import { newId, now } from '../shared/utils.ts';
import type { AppContext } from './context.ts';

const KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export const SchemaCreateSchema = z.object({
  key: z.string().regex(KEY_PATTERN),
  name: z.string().trim().min(1).max(200),
  target_entity: z.literal('person').default('person'),
  description: z.string().max(2000).optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

export const SchemaPatchSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

export const FieldCreateSchema = z.object({
  key: z.string().regex(KEY_PATTERN),
  label: z.string().trim().min(1).max(200),
  type: z.enum(Object.keys(FIELD_TYPES) as [string, ...string[]]),
  description: z.string().max(2000).optional(),
  searchable: z.boolean().optional(),
  filterable: z.boolean().optional(),
  sortable: z.boolean().optional(),
  embedding_target: z.boolean().optional(),
  required: z.boolean().optional(),
  options: z.record(z.string(), z.unknown()).optional(),
  validation: z.record(z.string(), z.unknown()).optional(),
  extraction_hints: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

export const FieldPatchSchema = FieldCreateSchema.partial().omit({ key: true, type: true });

export async function createSchema(ctx: AppContext, tenantId: string, input: z.infer<typeof SchemaCreateSchema>): Promise<SchemaRow> {
  const existing = await ctx.store.findOne('schemas', { tenant_id: tenantId, key: input.key });
  if (existing) throw conflictError(`schema key already exists: ${input.key}`);
  const timestamp = now();
  return ctx.store.insert('schemas', {
    id: newId(),
    tenant_id: tenantId,
    key: input.key,
    name: input.name,
    target_entity: input.target_entity,
    description: input.description ?? null,
    metadata: (input.metadata ?? {}) as SchemaRow['metadata'],
    created_at: timestamp,
    updated_at: timestamp
  });
}

export async function getSchemaOrThrow(ctx: AppContext, tenantId: string, schemaId: string): Promise<SchemaRow> {
  const schema = await ctx.store.get('schemas', schemaId);
  if (!schema || schema.tenant_id !== tenantId) throw notFound('schema not found');
  return schema;
}

export async function updateSchema(
  ctx: AppContext,
  tenantId: string,
  schemaId: string,
  patch: z.infer<typeof SchemaPatchSchema>
): Promise<SchemaRow> {
  await getSchemaOrThrow(ctx, tenantId, schemaId);
  return (await ctx.store.update('schemas', schemaId, {
    ...(patch.name != null ? { name: patch.name } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.metadata != null ? { metadata: patch.metadata as SchemaRow['metadata'] } : {}),
    updated_at: now()
  })) as SchemaRow;
}

export async function deleteSchema(ctx: AppContext, tenantId: string, schemaId: string): Promise<void> {
  await getSchemaOrThrow(ctx, tenantId, schemaId);
  const fieldCount = await ctx.store.count('field_definitions', { tenant_id: tenantId, schema_id: schemaId });
  if (fieldCount > 0) throw conflictError('schema still has field definitions; delete them first');
  await ctx.store.remove('schemas', schemaId);
}

export async function createField(
  ctx: AppContext,
  tenantId: string,
  schemaId: string,
  input: z.infer<typeof FieldCreateSchema>
): Promise<FieldDefinitionRow> {
  await getSchemaOrThrow(ctx, tenantId, schemaId);
  const errors = validateFieldDefinitionInput(input as Parameters<typeof validateFieldDefinitionInput>[0]);
  if (errors.length) throw validationError(errors);
  const duplicate = await ctx.store.findOne('field_definitions', { tenant_id: tenantId, key: input.key });
  if (duplicate) throw conflictError(`field key already exists in tenant: ${input.key}`);
  const timestamp = now();
  return ctx.store.insert('field_definitions', {
    id: newId(),
    tenant_id: tenantId,
    schema_id: schemaId,
    key: input.key,
    label: input.label,
    type: input.type,
    description: input.description ?? null,
    searchable: input.searchable ?? false,
    filterable: input.filterable ?? false,
    sortable: input.sortable ?? false,
    embedding_target: input.embedding_target ?? false,
    required: input.required ?? false,
    options: (input.options ?? {}) as FieldDefinitionRow['options'],
    validation: (input.validation ?? {}) as FieldDefinitionRow['validation'],
    extraction_hints: (input.extraction_hints ?? {}) as FieldDefinitionRow['extraction_hints'],
    metadata: (input.metadata ?? {}) as FieldDefinitionRow['metadata'],
    created_at: timestamp,
    updated_at: timestamp
  });
}

export async function getFieldOrThrow(ctx: AppContext, tenantId: string, fieldId: string): Promise<FieldDefinitionRow> {
  const field = await ctx.store.get('field_definitions', fieldId);
  if (!field || field.tenant_id !== tenantId) throw notFound('field definition not found');
  return field;
}

export async function updateField(
  ctx: AppContext,
  tenantId: string,
  fieldId: string,
  patch: z.infer<typeof FieldPatchSchema>
): Promise<FieldDefinitionRow> {
  const field = await getFieldOrThrow(ctx, tenantId, fieldId);
  if (['enum', 'enum_multi'].includes(field.type) && patch.options) {
    const values = patch.options.values;
    if (!Array.isArray(values) || !values.length) {
      throw validationError([{ field: 'options.values', message: 'enum types require options.values (non-empty array)' }]);
    }
  }
  const updatable: Partial<FieldDefinitionRow> = { updated_at: now() };
  for (const key of ['label', 'description', 'searchable', 'filterable', 'sortable', 'embedding_target', 'required'] as const) {
    if (patch[key] !== undefined) (updatable as Record<string, unknown>)[key] = patch[key];
  }
  for (const key of ['options', 'validation', 'extraction_hints', 'metadata'] as const) {
    if (patch[key] !== undefined) (updatable as Record<string, unknown>)[key] = patch[key];
  }
  return (await ctx.store.update('field_definitions', fieldId, updatable)) as FieldDefinitionRow;
}

export async function deleteField(ctx: AppContext, tenantId: string, fieldId: string): Promise<void> {
  await getFieldOrThrow(ctx, tenantId, fieldId);
  // person_field_values / extracted_field_candidates cascade via FK
  await ctx.store.remove('field_definitions', fieldId);
}
