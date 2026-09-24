export const TRACE_ID_HEADER = "x-vykor-trace-id";

export type ObservabilityLevel = "debug" | "info" | "warn" | "error";

export type ObservabilityEvent = {
  level: ObservabilityLevel;
  event: string;
  traceId?: string;
  sessionId?: string;
  runId?: string;
  requestId?: string;
  taskId?: string;
  toolName?: string;
  method?: string;
  path?: string;
  status?: number;
  durationMs?: number;
  error?: string;
};

export type StructuredLogger = (event: ObservabilityEvent) => void;

export function writeStructuredLog(event: ObservabilityEvent): void {
  console.info(JSON.stringify({ timestamp: new Date().toISOString(), ...event }));
}
