import { Hono } from "hono";

import type { JobKind, JobStatus } from "@vykor/protocol";

import type { DaemonJobService } from "../../jobs/index.js";
import { errorResponse, jsonResponse, readJson } from "../support.js";

export function createJobRoutes(jobs: DaemonJobService): Hono {
  return new Hono()
    .get("/", async (c) => {
      try {
        const sessionId = required(c.req.query("sessionId"), "sessionId");
        return jsonResponse({ jobs: await jobs.list({
          sessionId,
          ...readListQuery((name) => c.req.query(name)),
        }) });
      } catch (error) {
        return jobError(error);
      }
    })
    .get("/:jobId", async (c) => {
      try {
        return jsonResponse(await jobs.read({
          sessionId: required(c.req.query("sessionId"), "sessionId"),
          jobId: c.req.param("jobId"),
          after: optionalNumber(c.req.query("after")),
          maxChars: optionalNumber(c.req.query("maxChars")),
        }));
      } catch (error) {
        return jobError(error);
      }
    })
    .post("/:jobId/wait", async (c) => {
      const body = await readJson(c);
      try {
        return jsonResponse(await jobs.wait({
          sessionId: required(body.sessionId, "sessionId"),
          jobId: c.req.param("jobId"),
          timeoutMs: numberValue(body.timeoutMs, 30_000),
          after: numberOrUndefined(body.after),
          maxChars: numberOrUndefined(body.maxChars),
          signal: c.req.raw.signal,
        }));
      } catch (error) {
        return jobError(error);
      }
    })
    .post("/:jobId/input", async (c) => {
      const body = await readJson(c);
      try {
        await jobs.send({
          sessionId: required(body.sessionId, "sessionId"),
          jobId: c.req.param("jobId"),
          data: typeof body.data === "string" ? body.data : "",
        });
        return jsonResponse({ sent: true });
      } catch (error) {
        return jobError(error);
      }
    })
    .post("/:jobId/cancel", async (c) => {
      const body = await readJson(c);
      try {
        return jsonResponse({ snapshot: await jobs.cancel({
          sessionId: required(body.sessionId, "sessionId"),
          jobId: c.req.param("jobId"),
          ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
        }) });
      } catch (error) {
        return jobError(error);
      }
    });
}

function jobError(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  return errorResponse(message.includes("not found") || message.includes("not exist") ? 404 : 400, message);
}

function required(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required.`);
  return value.trim();
}

function readListQuery(query: (name: string) => string | undefined) {
  return {
    ...enumList(query("kinds"), ["terminal", "shell", "agent", "dream", "workflow"] as const, "kinds"),
    ...enumList(query("statuses"), ["running", "stopping", "completed", "killed", "failed"] as const, "statuses"),
    ...optionalQueryNumber(query("startedAfter"), "startedAfter"),
    ...optionalQueryNumber(query("startedBefore"), "startedBefore"),
    ...optionalQueryNumber(query("updatedAfter"), "updatedAfter"),
    ...optionalQueryNumber(query("updatedBefore"), "updatedBefore"),
    ...optionalQueryBoolean(query("includeFinished"), "includeFinished"),
    ...optionalQueryNumber(query("limit"), "limit"),
  } as {
    kinds?: JobKind[];
    statuses?: JobStatus[];
    startedAfter?: number;
    startedBefore?: number;
    updatedAfter?: number;
    updatedBefore?: number;
    includeFinished?: boolean;
    limit?: number;
  };
}

function enumList<const T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  name: string,
): Record<string, T[]> {
  if (value === undefined) return {};
  const values = value.split(",").filter(Boolean);
  if (values.length === 0 || values.some((item) => !allowed.includes(item as T))) {
    throw new Error(`${name} contains an unsupported value.`);
  }
  return { [name]: values as T[] };
}

function optionalQueryNumber(value: string | undefined, name: string): Record<string, number> {
  if (value === undefined) return {};
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a finite number.`);
  return { [name]: parsed };
}

function optionalQueryBoolean(value: string | undefined, name: string): Record<string, boolean> {
  if (value === undefined) return {};
  if (value !== "true" && value !== "false") throw new Error(`${name} must be true or false.`);
  return { [name]: value === "true" };
}

function optionalNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function numberValue(value: unknown, fallback: number): number {
  return numberOrUndefined(value) ?? fallback;
}
