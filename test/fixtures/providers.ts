// Test doubles for the provider interfaces. The product code has no mock mode;
// tests inject these stubs through AppContext instead.
import crypto from 'node:crypto';
import type { EmbeddingProvider } from '../../packages/embeddings/index.ts';
import type { LlmProvider } from '../../packages/llm/index.ts';

export function stubEmbeddings(dimension = 64): EmbeddingProvider {
  const embedOne = (text: string): number[] => {
    const vector = new Array<number>(dimension).fill(0);
    const tokens = text.toLowerCase().match(/[a-z0-9_@.-]+|[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]{2,}/gu) ?? [];
    for (const token of tokens) {
      const digest = crypto.createHash('sha256').update(token).digest();
      for (let i = 0; i < 4; i += 1) {
        const slot = digest.readUInt32BE(i * 4) % dimension;
        vector[slot] = (vector[slot] ?? 0) + 1;
      }
    }
    const length = Math.sqrt(vector.reduce((sum, n) => sum + n * n, 0)) || 1;
    return vector.map((n) => n / length);
  };
  return {
    name: 'stub',
    dimension,
    embed: async (texts) => texts.map(embedOne),
    embedOne: async (text) => embedOne(text)
  };
}

export interface StubLlmResponses {
  mentions?: Array<{ mention: string; confidence?: number }>;
  contexts?: Array<{
    person: string;
    role?: string;
    context_text: string;
    context_tags?: string[];
    sentiment?: 'positive' | 'neutral' | 'negative' | 'mixed' | 'unknown';
    importance?: number;
    evidence_text?: string;
  }>;
  summary?: { summary_text: string; summary_tags?: string[] };
  fields?: Array<{ field_key: string; value: unknown; confidence?: number }>;
  dsl?: unknown;
}

/** Dispatches on the task prompt and returns canned, schema-validated payloads. */
export function stubLlm(responses: StubLlmResponses = {}): LlmProvider {
  return {
    name: 'stub',
    async completeJson(request, schema) {
      let payload: unknown;
      if (request.system.includes('Extract person names')) payload = { mentions: responses.mentions ?? [] };
      else if (request.system.includes('describe how they appear')) payload = { contexts: responses.contexts ?? [] };
      else if (request.system.startsWith('Summarize')) payload = responses.summary ?? { summary_text: 'summary', summary_tags: [] };
      else if (request.system.includes('custom field definitions')) payload = { values: responses.fields ?? [] };
      else if (request.system.includes('Search DSL')) payload = responses.dsl ?? {};
      else throw new Error(`stubLlm: unexpected prompt: ${request.system.slice(0, 60)}`);
      return schema.parse(payload);
    }
  };
}

export function failingLlm(message = 'provider unavailable'): LlmProvider {
  return {
    name: 'failing',
    async completeJson() {
      throw new Error(message);
    }
  };
}

/** Returns each response in order on successive calls (for retry tests). */
export function sequenceLlm(payloads: unknown[]): LlmProvider {
  let index = 0;
  return {
    name: 'sequence',
    async completeJson(_request, schema) {
      const payload = payloads[Math.min(index, payloads.length - 1)];
      index += 1;
      return schema.parse(payload);
    }
  };
}
