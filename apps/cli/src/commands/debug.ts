import { Command } from "commander";
import { HttpTransport } from "@openharness/client";

interface DebugOptions {
  json?: boolean;
  includeContent?: boolean;
  daemonUrl?: string;
  daemonToken?: string;
}

export function createDebugCommand(): Command {
  const command = new Command("debug").description("Read-only diagnostics for durable runs and projections");
  command
    .command("inspect-run")
    .description("Inspect one durable run from input through attempts, tools, and terminal state")
    .argument("<runId>", "Durable run id")
    .option("--json", "Print machine-readable JSON")
    .option("--include-content", "Reveal prompts, model output, tool arguments, and tool results")
    .option("--daemon-url <url>", "Use an explicit daemon URL")
    .option("--daemon-token <token>", "Bearer token for --daemon-url")
    .action(async (runId: string, options: DebugOptions) => {
      const result = await requestDebug(`/debug/runs/${encodeURIComponent(runId)}`, options);
      printRunInspection(result, options.json === true);
      if (!readDiagnosticOk(result)) process.exitCode = 2;
    });

  command
    .command("settlements")
    .description("List durable projection recovery records without changing them")
    .option("--json", "Print machine-readable JSON")
    .option("--include-content", "Reveal settlement payloads")
    .option("--daemon-url <url>", "Use an explicit daemon URL")
    .option("--daemon-token <token>", "Bearer token for --daemon-url")
    .action(async (options: DebugOptions) => {
      const result = await requestDebug("/debug/projection-settlements", options);
      printProjectionSettlements(result, options.json === true);
      if (!readDiagnosticOk(result)) process.exitCode = 2;
    });
  return command;
}

export async function requestDebug(path: string, options: DebugOptions): Promise<Record<string, unknown>> {
  const daemon = await resolveDaemon(options);
  const transport = new HttpTransport({ baseUrl: daemon.url, token: daemon.token });
  return transport.request<Record<string, unknown>>(path, {
    query: { includeContent: options.includeContent },
  });
}

export function printRunInspection(result: Record<string, unknown>, json: boolean): void {
  if (json) return printJson(result);
  const run = asRecord(result.run);
  const attempts = asArray(result.attempts);
  const toolCalls = asArray(result.toolCalls);
  const permissions = asArray(result.permissions);
  const children = asArray(result.childExecutions);
  const events = asArray(result.events);
  const warnings = asArray(result.warnings);
  console.log(`Run: ${String(result.runId)}  status=${String(run.status ?? "unknown")}`);
  console.log(`Session: ${String(run.sessionId ?? "unknown")}  input=${String(run.inputId ?? "none")}`);
  console.log(`Attempts: ${attempts.length}  tool calls/results: ${toolCalls.length}  permissions: ${permissions.length}`);
  console.log(`Child executions: ${children.length}  events: ${events.length}`);
  if (typeof result.sensitiveContentWarning === "string") console.warn(`WARNING: ${result.sensitiveContentWarning}`);
  if (warnings.length === 0) console.log("Diagnostics: OK");
  else {
    console.log(`Diagnostics: ${warnings.length} warning(s)`);
    for (const warning of warnings) {
      const item = asRecord(warning);
      console.log(`- [${String(item.code ?? "warning")}] ${String(item.message ?? "")}`);
    }
  }
}

export function printProjectionSettlements(result: Record<string, unknown>, json: boolean): void {
  if (json) return printJson(result);
  const rows = asArray(result.settlements);
  console.log(`Projection settlements: ${rows.length}  pending/retrying: ${Number(result.pending ?? 0)}`);
  if (typeof result.sensitiveContentWarning === "string") console.warn(`WARNING: ${result.sensitiveContentWarning}`);
  for (const value of rows) {
    const row = asRecord(value);
    console.log(`- ${String(row.id)}  ${String(row.status)}  projector=${String(row.projector)}  action=${String(row.action)}  attempts=${String(row.attemptCount)}`);
  }
  if (rows.length === 0) console.log("No projection settlements recorded.");
}

async function resolveDaemon(options: DebugOptions): Promise<{ url: string; token: string }> {
  if (options.daemonUrl) {
    const url = new URL(options.daemonUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("--daemon-url must use http or https");
    if (!options.daemonToken) throw new Error("--daemon-token is required with --daemon-url");
    return { url: url.toString(), token: options.daemonToken };
  }
  const { readDaemonRegistry } = await import("@openharness/server");
  const registry = readDaemonRegistry();
  if (!registry) {
    throw new Error("No running daemon is registered. Start it explicitly with `ohs daemon start` before using read-only diagnostics.");
  }
  return { url: registry.url, token: registry.token };
}

function readDiagnosticOk(value: Record<string, unknown>): boolean { return value.diagnosticOk === true; }
function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function asArray(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function printJson(value: unknown): void { console.log(JSON.stringify(value, null, 2)); }
