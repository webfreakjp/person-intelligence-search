import { createAppContext } from '../../packages/core/bootstrap.ts';
import { recoverStaleRunningJobs, runClaimedJob } from '../../packages/core/jobService.ts';
import { config } from '../../packages/shared/config.ts';

// Standalone processing worker (STORE_PROVIDER=postgres). Polls processing_jobs
// with FOR UPDATE SKIP LOCKED, so multiple workers can run side by side.
if (config.storeProvider !== 'postgres') {
  console.error('The standalone worker requires STORE_PROVIDER=postgres (PGlite is single-process; use INLINE_WORKER).');
  process.exit(1);
}

const ctx = await createAppContext();
let running = true;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function workLoop(workerIndex: number): Promise<void> {
  while (running) {
    try {
      const job = await ctx.store.claimNextJob();
      if (!job) {
        await sleep(config.workerPollIntervalMs);
        continue;
      }
      ctx.log.info({ worker: workerIndex, job_id: job.id, job_type: job.job_type, attempt: job.attempts }, 'job claimed');
      await runClaimedJob(ctx, job);
    } catch (error) {
      ctx.log.error({ worker: workerIndex, error: (error as Error).message }, 'worker loop error');
      await sleep(config.workerPollIntervalMs);
    }
  }
}

ctx.log.info({ concurrency: config.workerConcurrency, poll_ms: config.workerPollIntervalMs }, 'worker started');
await recoverStaleRunningJobs(ctx);
const loops = Array.from({ length: config.workerConcurrency }, (_, index) => workLoop(index + 1));

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    ctx.log.info({ signal }, 'worker shutting down');
    running = false;
    await Promise.allSettled(loops);
    await ctx.store.close();
    process.exit(0);
  });
}

await Promise.all(loops);
