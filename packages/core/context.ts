import type { EmbeddingProvider } from '../embeddings/index.ts';
import type { LlmProvider } from '../llm/index.ts';
import type { SqlStore } from '../store/sqlStore.ts';

export interface Logger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface AppContext {
  store: SqlStore;
  embeddings: EmbeddingProvider;
  llm: LlmProvider;
  log: Logger;
}

export const consoleLogger: Logger = {
  info: (obj, msg) => console.log(JSON.stringify({ level: 'info', msg, ...(typeof obj === 'object' ? obj : { detail: obj }) })),
  warn: (obj, msg) => console.warn(JSON.stringify({ level: 'warn', msg, ...(typeof obj === 'object' ? obj : { detail: obj }) })),
  error: (obj, msg) => console.error(JSON.stringify({ level: 'error', msg, ...(typeof obj === 'object' ? obj : { detail: obj }) }))
};
