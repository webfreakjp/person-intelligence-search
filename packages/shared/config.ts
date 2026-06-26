import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((value) => (typeof value === 'boolean' ? value : !['false', '0', 'no', 'off', ''].includes(value.toLowerCase())));

// Treats '' as unset so docker-compose pass-through (`VAR: ${VAR:-}`) keeps auto-detection working.
const optionalEnum = <T extends readonly [string, ...string[]]>(values: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), z.enum(values).optional());

const EnvSchema = z.object({
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(0).default(3000),
  MAX_BODY_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(5 * 1024 * 1024),
  MAX_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(25 * 1024 * 1024),
  API_KEY: z.string().default(''),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  // postgres: system of record / pglite: embedded dev database (same SQL path)
  STORE_PROVIDER: z.enum(['postgres', 'pglite']).default('pglite'),
  DATABASE_URL: z.string().default('postgres://persondb:persondb@localhost:5432/persondb'),
  PGLITE_DATA_DIR: z.string().default(path.join(rootDir, 'data', 'pglite')),
  PGROONGA_ENABLED: booleanish.default(true),

  DEFAULT_TENANT_ID: z.uuid().default('00000000-0000-0000-0000-000000000001'),
  DEFAULT_LANGUAGE: z.string().default('ja'),

  EMBEDDING_PROVIDER: optionalEnum(['openai']),
  EMBEDDING_MODEL: z.string().default(''),
  EMBEDDING_DIMENSION: z.coerce.number().int().min(8).max(4000).default(256),
  EMBEDDING_API_KEY: z.string().default(''),
  EMBEDDING_BASE_URL: z.string().default(''),

  LLM_PROVIDER: optionalEnum(['openai', 'anthropic']),
  LLM_MODEL: z.string().default(''),
  LLM_API_KEY: z.string().default(''),
  LLM_BASE_URL: z.string().default(''),
  OPENAI_API_KEY: z.string().default(''),
  ANTHROPIC_API_KEY: z.string().default(''),

  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(2),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(50).default(1000),
  JOB_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(3),
  // run jobs inside the API process (default for pglite, which is single-process)
  INLINE_WORKER: booleanish.optional(),

  AUTO_CREATE_PERSONS: booleanish.default(false),
  AUTO_APPLY_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.8),

  UNSTRUCTURED_API_URL: z.string().default('http://localhost:8000/general/v0/general'),
  UNSTRUCTURED_API_KEY: z.string().default(''),
  UNSTRUCTURED_STRATEGY: z.enum(['auto', 'fast', 'hi_res', 'ocr_only']).default('auto'),
  UNSTRUCTURED_LANGUAGES: z.string().default(''),
  UNSTRUCTURED_TIMEOUT_MS: z.coerce.number().int().min(1000).default(120000)
});

const env = EnvSchema.parse(process.env);

// Real LLM/embedding providers are required: there is no mock mode and no
// default model (both age badly). Providers validate key/model at startup.
const embeddingProvider = env.EMBEDDING_PROVIDER ?? 'openai';
const llmProvider = env.LLM_PROVIDER ?? (env.ANTHROPIC_API_KEY && !env.OPENAI_API_KEY && !env.LLM_API_KEY ? 'anthropic' : 'openai');
const llmApiKey = env.LLM_API_KEY || (llmProvider === 'anthropic' ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY);

export const config = {
  rootDir,
  publicDir: path.join(rootDir, 'apps', 'api', 'public'),
  migrationsDir: path.join(rootDir, 'migrations'),

  host: env.HOST,
  port: env.PORT,
  maxBodyBytes: env.MAX_BODY_BYTES,
  maxUploadBytes: env.MAX_UPLOAD_BYTES,
  apiKey: env.API_KEY,
  logLevel: env.LOG_LEVEL,

  storeProvider: env.STORE_PROVIDER,
  databaseUrl: env.DATABASE_URL,
  pgliteDataDir: env.PGLITE_DATA_DIR,
  pgroongaEnabled: env.PGROONGA_ENABLED,

  tenantId: env.DEFAULT_TENANT_ID,
  defaultLanguage: env.DEFAULT_LANGUAGE,

  embeddingProvider,
  embeddingModel: env.EMBEDDING_MODEL,
  embeddingDimension: env.EMBEDDING_DIMENSION,
  embeddingApiKey: env.EMBEDDING_API_KEY || env.OPENAI_API_KEY,
  embeddingBaseUrl: env.EMBEDDING_BASE_URL || undefined,

  llmProvider,
  llmModel: env.LLM_MODEL,
  llmApiKey,
  llmBaseUrl: env.LLM_BASE_URL || undefined,

  workerConcurrency: env.WORKER_CONCURRENCY,
  workerPollIntervalMs: env.WORKER_POLL_INTERVAL_MS,
  jobMaxAttempts: env.JOB_MAX_ATTEMPTS,
  inlineWorker: env.INLINE_WORKER ?? env.STORE_PROVIDER === 'pglite',

  autoCreatePersons: env.AUTO_CREATE_PERSONS,
  autoApplyConfidence: env.AUTO_APPLY_CONFIDENCE,

  unstructuredApiUrl: env.UNSTRUCTURED_API_URL,
  unstructuredApiKey: env.UNSTRUCTURED_API_KEY,
  unstructuredStrategy: env.UNSTRUCTURED_STRATEGY,
  unstructuredLanguages: env.UNSTRUCTURED_LANGUAGES.split(',')
    .map((language) => language.trim())
    .filter(Boolean),
  unstructuredTimeoutMs: env.UNSTRUCTURED_TIMEOUT_MS
} as const;

export type AppConfig = typeof config;
