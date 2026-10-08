import { startFileOrigin } from '../../plugins/dungeonq-host-integration/src/file-origin.ts';
import { startCollector, startFacade } from '../../vendor/dungeonq-runtime/runtime/services.mjs';
let service;
process.once('message', async ({role, options}) => {
  try {
    service = role === 'origin' ? await startFileOrigin(options)
      : role === 'collector' ? await startCollector(options) : await startFacade(options);
    process.send({ready:true,origin:service.origin});
  } catch(error) { process.send({ready:false,code:error.code ?? 'CHILD_FAILED'}); process.exitCode=1; process.disconnect(); }
});
process.once('SIGTERM', async () => { await service?.close(); process.exit(0); });
process.once('disconnect', async () => { await service?.close(); process.exit(0); });
