import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../../../packages/core/context.ts';
import { extractDocumentText } from '../../../../packages/core/documentExtraction.ts';
import {
  SOURCE_TYPES,
  SourceCreateSchema,
  getExtractions,
  getSourceOrThrow,
  ingestSource,
  reprocessSource
} from '../../../../packages/core/sourceService.ts';
import { badRequest, notFound } from '../../../../packages/shared/errors.ts';
import { config } from '../../../../packages/shared/config.ts';
import { IdParamSchema, PageQuerySchema, pageOf } from './helpers.ts';

const SourceListQuerySchema = PageQuerySchema.extend({
  source_type: z.enum(SOURCE_TYPES).optional(),
  processing_status: z.enum(['queued', 'processing', 'processed', 'failed', 'skipped']).optional()
});

const UploadFieldsSchema = z.object({
  source_type: z.enum(SOURCE_TYPES).default('document'),
  source_subtype: z.string().max(120).optional(),
  title: z.string().max(1000).optional(),
  url: z.string().max(2000).optional(),
  source_name: z.string().max(200).optional(),
  published_at: z.iso.datetime({ offset: true }).optional(),
  language: z.string().max(16).optional(),
  idempotency_key: z.string().max(300).optional(),
  strategy: z.enum(['auto', 'fast', 'hi_res', 'ocr_only']).optional(),
  languages: z.string().max(200).optional(),
  process: z.enum(['true', 'false']).optional(),
  priority: z.coerce.number().int().min(-10).max(10).optional()
});

const emptyToUndefined = (value: string | undefined) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

function parseTargetPersonIds(values: string[]): string[] | undefined {
  let ids: string[];
  try {
    ids = values
      .flatMap((value) => {
        const trimmed = value.trim();
        if (!trimmed) return [];
        if (trimmed.startsWith('[')) {
          const parsed = JSON.parse(trimmed) as unknown;
          if (Array.isArray(parsed)) return parsed.map((entry) => String(entry));
        }
        return trimmed.split(',');
      })
      .map((value) => value.trim())
      .filter(Boolean);
  } catch {
    throw badRequest('target_person_ids must be repeated values, comma-separated UUIDs, or a JSON array');
  }
  return ids.length ? z.array(z.uuid()).max(100).parse(ids) : undefined;
}

function splitLanguages(value: string | undefined): string[] | undefined {
  const languages = value
    ?.split(',')
    .map((language) => language.trim())
    .filter(Boolean);
  return languages?.length ? languages : undefined;
}

export async function registerSourceRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.post('/v1/sources', async (request, reply) => {
    const input = SourceCreateSchema.parse(request.body ?? {});
    const result = await ingestSource(ctx, request.tenantId, input);
    return reply.status(result.duplicate ? 200 : 201).send(result);
  });

  app.post('/v1/sources/upload', async (request, reply) => {
    if (!request.isMultipart()) throw badRequest('multipart/form-data is required');

    const fields = new Map<string, string[]>();
    let file: { buffer: Buffer; filename: string; mimetype: string } | null = null;

    for await (const part of request.parts()) {
      if (part.type === 'file') {
        if (file) throw badRequest('only one file can be uploaded');
        file = {
          buffer: await part.toBuffer(),
          filename: part.filename || 'document.pdf',
          mimetype: part.mimetype || 'application/octet-stream'
        };
      } else {
        const current = fields.get(part.fieldname) ?? [];
        current.push(String(part.value ?? ''));
        fields.set(part.fieldname, current);
      }
    }

    if (!file) throw badRequest('file is required');
    if (file.buffer.length > config.maxUploadBytes) throw badRequest(`file exceeds MAX_UPLOAD_BYTES (${config.maxUploadBytes})`);

    const first = (name: string) => emptyToUndefined(fields.get(name)?.at(-1));
    const form = UploadFieldsSchema.parse({
      source_type: first('source_type'),
      source_subtype: first('source_subtype'),
      title: first('title'),
      url: first('url'),
      source_name: first('source_name'),
      published_at: first('published_at'),
      language: first('language'),
      idempotency_key: first('idempotency_key'),
      strategy: first('strategy'),
      languages: first('languages'),
      process: first('process'),
      priority: first('priority')
    });

    const extracted = await extractDocumentText({
      file: file.buffer,
      filename: file.filename,
      contentType: file.mimetype,
      strategy: form.strategy,
      languages: splitLanguages(form.languages)
    });
    const sourceInput = SourceCreateSchema.parse({
      source_type: form.source_type,
      source_subtype: form.source_subtype,
      title: form.title ?? file.filename,
      body: extracted.text,
      url: form.url,
      source_name: form.source_name,
      published_at: form.published_at,
      language: form.language,
      idempotency_key: form.idempotency_key,
      target_person_ids: parseTargetPersonIds(fields.get('target_person_ids') ?? []),
      metadata: {
        document_extraction: extracted.metadata,
        original_file: {
          filename: file.filename,
          content_type: file.mimetype,
          size_bytes: file.buffer.length
        }
      },
      processing_options: {
        process: form.process === 'false' ? false : undefined,
        priority: form.priority
      }
    });
    const result = await ingestSource(ctx, request.tenantId, sourceInput);

    return reply.status(result.duplicate ? 200 : 201).send({ ...result, extraction: extracted.metadata });
  });

  app.get('/v1/sources', async (request) => {
    const { limit, offset, source_type, processing_status } = SourceListQuerySchema.parse(request.query ?? {});
    const where: Record<string, unknown> = { tenant_id: request.tenantId };
    if (source_type) where.source_type = source_type;
    if (processing_status) where.processing_status = processing_status;
    const [sources, total] = await Promise.all([
      ctx.store.find('source_documents', where, { orderBy: 'created_at', dir: 'desc', limit, offset }),
      ctx.store.count('source_documents', where)
    ]);
    return pageOf(sources, limit, offset, total);
  });

  app.get('/v1/sources/:id', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    return getSourceOrThrow(ctx, request.tenantId, id);
  });

  app.get('/v1/sources/:id/payload', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    await getSourceOrThrow(ctx, request.tenantId, id);
    const payload = await ctx.store.get('source_payloads', id);
    if (!payload) throw notFound('payload not found');
    return payload;
  });

  app.get('/v1/sources/:id/versions', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    await getSourceOrThrow(ctx, request.tenantId, id);
    return {
      results: await ctx.store.find(
        'source_document_versions',
        { tenant_id: request.tenantId, source_id: id },
        { orderBy: 'version', dir: 'desc' }
      )
    };
  });

  app.get('/v1/sources/:id/extractions', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    return getExtractions(ctx, request.tenantId, id);
  });

  app.post('/v1/sources/:id/reprocess', async (request, reply) => {
    const { id } = IdParamSchema.parse(request.params);
    return reply.status(202).send(await reprocessSource(ctx, request.tenantId, id));
  });
}
