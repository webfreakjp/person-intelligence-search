import { createEmbeddingProvider } from '../embeddings/index.ts';
import { createLlmProvider } from '../llm/index.ts';
import { config } from '../shared/config.ts';
import { createStore } from '../store/sqlStore.ts';
import { type AppContext, type Logger, consoleLogger } from './context.ts';

export async function createAppContext(options: { log?: Logger; migrate?: boolean } = {}): Promise<AppContext> {
  const log = options.log ?? consoleLogger;
  const store = await createStore({ migrate: options.migrate ?? true });
  const embeddings = createEmbeddingProvider();
  const llm = createLlmProvider();
  log.info(
    {
      store: store.kind,
      embedding_provider: embeddings.name,
      embedding_dimension: embeddings.dimension,
      llm_provider: llm.name,
      inline_worker: config.inlineWorker
    },
    'app context ready'
  );
  return { store, embeddings, llm, log };
}

export { config };
