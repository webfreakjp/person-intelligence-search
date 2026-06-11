import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30000,
    env: {
      STORE_PROVIDER: 'pglite',
      INLINE_WORKER: 'false',
      EMBEDDING_DIMENSION: '64',
      LOG_LEVEL: 'silent'
    }
  }
});
