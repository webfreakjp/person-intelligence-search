import { badRequest, notFound } from '../shared/errors.ts';
import { config } from '../shared/config.ts';
import type { ProcessingJobRow } from '../shared/types.ts';
import { newId, now } from '../shared/utils.ts';
import type { AppContext } from './context.ts';
import { rebuildSearchDocument } from './personService.ts';
import { processDocumentJob, regenerateSummaries } from './pipeline.ts';

export type JobType = 'document_processing' | 'summary_update' | 'search_index_update';

export async function enqueueJob(
  ctx: AppContext,
  tenantId: string,
  jobType: JobType,
  options: { sourceId?: string; personId?: string; priority?: number } = {}
): Promise<ProcessingJobRow> {
  const timestamp = now();
  const job = await ctx.store.insert('processing_jobs', {
    id: newId(),
    tenant_id: tenantId,
    source_id: options.sourceId ?? null,
    job_type: jobType,
    status: 'queued',
    priority: options.priority ?? 0,
    attempts: 0,
    error_message: null,
    scheduled_at: timestamp,
    started_at: null,
    finished_at: null,
    metadata: options.personId ? { person_id: options.personId } : {},
    created_at: timestamp
  });
  if (config.inlineWorker) scheduleInlineDrain(ctx);
  return job;
}

/** Executes one claimed job (status already moved to running by claimNextJob). */
export async function runClaimedJob(ctx: AppContext, job: ProcessingJobRow): Promise<void> {
  try {
    let resultMetadata: Record<string, unknown> = {};
    if (job.job_type === 'document_processing') {
      resultMetadata = { ...(await processDocumentJob(ctx, job)) };
    } else if (job.job_type === 'summary_update') {
      const personId = String(job.metadata.person_id ?? '');
      const person = await ctx.store.get('persons', personId);
      if (!person) throw new Error('person not found for summary_update');
      await regenerateSummaries(ctx, job.tenant_id, person);
      await rebuildSearchDocument(ctx, job.tenant_id, personId);
    } else if (job.job_type === 'search_index_update') {
      const personId = String(job.metadata.person_id ?? '');
      await rebuildSearchDocument(ctx, job.tenant_id, personId);
    } else {
      throw new Error(`unknown job_type: ${job.job_type}`);
    }
    await ctx.store.update('processing_jobs', job.id, {
      status: 'succeeded',
      finished_at: now(),
      error_message: null,
      metadata: { ...job.metadata, result: resultMetadata } as ProcessingJobRow['metadata']
    });
  } catch (error) {
    const message = (error as Error).message?.slice(0, 2000) ?? 'unknown error';
    const retry = job.attempts < config.jobMaxAttempts;
    ctx.log.error({ job_id: job.id, job_type: job.job_type, error: message, retry }, 'job failed');
    if (job.source_id && !retry) {
      await ctx.store.update('source_documents', job.source_id, { processing_status: 'failed' });
    }
    await ctx.store.update('processing_jobs', job.id, {
      status: retry ? 'retrying' : 'failed',
      error_message: message,
      finished_at: retry ? null : now(),
      scheduled_at: retry ? new Date(Date.now() + 2 ** job.attempts * 1000).toISOString() : job.scheduled_at
    });
  }
}

export async function retryJob(ctx: AppContext, tenantId: string, jobId: string): Promise<ProcessingJobRow> {
  const job = await ctx.store.get('processing_jobs', jobId);
  if (!job || job.tenant_id !== tenantId) throw notFound('job not found');
  if (!['failed', 'cancelled'].includes(job.status)) throw badRequest(`job is ${job.status}; only failed/cancelled jobs can be retried`);
  const updated = await ctx.store.update('processing_jobs', jobId, {
    status: 'queued',
    error_message: null,
    scheduled_at: now(),
    finished_at: null
  });
  if (config.inlineWorker) scheduleInlineDrain(ctx);
  return updated as ProcessingJobRow;
}

export async function cancelJob(ctx: AppContext, tenantId: string, jobId: string): Promise<ProcessingJobRow> {
  const job = await ctx.store.get('processing_jobs', jobId);
  if (!job || job.tenant_id !== tenantId) throw notFound('job not found');
  if (!['queued', 'retrying'].includes(job.status)) throw badRequest(`job is ${job.status}; only queued/retrying jobs can be cancelled`);
  return (await ctx.store.update('processing_jobs', jobId, { status: 'cancelled', finished_at: now() })) as ProcessingJobRow;
}

/**
 * Returns jobs stuck in 'running' (e.g. after a crash mid-job) to the queue.
 * Called on api/worker boot; safe with live workers thanks to the age cutoff.
 */
export async function recoverStaleRunningJobs(ctx: AppContext, olderThanMs = 10 * 60 * 1000): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const { rowCount } = await ctx.store.driver.query(
    `UPDATE processing_jobs SET status = 'retrying', scheduled_at = now() WHERE status = 'running' AND started_at < $1`,
    [cutoff]
  );
  const recovered = rowCount ?? 0;
  if (recovered) ctx.log.warn({ count: recovered }, 'recovered stale running jobs');
  return recovered;
}

/** Claims and runs queued jobs until the queue is empty. */
export async function drainQueue(ctx: AppContext, { maxJobs = 100 } = {}): Promise<number> {
  let processed = 0;
  while (processed < maxJobs) {
    const job = await ctx.store.claimNextJob();
    if (!job) break;
    await runClaimedJob(ctx, job);
    processed += 1;
  }
  return processed;
}

let draining = false;
let drainAgain = false;

/**
 * Inline worker used in single-process mode (PGlite dev or INLINE_WORKER=true):
 * jobs stay queued in processing_jobs but are drained by the API process.
 */
export function scheduleInlineDrain(ctx: AppContext): void {
  if (draining) {
    drainAgain = true;
    return;
  }
  draining = true;
  setImmediate(async () => {
    try {
      do {
        drainAgain = false;
        await drainQueue(ctx);
      } while (drainAgain);
    } catch (error) {
      const message = (error as Error).message ?? '';
      // The store closing mid-drain is an expected shutdown race, not an error.
      if (/closed|terminat/i.test(message)) ctx.log.info({ error: message }, 'inline drain stopped (store closed)');
      else ctx.log.error({ error: message }, 'inline drain failed');
    } finally {
      draining = false;
    }
  });
}
