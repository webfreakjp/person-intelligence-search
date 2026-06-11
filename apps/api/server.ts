import { createAppContext } from '../../packages/core/bootstrap.ts';
import { recoverStaleRunningJobs, scheduleInlineDrain } from '../../packages/core/jobService.ts';
import { config } from '../../packages/shared/config.ts';
import { buildApp } from './src/app.ts';

const ctx = await createAppContext();
const app = await buildApp(ctx);

// Pick up jobs left over from a previous run (single-process mode).
if (config.inlineWorker) {
  await recoverStaleRunningJobs(ctx, 0); // single process: any 'running' job is stale at boot
  scheduleInlineDrain(ctx);
}

await app.listen({ port: config.port, host: config.host });
app.log.info(`Person Intelligence Search Platform API: http://${config.host}:${config.port} (store=${ctx.store.kind})`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    app.log.info(`received ${signal}, shutting down`);
    await app.close();
    await ctx.store.close();
    process.exit(0);
  });
}
