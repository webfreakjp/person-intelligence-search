import { type ErrorDetail, validationError } from '../shared/errors.ts';
import type { FieldDefinitionRow, FieldValueRow, Json, PresentedFieldValue } from '../shared/types.ts';
import { isUuid, toNumber } from '../shared/utils.ts';

export type ValueColumn = 'value_text' | 'value_number' | 'value_boolean' | 'value_date' | 'value_json';

export interface FieldTypeSpec {
  column: ValueColumn;
  operators: string[];
}

// Supported field types and their typed-EAV value columns.
export const FIELD_TYPES: Record<string, FieldTypeSpec> = {
  short_text: { column: 'value_text', operators: ['eq', 'neq', 'contains', 'in', 'not_in', 'exists', 'not_exists'] },
  text: { column: 'value_text', operators: ['eq', 'neq', 'contains', 'exists', 'not_exists'] },
  number: { column: 'value_number', operators: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'in', 'not_in', 'exists', 'not_exists'] },
  boolean: { column: 'value_boolean', operators: ['eq', 'neq', 'exists', 'not_exists'] },
  date: { column: 'value_date', operators: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'exists', 'not_exists'] },
  enum: { column: 'value_text', operators: ['eq', 'neq', 'in', 'not_in', 'exists', 'not_exists'] },
  enum_multi: { column: 'value_json', operators: ['contains', 'contains_any', 'contains_all', 'exists', 'not_exists'] },
  tag_list: { column: 'value_json', operators: ['contains', 'contains_any', 'contains_all', 'exists', 'not_exists'] },
  url: { column: 'value_text', operators: ['eq', 'neq', 'contains', 'exists', 'not_exists'] },
  person_relation: { column: 'value_json', operators: ['contains', 'exists', 'not_exists'] },
  organization_relation: { column: 'value_json', operators: ['contains', 'exists', 'not_exists'] },
  json: { column: 'value_json', operators: ['exists', 'not_exists'] }
};

export const FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

const isDateString = (value: unknown): value is string =>
  /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? '')) && !Number.isNaN(Date.parse(String(value)));

const asStringList = (value: unknown): string[] | null => (Array.isArray(value) ? value.map((item) => String(item)) : null);

export function validateFieldDefinitionInput(input: {
  key?: unknown;
  label?: unknown;
  type?: unknown;
  options?: { values?: unknown };
}): ErrorDetail[] {
  const errors: ErrorDetail[] = [];
  if (!FIELD_KEY_PATTERN.test(String(input.key ?? ''))) errors.push({ field: 'key', message: 'must match ^[a-z][a-z0-9_]{0,63}$' });
  if (!String(input.label ?? '').trim()) errors.push({ field: 'label', message: 'required' });
  if (!FIELD_TYPES[String(input.type)]) errors.push({ field: 'type', message: `must be one of: ${Object.keys(FIELD_TYPES).join(', ')}` });
  if (['enum', 'enum_multi'].includes(String(input.type))) {
    const values = asStringList(input.options?.values);
    if (!values?.length) errors.push({ field: 'options.values', message: 'enum types require options.values (non-empty array)' });
  }
  return errors;
}

export interface CoercedValue {
  value_text: string | null;
  value_number: number | null;
  value_boolean: boolean | null;
  value_date: string | null;
  value_json: Json | null;
}

// Coerces a raw API / extraction value into the typed value columns for one row.
export function coerceFieldValue(definition: FieldDefinitionRow, raw: unknown): CoercedValue {
  const fail = (message: string): never => {
    throw validationError([{ field: definition.key, message }]);
  };
  if (raw == null) fail('value is required');
  const columns: CoercedValue = { value_text: null, value_number: null, value_boolean: null, value_date: null, value_json: null };

  switch (definition.type) {
    case 'short_text':
    case 'text': {
      const text = String(raw).trim();
      if (!text) fail('must be a non-empty string');
      if (definition.type === 'short_text' && text.length > 500) fail('must be <= 500 characters');
      columns.value_text = text;
      break;
    }
    case 'url': {
      const text = String(raw).trim();
      try {
        new URL(text);
      } catch {
        fail('must be a valid URL');
      }
      columns.value_text = text;
      break;
    }
    case 'number': {
      const value = toNumber(raw);
      if (value == null) fail('must be a number');
      columns.value_number = value;
      break;
    }
    case 'boolean': {
      if (typeof raw === 'boolean') columns.value_boolean = raw;
      else if (['true', 'false'].includes(String(raw).toLowerCase())) columns.value_boolean = String(raw).toLowerCase() === 'true';
      else fail('must be a boolean');
      break;
    }
    case 'date': {
      if (!isDateString(raw)) fail('must be a YYYY-MM-DD date');
      columns.value_date = String(raw);
      break;
    }
    case 'enum': {
      const allowed = asStringList(definition.options?.values) ?? [];
      const value = String(raw);
      if (!allowed.includes(value)) fail(`must be one of: ${allowed.join(', ')}`);
      columns.value_text = value;
      break;
    }
    case 'enum_multi': {
      const allowed = asStringList(definition.options?.values) ?? [];
      const values = asStringList(raw);
      if (!values?.length) fail('must be a non-empty array');
      const invalid = (values ?? []).filter((value) => !allowed.includes(value));
      if (invalid.length) fail(`invalid values: ${invalid.join(', ')}`);
      columns.value_json = values;
      break;
    }
    case 'tag_list': {
      const values = asStringList(raw)
        ?.map((tag) => tag.trim())
        .filter(Boolean);
      if (!values?.length) fail('must be a non-empty array of strings');
      columns.value_json = values ?? [];
      break;
    }
    case 'person_relation':
    case 'organization_relation': {
      const values = (Array.isArray(raw) ? raw : [raw]).map((id) => String(id));
      if (!values.length || !values.every(isUuid)) fail('must be a UUID or array of UUIDs');
      columns.value_json = values;
      break;
    }
    case 'json': {
      columns.value_json = raw as Json;
      break;
    }
    default:
      fail(`unsupported field type: ${definition.type}`);
  }
  return columns;
}

// Text representation used for search documents / embeddings.
export function fieldValueText(definition: FieldDefinitionRow, row: Pick<FieldValueRow, ValueColumn>): string | null {
  const spec = FIELD_TYPES[definition.type];
  if (!spec) return null;
  switch (spec.column) {
    case 'value_text':
      return row.value_text;
    case 'value_number':
      return row.value_number == null ? null : String(row.value_number);
    case 'value_boolean':
      return row.value_boolean == null ? null : String(row.value_boolean);
    case 'value_date':
      return row.value_date == null ? null : String(row.value_date).slice(0, 10);
    default: {
      const json = row.value_json;
      if (Array.isArray(json)) return json.map(String).join(' ');
      return json == null ? null : JSON.stringify(json);
    }
  }
}

export function presentFieldValue(definition: FieldDefinitionRow, row: FieldValueRow): PresentedFieldValue {
  const column = FIELD_TYPES[definition.type]?.column;
  let value: Json | null = column ? (row[column] as Json | null) : null;
  if (definition.type === 'date' && value != null) value = String(value).slice(0, 10);
  return {
    field_key: definition.key,
    field_label: definition.label,
    type: definition.type,
    schema_id: definition.schema_id,
    value,
    source_id: row.source_id ?? null,
    confidence: row.confidence ?? null,
    updated_at: row.updated_at
  };
}
