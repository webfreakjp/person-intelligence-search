import { z } from 'zod';
import { notFound } from '../shared/errors.ts';
import type { ProcessingJobRow, SourceDocumentRow } from '../shared/types.ts';
import { newId, now, sha256 } from '../shared/utils.ts';
import type { AppContext } from './context.ts';
import { enqueueJob } from './jobService.ts';

export const SOURCE_TYPES = ['news', 'social_post', 'profile', 'web_page', 'document', 'manual_input', 'csv_import', 'api_import'] as const;

export const SourceCreateSchema = z
  .object({
    source_type: z.enum(SOURCE_TYPES),
    source_subtype: z.string().max(120).optional(),
    title: z.string().max(1000).optional(),
    body: z.string().max(500000).optional(),
    raw_html: z.string().max(2000000).optional(),
    url: z.string().max(2000).optional(),
    source_name: z.string().max(200).optional(),
    published_at: z.iso.datetime({ offset: true }).optional(),
    language: z.string().max(16).optional(),
    idempotency_key: z.string().max(300).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    target_person_ids: z.array(z.uuid()).max(100).optional(),
    processing_options: z.object({ process: z.boolean().optional(), priority: z.number().int().min(-10).max(10).optional() }).optional()
  })
  .refine((input) => Boolean(input.title?.trim() || input.body?.trim() || input.raw_html?.trim()), {
    message: 'either title, body or raw_html is required',
    path: ['body']
  });

export interface IngestResult {
  source_id: string;
  processing_status: string;
  duplicate: boolean;
  version?: number;
  jobs: Array<{ job_id: string; job_type: string; status: string }>;
}

function contentHashOf(input: { title?: string | null; body?: string | null; raw_html?: string | null }): string {
  return sha256([input.title ?? '', input.body ?? '', input.raw_html ?? ''].join('\n'));
}

/**
 * Unified source registration. Dedup policy:
 * - same idempotency_key + same hash -> return existing
 * - same URL + same hash            -> return existing
 * - same URL + different hash       -> new source_document_version, reprocess
 * - same body hash, different URL   -> ingest but flag possible_duplicate_of
 */
export async function ingestSource(ctx: AppContext, tenantId: string, input: z.infer<typeof SourceCreateSchema>): Promise<IngestResult> {
  const timestamp = now();
  const contentHash = contentHashOf(input);

  if (input.idempotency_key) {
    const existing = await ctx.store.findOne('source_documents', { tenant_id: tenantId, content_hash: contentHash });
    if (existing && existing.metadata.idempotency_key === input.idempotency_key) {
      return { source_id: existing.id, processing_status: existing.processing_status, duplicate: true, jobs: [] };
    }
    const byKey = (
      await ctx.store.find('source_documents', { tenant_id: tenantId }, { orderBy: 'created_at', dir: 'desc', limit: 500 })
    ).find((source) => source.metadata.idempotency_key === input.idempotency_key);
    if (byKey && byKey.content_hash === contentHash) {
      return { source_id: byKey.id, processing_status: byKey.processing_status, duplicate: true, jobs: [] };
    }
  }

  if (input.url) {
    const sameUrl = await ctx.store.find(
      'source_documents',
      { tenant_id: tenantId, url: input.url },
      { orderBy: 'created_at', dir: 'desc', limit: 1 }
    );
    const existing = sameUrl[0];
    if (existing) {
      if (existing.content_hash === contentHash) {
        return { source_id: existing.id, processing_status: existing.processing_status, duplicate: true, jobs: [] };
      }
      return updateSourceVersion(ctx, tenantId, existing, input, contentHash);
    }
  }

  const possibleDuplicate = await ctx.store.findOne('source_documents', { tenant_id: tenantId, content_hash: contentHash });

  const source = await ctx.store.insert('source_documents', {
    id: newId(),
    tenant_id: tenantId,
    source_type: input.source_type,
    source_subtype: input.source_subtype ?? null,
    title: input.title ?? null,
    body: input.body ?? null,
    url: input.url ?? null,
    source_name: input.source_name ?? null,
    published_at: input.published_at ?? null,
    received_at: timestamp,
    language: input.language ?? null,
    content_hash: contentHash,
    processing_status: 'queued',
    metadata: {
      ...(input.metadata ?? {}),
      idempotency_key: input.idempotency_key ?? null,
      target_person_ids: input.target_person_ids ?? [],
      ...(possibleDuplicate ? { possible_duplicate_of: possibleDuplicate.id } : {})
    } as SourceDocumentRow['metadata'],
    created_at: timestamp
  });
  await ctx.store.insert('source_payloads', {
    source_id: source.id,
    tenant_id: tenantId,
    raw_payload: input as SourceDocumentRow['metadata'],
    raw_html: input.raw_html ?? null,
    extracted_text: input.body ?? null,
    file_id: null,
    metadata: {}
  });
  await ctx.store.insert('source_document_versions', {
    id: newId(),
    tenant_id: tenantId,
    source_id: source.id,
    version: 1,
    title: source.title,
    body: source.body,
    content_hash: contentHash,
    received_at: timestamp,
    metadata: {}
  });

  const jobs: ProcessingJobRow[] = [];
  if (input.processing_options?.process !== false) {
    jobs.push(
      await enqueueJob(ctx, tenantId, 'document_processing', { sourceId: source.id, priority: input.processing_options?.priority ?? 0 })
    );
  }
  return {
    source_id: source.id,
    processing_status: source.processing_status,
    duplicate: false,
    version: 1,
    jobs: jobs.map((job) => ({ job_id: job.id, job_type: job.job_type, status: job.status }))
  };
}

async function updateSourceVersion(
  ctx: AppContext,
  tenantId: string,
  existing: SourceDocumentRow,
  input: z.infer<typeof SourceCreateSchema>,
  contentHash: string
): Promise<IngestResult> {
  const timestamp = now();
  const versions = await ctx.store.find(
    'source_document_versions',
    { tenant_id: tenantId, source_id: existing.id },
    { orderBy: 'version', dir: 'desc', limit: 1 }
  );
  const nextVersion = (versions[0]?.version ?? 1) + 1;
  await ctx.store.insert('source_document_versions', {
    id: newId(),
    tenant_id: tenantId,
    source_id: existing.id,
    version: nextVersion,
    title: input.title ?? existing.title,
    body: input.body ?? existing.body,
    content_hash: contentHash,
    received_at: timestamp,
    metadata: {}
  });
  await ctx.store.update('source_documents', existing.id, {
    title: input.title ?? existing.title,
    body: input.body ?? existing.body,
    published_at: input.published_at ?? existing.published_at,
    content_hash: contentHash,
    processing_status: 'queued',
    metadata: { ...existing.metadata, ...(input.metadata ?? {}), version: nextVersion }
  });
  const payload = await ctx.store.get('source_payloads', existing.id);
  if (payload) {
    await ctx.store.update('source_payloads', existing.id, {
      raw_payload: input as SourceDocumentRow['metadata'],
      raw_html: input.raw_html ?? payload.raw_html,
      extracted_text: input.body ?? payload.extracted_text
    });
  }
  const job = await enqueueJob(ctx, tenantId, 'document_processing', { sourceId: existing.id });
  return {
    source_id: existing.id,
    processing_status: 'queued',
    duplicate: false,
    version: nextVersion,
    jobs: [{ job_id: job.id, job_type: job.job_type, status: job.status }]
  };
}

export async function getSourceOrThrow(ctx: AppContext, tenantId: string, sourceId: string): Promise<SourceDocumentRow> {
  const source = await ctx.store.get('source_documents', sourceId);
  if (!source || source.tenant_id !== tenantId) throw notFound('source not found');
  return source;
}

export async function reprocessSource(ctx: AppContext, tenantId: string, sourceId: string): Promise<IngestResult> {
  const source = await getSourceOrThrow(ctx, tenantId, sourceId);
  await ctx.store.update('source_documents', source.id, { processing_status: 'queued' });
  const job = await enqueueJob(ctx, tenantId, 'document_processing', { sourceId: source.id });
  return {
    source_id: source.id,
    processing_status: 'queued',
    duplicate: false,
    jobs: [{ job_id: job.id, job_type: job.job_type, status: job.status }]
  };
}

export async function getExtractions(ctx: AppContext, tenantId: string, sourceId: string) {
  await getSourceOrThrow(ctx, tenantId, sourceId);
  const [mentions, contexts, candidates, fieldCandidates] = await Promise.all([
    ctx.store.find('extracted_person_mentions', { tenant_id: tenantId, source_id: sourceId }, { orderBy: 'created_at', dir: 'asc' }),
    ctx.store.find('person_contexts', { tenant_id: tenantId, source_id: sourceId }, { orderBy: 'created_at', dir: 'asc' }),
    ctx.store.find('person_candidates', { tenant_id: tenantId, source_id: sourceId }, { orderBy: 'created_at', dir: 'asc' }),
    ctx.store.find('extracted_field_candidates', { tenant_id: tenantId, source_id: sourceId }, { orderBy: 'created_at', dir: 'asc' })
  ]);
  return {
    mentions,
    contexts: contexts.map(({ context_embedding: _omit, ...rest }) => rest),
    person_candidates: candidates,
    field_candidates: fieldCandidates
  };
}
