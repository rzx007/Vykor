import { createService } from '../../src/service.mjs';

const service = createService(JSON.parse(process.argv[2]));
process.send({ ready: true });
process.once('message', async () => {
  try {
    const result = await service.invoke('SavePlanDraft', { documentId: 'trip', expectedRevision: 0, operationId: process.argv[3], title: process.argv[3], entries: [] });
    process.send({ result });
  } catch (error) { process.send({ error: { code: error.code, message: error.message } }); }
  finally { service.close(); process.disconnect(); }
});
