import { createService } from '../../src/service.mjs';
import { definitions, toolResult, toolError } from '../../src/tools.mjs';
import { names } from '../../src/identity.mjs';
import { fail } from '../../src/validation.mjs';

const services = new Map();
export function closeNativeServices() { for (const service of services.values()) service.close(); services.clear(); }
process.once('exit', closeNativeServices);

function serviceFor(context) {
  const dataDir = context?.plugin?.dataDir, sessionId = context?.sessionId, workspaceRoot = context?.cwd;
  if (!dataDir || !sessionId || !workspaceRoot) fail('host_binding_missing', 'Native tools require the host plugin data directory, session ID, and workspace');
  const key = JSON.stringify([dataDir, sessionId, workspaceRoot]);
  let service = services.get(key);
  if (!service) {
    service = createService({ dataDir, sessionId, workspaceRoot });
    services.set(key, service);
    while (services.size > 8) { const oldest = services.keys().next().value; services.get(oldest).close(); services.delete(oldest); }
  }
  return service;
}

export function nativeTools(group) {
  return definitions.filter(definition => definition.group === group).map(definition => ({
    name: names[definition.key], description: definition.description, inputSchema: definition.inputSchema,
    async invoke(input, context) {
      try { return toolResult(await serviceFor(context).invoke(definition.key, input, context.signal)); }
      catch (error) { return toolError(error); }
    },
  }));
}
