import OpenAI from 'openai';
import { config } from '../shared/config.ts';

export interface EmbeddingProvider {
  name: string;
  dimension: number;
  embed(texts: string[]): Promise<number[][]>;
  embedOne(text: string): Promise<number[]>;
}

interface RawProvider {
  name: string;
  embed(texts: string[]): Promise<number[][]>;
}

// Works with the OpenAI embeddings API and any compatible endpoint (EMBEDDING_BASE_URL).
function createOpenAiProvider(dimension: number): RawProvider {
  if (!config.embeddingApiKey) {
    throw new Error('EMBEDDING_API_KEY (or OPENAI_API_KEY) is required for embeddings.');
  }
  if (!config.embeddingModel) {
    throw new Error('EMBEDDING_MODEL is required. Set it to the OpenAI embedding model you want to use.');
  }
  const client = new OpenAI({ apiKey: config.embeddingApiKey, baseURL: config.embeddingBaseUrl });
  return {
    name: 'openai',
    async embed(texts) {
      const response = await client.embeddings.create({
        model: config.embeddingModel,
        input: texts,
        dimensions: dimension
      });
      return response.data.sort((a, b) => a.index - b.index).map((item) => item.embedding);
    }
  };
}

export function createEmbeddingProvider(options: { dimension?: number } = {}): EmbeddingProvider {
  const dimension = options.dimension ?? config.embeddingDimension;
  const raw = createOpenAiProvider(dimension);
  return {
    name: raw.name,
    dimension,
    async embed(texts) {
      const safe = texts.map((text) => String(text ?? '').slice(0, 16000) || ' ');
      const vectors = await raw.embed(safe);
      for (const vector of vectors) {
        if (!Array.isArray(vector) || vector.length !== dimension) {
          throw new Error(`Embedding dimension mismatch: expected ${dimension}, got ${vector?.length}`);
        }
      }
      return vectors;
    },
    async embedOne(text) {
      const [vector] = await this.embed([text]);
      return vector as number[];
    }
  };
}
