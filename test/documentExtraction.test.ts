import { describe, expect, it } from 'vitest';
import { textFromUnstructuredResponse } from '../packages/core/documentExtraction.ts';

describe('document extraction helpers', () => {
  it('joins Unstructured element text and counts pages', () => {
    const result = textFromUnstructuredResponse([
      { type: 'Title', text: '職務経歴書', metadata: { page_number: 1 } },
      { type: 'NarrativeText', text: 'バックエンド開発を5年担当。', metadata: { page_number: 1 } },
      { type: 'NarrativeText', text: 'AWSの運用経験あり。', metadata: { page_number: 2 } },
      { type: 'PageBreak', text: '', metadata: { page_number: 2 } }
    ]);

    expect(result.text).toBe('職務経歴書\n\nバックエンド開発を5年担当。\n\nAWSの運用経験あり。');
    expect(result.elementCount).toBe(4);
    expect(result.pageCount).toBe(2);
  });

  it('accepts wrapper responses with elements', () => {
    const result = textFromUnstructuredResponse({ elements: [{ text: 'resume body' }] });

    expect(result.text).toBe('resume body');
    expect(result.elementCount).toBe(1);
    expect(result.pageCount).toBeNull();
  });
});
