import { describe, expect, it } from 'vitest';
import { coerceFieldValue, fieldValueText, validateFieldDefinitionInput } from '../packages/schemas/fieldTypes.ts';
import type { FieldDefinitionRow } from '../packages/shared/types.ts';

const def = (type: string, options: Record<string, unknown> = {}): FieldDefinitionRow =>
  ({ key: 'field', label: 'Field', type, options, validation: {} }) as unknown as FieldDefinitionRow;

describe('coerceFieldValue', () => {
  it('coerces numbers (including formatted strings)', () => {
    expect(coerceFieldValue(def('number'), '1,820').value_number).toBe(1820);
    expect(() => coerceFieldValue(def('number'), 'abc')).toThrow();
  });

  it('coerces booleans and dates', () => {
    expect(coerceFieldValue(def('boolean'), 'true').value_boolean).toBe(true);
    expect(coerceFieldValue(def('date'), '1997-06-12').value_date).toBe('1997-06-12');
    expect(() => coerceFieldValue(def('date'), '1997/06/12')).toThrow();
    expect(() => coerceFieldValue(def('date'), '1997-13-40')).toThrow();
  });

  it('validates enum values against options', () => {
    const enumDef = def('enum', { values: ['A', 'B'] });
    expect(coerceFieldValue(enumDef, 'A').value_text).toBe('A');
    expect(() => coerceFieldValue(enumDef, 'C')).toThrow();
    const multi = def('enum_multi', { values: ['A', 'B'] });
    expect(coerceFieldValue(multi, ['A', 'B']).value_json).toEqual(['A', 'B']);
    expect(() => coerceFieldValue(multi, ['A', 'X'])).toThrow();
  });

  it('validates urls, tag lists and relations', () => {
    expect(coerceFieldValue(def('url'), 'https://example.com/x').value_text).toBe('https://example.com/x');
    expect(() => coerceFieldValue(def('url'), 'not a url')).toThrow();
    expect(coerceFieldValue(def('tag_list'), [' 清潔感 ', '']).value_json).toEqual(['清潔感']);
    const uuid = '8c5a1c1e-0000-4000-8000-000000000001';
    expect(coerceFieldValue(def('person_relation'), uuid).value_json).toEqual([uuid]);
    expect(() => coerceFieldValue(def('person_relation'), 'nope')).toThrow();
  });

  it('rejects over-long short_text and empty values', () => {
    expect(() => coerceFieldValue(def('short_text'), 'a'.repeat(501))).toThrow();
    expect(() => coerceFieldValue(def('text'), '   ')).toThrow();
    expect(() => coerceFieldValue(def('number'), null)).toThrow();
  });
});

describe('validateFieldDefinitionInput', () => {
  it('enforces key pattern, label, type and enum options', () => {
    expect(validateFieldDefinitionInput({ key: 'BadKey', label: '', type: 'wat' })).toHaveLength(3);
    expect(validateFieldDefinitionInput({ key: 'ok_key', label: 'OK', type: 'enum', options: {} })).toHaveLength(1);
    expect(validateFieldDefinitionInput({ key: 'ok_key', label: 'OK', type: 'enum', options: { values: ['a'] } })).toEqual([]);
  });
});

describe('fieldValueText', () => {
  it('renders typed values as searchable text', () => {
    expect(
      fieldValueText(def('number'), { value_text: null, value_number: 182, value_boolean: null, value_date: null, value_json: null })
    ).toBe('182');
    expect(
      fieldValueText(def('tag_list'), {
        value_text: null,
        value_number: null,
        value_boolean: null,
        value_date: null,
        value_json: ['a', 'b']
      })
    ).toBe('a b');
  });
});
