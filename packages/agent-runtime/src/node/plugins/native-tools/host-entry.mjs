import process from "node:process";
import { pathToFileURL } from "node:url";

const tools = new Map();
const calls = new Map();
let plugin;
const MAX_IPC_LOG_CHARS = 8 * 1024;

function send(message) {
  if (process.connected) process.send(message);
}

function serializedError(error, fallbackCode) {
  return {
    code: typeof error?.code === "string" ? error.code : fallbackCode,
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
  };
}

function truncateLogMessage(message) {
  const raw = String(message);
  if (raw.length <= MAX_IPC_LOG_CHARS) return raw;
  return `${raw.slice(0, MAX_IPC_LOG_CHARS)}\n[truncated: native tool log message exceeded ${MAX_IPC_LOG_CHARS} characters]`;
}

function validateDefinition(value, entryPath) {
  if (!value || typeof value !== "object") throw new Error(`Tool definition from ${entryPath} must be an object`);
  if (typeof value.name !== "string" || !value.name.trim()) throw new Error(`Tool definition from ${entryPath} has no name`);
  if (typeof value.description !== "string") throw new Error(`Tool ${value.name} has no description`);
  if (!value.inputSchema || typeof value.inputSchema !== "object" || Array.isArray(value.inputSchema)) {
    throw new Error(`Tool ${value.name} has an invalid inputSchema`);
  }
  if (typeof value.invoke !== "function") throw new Error(`Tool ${value.name} has no invoke function`);
  if (value.toolResultInput !== undefined && (typeof value.toolResultInput !== "string" ||
      !/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(value.toolResultInput))) throw new Error("Invalid toolResultInput property");
}

async function registerTools(payload) {
  plugin = payload.plugin;
  tools.clear();
  for (const entry of payload.entries) {
    const module = await import(pathToFileURL(entry.entryPath).href);
    if (typeof module.registerTools !== "function") {
      const error = new Error(`Native Tool entry does not export registerTools(): ${entry.entryPath}`);
      error.code = "tool_register_failed";
      throw error;
    }
    const definitions = await module.registerTools({
      plugin: Object.freeze({ ...plugin }),
      permissions: Object.freeze(structuredClone(entry.permissions)),
      log(level, message) {
        const normalized = ["debug", "info", "warn", "error"].includes(level) ? level : "info";
        send({ type: "log", level: normalized, message: truncateLogMessage(`[${plugin.id}] ${message}`) });
      },
    });
    if (!Array.isArray(definitions)) throw new Error(`registerTools() must return an array: ${entry.entryPath}`);
    for (const definition of definitions) {
      validateDefinition(definition, entry.entryPath);
      if (tools.has(definition.name)) throw new Error(`Duplicate Native Tool name: ${definition.name}`);
      tools.set(definition.name, { definition, permissions: entry.permissions });
    }
  }
  return [...tools.values()].map(({ definition, permissions }) => ({
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema,
    execution: { domain: "control_plane", network: Boolean(permissions.network?.length) },
    ...(definition.safeToRetry === true ? { safeToRetry: true } : {}),
    ...(definition.toolResultInput ? { toolResultInput: definition.toolResultInput } : {}),
  }));
}

async function callTool(requestId, payload) {
  const registered = tools.get(payload.name);
  if (!registered) {
    const error = new Error(`Native Tool is not registered: ${payload.name}`);
    error.code = "tool_not_found";
    throw error;
  }
  const controller = new AbortController();
  calls.set(requestId, controller);
  try {
    const result = await registered.definition.invoke(payload.input, {
      ...payload.context,
      plugin: Object.freeze({ ...plugin }),
      permissions: Object.freeze(structuredClone(registered.permissions)),
      signal: controller.signal,
    });
    if (!result || typeof result !== "object" || !Array.isArray(result.content)) {
      const error = new Error(`Native Tool ${payload.name} returned an invalid result`);
      error.code = "tool_result_invalid";
      throw error;
    }
    return result;
  } finally {
    calls.delete(requestId);
  }
}

process.on("message", async (message) => {
  if (!message || typeof message !== "object") return;
  if (message.type === "cancel" && typeof message.id === "string") {
    calls.get(message.id)?.abort(new Error("Native Tool call cancelled"));
    return;
  }
  if (message.type !== "request" || typeof message.id !== "string") return;
  try {
    let result;
    switch (message.method) {
      case "healthcheck": result = { status: "ok", pid: process.pid }; break;
      case "registerTools": result = await registerTools(message.payload); break;
      case "callTool": result = await callTool(message.id, message.payload); break;
      case "shutdown":
        for (const controller of calls.values()) controller.abort(new Error("Native Tool Host is shutting down"));
        result = { status: "stopping" };
        break;
      default: {
        const error = new Error(`Unsupported Tool Host method: ${message.method}`);
        error.code = "tool_protocol_error";
        throw error;
      }
    }
    send({ type: "response", id: message.id, result });
    if (message.method === "shutdown") setImmediate(() => process.exit(0));
  } catch (error) {
    send({ type: "response", id: message.id, error: serializedError(error, message.method === "registerTools" ? "tool_register_failed" : "tool_call_failed") });
  }
});

process.on("disconnect", () => process.exit(0));
process.on("uncaughtException", (error) => {
  send({ type: "log", level: "error", message: truncateLogMessage(error.stack ?? error.message) });
  process.exit(1);
});
process.on("unhandledRejection", (error) => {
  send({ type: "log", level: "error", message: truncateLogMessage(error instanceof Error ? error.stack ?? error.message : String(error)) });
  process.exit(1);
});
