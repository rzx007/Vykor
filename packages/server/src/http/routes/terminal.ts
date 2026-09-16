import { Hono } from "hono";

import type {
  TerminalEvent,
  TerminalRuntime,
  TerminalSignal,
} from "@openharness/protocol";

import {
  DaemonTerminalError,
  type DaemonTerminalService,
} from "../../terminal/index.js";
import {
  applicationErrorResponse,
  errorResponse,
  jsonResponse,
  readJson,
  SSE_HEADERS,
} from "../support.js";

interface TerminalSseClient {
  controller: ReadableStreamDefaultController<Uint8Array>;
  unsubscribe: () => void;
  heartbeat: ReturnType<typeof setInterval>;
}

export class TerminalHttpEventHub {
  private readonly encoder = new TextEncoder();
  private readonly clients = new Set<TerminalSseClient>();

  constructor(private readonly terminals: DaemonTerminalService) {}

  get clientCount(): number {
    return this.clients.size;
  }

  createStream(): Response {
    let client: TerminalSseClient | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const unsubscribe = this.terminals.subscribe((event) =>
          this.write(client!, event),
        );
        const heartbeat = setInterval(
          () => this.writeComment(client!, "keepalive"),
          15_000,
        );
        heartbeat.unref?.();
        client = { controller, unsubscribe, heartbeat };
        this.clients.add(client);
        controller.enqueue(this.encoder.encode(": connected\n\n"));
      },
      cancel: () => {
        if (client) this.remove(client);
      },
    });
    return new Response(stream, { status: 200, headers: SSE_HEADERS });
  }

  closeClients(): void {
    for (const client of [...this.clients]) {
      try {
        client.controller.close();
      } catch {
        // The transport may already have closed the stream.
      }
      this.remove(client);
    }
  }

  private write(client: TerminalSseClient, event: TerminalEvent): void {
    try {
      client.controller.enqueue(
        this.encoder.encode(
          `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        ),
      );
    } catch {
      this.remove(client);
    }
  }

  private writeComment(client: TerminalSseClient, comment: string): void {
    try {
      client.controller.enqueue(this.encoder.encode(`: ${comment}\n\n`));
    } catch {
      this.remove(client);
    }
  }

  private remove(client: TerminalSseClient): void {
    clearInterval(client.heartbeat);
    client.unsubscribe();
    this.clients.delete(client);
  }
}

export function createTerminalRoutes(
  terminals: DaemonTerminalService,
  events: TerminalHttpEventHub,
): Hono {
  return new Hono()
    .get("/stream", () => events.createStream())
    .get("/", async (c) =>
      jsonResponse({
        terminals: await terminals.list({
          projectId: c.req.query("projectId") ?? undefined,
          sessionId: c.req.query("sessionId") ?? undefined,
          source: readSource(c.req.query("source")),
        }),
      }),
    )
    .post("/", async (c) => {
      const body = await readJson(c);
      try {
        const terminal = await terminals.create({
          scope: readTerminalScope(body.scope),
          runtime: readRuntime(body.runtime),
          cols: numberValue(body.cols, 80),
          rows: numberValue(body.rows, 24),
          name: optionalText(body.name),
          shell: optionalText(body.shell),
          cwd: optionalText(body.cwd),
          source: readSource(body.source) ?? "user",
        });
        return jsonResponse({ terminal }, 201);
      } catch (error) {
        return terminalError(error, 400);
      }
    })
    .get("/:terminalId", async (c) => {
      try {
        return jsonResponse({
          terminal: await terminals.get(c.req.param("terminalId")),
        });
      } catch (error) {
        return terminalError(error, 404);
      }
    })
    .get("/:terminalId/output", async (c) => {
      try {
        return jsonResponse({
          snapshot: await terminals.read(c.req.param("terminalId")),
        });
      } catch (error) {
        return terminalError(error, 404);
      }
    })
    .post("/:terminalId/input", async (c) => {
      const body = await readJson(c);
      try {
        await terminals.write({
          terminalId: c.req.param("terminalId"),
          data: text(body.data),
        });
        return jsonResponse({ written: true });
      } catch (error) {
        return terminalError(error, 400);
      }
    })
    .post("/:terminalId/resize", async (c) => {
      const body = await readJson(c);
      try {
        await terminals.resize({
          terminalId: c.req.param("terminalId"),
          cols: numberValue(body.cols, 80),
          rows: numberValue(body.rows, 24),
        });
        return jsonResponse({ resized: true });
      } catch (error) {
        return terminalError(error, 400);
      }
    })
    .post("/:terminalId/signal", async (c) => {
      const body = await readJson(c);
      try {
        await terminals.signal({
          terminalId: c.req.param("terminalId"),
          signal: readSignal(body.signal),
        });
        return jsonResponse({ signaled: true });
      } catch (error) {
        return terminalError(error, 400);
      }
    })
    .delete("/:terminalId", async (c) => {
      try {
        await terminals.close(c.req.param("terminalId"));
        return jsonResponse({ removed: true });
      } catch (error) {
        return terminalError(error, 404);
      }
    });
}

function readTerminalScope(value: unknown): {
  kind: "project";
  projectId: string;
} | {
  kind: "session";
  sessionId: string;
} {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const scope = value as Record<string, unknown>;
    if (scope.kind === "project" && optionalText(scope.projectId)) {
      return { kind: "project", projectId: optionalText(scope.projectId)! };
    }
    if (scope.kind === "session" && optionalText(scope.sessionId)) {
      return { kind: "session", sessionId: optionalText(scope.sessionId)! };
    }
    throw new DaemonTerminalError(400, "terminal scope must contain a valid projectId or sessionId.");
  }
  throw new DaemonTerminalError(400, "terminal scope is required.");
}

function terminalError(error: unknown, fallbackStatus: number): Response {
  return applicationErrorResponse(error, fallbackStatus);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readRuntime(value: unknown): TerminalRuntime {
  if (value === undefined || value === "local") return "local";
  if (value === "environment") return "environment";
  throw new DaemonTerminalError(400, "runtime must be local or environment.");
}

function readSource(value: unknown): "user" | "agent" | undefined {
  return value === "user" || value === "agent" ? value : undefined;
}

function readSignal(value: unknown): TerminalSignal {
  if (value === "interrupt" || value === "eof" || value === "terminate")
    return value;
  throw new DaemonTerminalError(
    400,
    "signal must be interrupt, eof, or terminate.",
  );
}
