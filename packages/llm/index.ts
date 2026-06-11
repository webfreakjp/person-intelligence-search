import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { ZodType } from 'zod';
import { config } from '../shared/config.ts';

export interface ChatJsonRequest {
  system: string;
  user: string;
  maxTokens?: number;
}

export interface LlmProvider {
  name: string;
  /** Asks the model for a single JSON object and validates it with the given zod schema. */
  completeJson<T>(request: ChatJsonRequest, schema: ZodType<T>): Promise<T>;
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : text) ?? '';
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('LLM response did not contain a JSON object');
  return JSON.parse(candidate.slice(start, end + 1));
}

function requireModel(): string {
  if (!config.llmModel) {
    throw new Error('LLM_MODEL is required. Set it to the model you want to use for query parsing / extraction / summaries.');
  }
  return config.llmModel;
}

function openAiProvider(): LlmProvider {
  if (!config.llmApiKey) throw new Error('LLM_API_KEY (or OPENAI_API_KEY) is required for LLM_PROVIDER=openai');
  const model = requireModel();
  const client = new OpenAI({ apiKey: config.llmApiKey, baseURL: config.llmBaseUrl });
  return {
    name: 'openai',
    async completeJson(request, schema) {
      const response = await client.chat.completions.create({
        model,
        // max_tokens is rejected by current models; the completion budget also
        // covers reasoning tokens, so keep it generous. No temperature: some
        // models only accept their default.
        max_completion_tokens: request.maxTokens ?? 8192,
        response_format: { type: 'json_object' },
        messages: [
          // json_object mode requires the word "JSON" to appear in the prompt.
          { role: 'system', content: `${request.system}\nRespond with a single JSON object and nothing else.` },
          { role: 'user', content: request.user }
        ]
      });
      if (response.usage) {
        console.log(JSON.stringify({ event: 'llm_usage', provider: 'openai', model, ...response.usage }));
      }
      return schema.parse(extractJson(response.choices[0]?.message?.content ?? ''));
    }
  };
}

function anthropicProvider(): LlmProvider {
  if (!config.llmApiKey) throw new Error('LLM_API_KEY (or ANTHROPIC_API_KEY) is required for LLM_PROVIDER=anthropic');
  const model = requireModel();
  const client = new Anthropic({ apiKey: config.llmApiKey, baseURL: config.llmBaseUrl });
  return {
    name: 'anthropic',
    async completeJson(request, schema) {
      const response = await client.messages.create({
        model,
        max_tokens: request.maxTokens ?? 4096,
        system: `${request.system}\nRespond with a single JSON object and nothing else.`,
        messages: [{ role: 'user', content: request.user }]
      });
      if (response.usage) {
        console.log(JSON.stringify({ event: 'llm_usage', provider: 'anthropic', model, ...response.usage }));
      }
      const text = response.content.map((block) => ('text' in block ? block.text : '')).join('\n');
      return schema.parse(extractJson(text));
    }
  };
}

export function createLlmProvider(provider: string = config.llmProvider): LlmProvider {
  if (provider === 'anthropic') return anthropicProvider();
  return openAiProvider();
}
