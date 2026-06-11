import { describe, expect, it } from 'vitest';
import { validateDsl } from '../packages/search/dsl.ts';
import type { FieldDefinitionRow } from '../packages/shared/types.ts';

const fieldDef = (overrides: Partial<FieldDefinitionRow>): FieldDefinitionRow => ({
  id: '00000000-0000-0000-0000-00000000000f',
  tenant_id: '00000000-0000-0000-0000-000000000001',
  schema_id: '00000000-0000-0000-0000-00000000000a',
  key: 'height_cm',
  label: '身長(cm)',
  type: 'number',
  description: null,
  searchable: true,
  filterable: true,
  sortable: false,
  embedding_target: false,
  required: false,
  options: {},
  validation: {},
  extraction_hints: {},
  metadata: {},
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  ...overrides
});

describe('validateDsl', () => {
  it('accepts a full valid DSL and normalizes limits', () => {
    const { dsl, errors } = validateDsl({
      filters: [
        { field: 'core.sns.instagram.follower_count', op: 'gte', value: 1000000 },
        { field: 'core.person.person_type', op: 'eq', value: 'actor' }
      ],
      semantic: [{ query: '環境保全' }],
      time_range: { relative: 'recent_90d' },
      limit: 9999,
      offset: -2
    });
    expect(errors).toEqual([]);
    expect(dsl?.filters).toHaveLength(2);
    expect(dsl?.semantic[0]?.fields).toEqual(['core.search_document']);
    expect(dsl?.time_range?.relative).toBe('recent_90d');
    expect(dsl?.limit).toBe(100);
    expect(dsl?.offset).toBe(0);
  });

  it('rejects unknown fields and unsupported operators', () => {
    const { dsl, errors } = validateDsl({
      filters: [
        { field: 'core.person.no_such', op: 'eq', value: 1 },
        { field: 'core.person.person_type', op: 'gte', value: 1 },
        { field: 'core.sns.instagram.follower_count', op: 'between', value: [1] }
      ]
    });
    expect(dsl).toBeNull();
    expect(errors).toHaveLength(3);
  });

  it('resolves filterable custom fields and rejects non-filterable ones', () => {
    const filterable = fieldDef({});
    const notFilterable = fieldDef({ key: 'note', type: 'text', filterable: false });
    const ok = validateDsl({ filters: [{ field: 'custom.height_cm', op: 'gte', value: 180 }] }, [filterable, notFilterable]);
    expect(ok.errors).toEqual([]);
    expect(ok.dsl?.filters[0]?.resolved.kind).toBe('custom');

    const bad = validateDsl({ filters: [{ field: 'custom.note', op: 'contains', value: 'x' }] }, [filterable, notFilterable]);
    expect(bad.dsl).toBeNull();
    expect(bad.errors[0]?.message).toContain('not filterable');

    const unknown = validateDsl({ filters: [{ field: 'custom.nope', op: 'eq', value: 1 }] }, [filterable]);
    expect(unknown.errors[0]?.message).toContain('unknown custom field');
  });

  it('rejects operators not allowed for the custom field type', () => {
    const tagList = fieldDef({ key: 'keywords', type: 'tag_list' });
    const bad = validateDsl({ filters: [{ field: 'custom.keywords', op: 'gte', value: 1 }] }, [tagList]);
    expect(bad.dsl).toBeNull();
    const ok = validateDsl({ filters: [{ field: 'custom.keywords', op: 'contains_any', value: ['清潔感'] }] }, [tagList]);
    expect(ok.errors).toEqual([]);
  });

  it('rejects invalid time ranges', () => {
    expect(validateDsl({ time_range: { relative: 'recent_5y' } }).dsl).toBeNull();
    expect(validateDsl({ time_range: { field: 'persons.created_at', relative: 'recent_7d' } }).dsl).toBeNull();
    expect(validateDsl({ time_range: { from: 'not-a-date' } }).dsl).toBeNull();
  });

  it('accepts sns account existence filters', () => {
    const { dsl, errors } = validateDsl({ filters: [{ field: 'core.sns.youtube', op: 'exists' }] });
    expect(errors).toEqual([]);
    expect(dsl?.filters[0]?.resolved.kind).toBe('sns_account');
  });
});
