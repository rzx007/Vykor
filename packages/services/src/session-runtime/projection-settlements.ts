import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import type { CreateProjectionSettlementInput, ListProjectionSettlementsOptions, ProjectionSettlementRecord } from "@vykor/protocol";
import type { SessionDatabase } from "../database/session-database.js";
import { projectionSettlements } from "./schema.js";
import { decode, encode, now } from "./store-state.js";

export function createProjectionSettlement(
  database: SessionDatabase["orm"],
  input: CreateProjectionSettlementInput,
): ProjectionSettlementRecord {
  const existing = database
    .select()
    .from(projectionSettlements)
    .where(and(
      eq(projectionSettlements.projector, input.projector),
      eq(projectionSettlements.rootSessionId, input.rootSessionId),
      eq(projectionSettlements.eventSequence, input.eventSequence),
    ))
    .get();
  if (existing) {
    const record = projectionSettlementFromRow(existing);
    if (
      record.action !== input.action ||
      !isDeepStrictEqual(record.payload, input.payload)
    ) {
      throw new Error(
        `Projection settlement identity conflict: ${input.projector}/${input.rootSessionId}/${input.eventSequence}`,
      );
    }
    return record;
  }
  const timestamp = now();
  const id = input.id ?? randomUUID();
  database
    .insert(projectionSettlements)
    .values({
      id,
      projector: input.projector,
      rootSessionId: input.rootSessionId,
      eventSequence: input.eventSequence,
      action: input.action,
      payloadJson: encode(input.payload),
      status: "pending",
      attemptCount: 0,
      lastError: input.error ?? null,
      nextRetryAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      resolvedAt: null,
    })
    .run();
  return getProjectionSettlement(database, id)!;
}

export function getProjectionSettlement(database: SessionDatabase["orm"], id: string): ProjectionSettlementRecord | undefined {
  const row = database
    .select()
    .from(projectionSettlements)
    .where(eq(projectionSettlements.id, id))
    .get();
  return row ? projectionSettlementFromRow(row) : undefined;
}

export function listProjectionSettlements(
  database: SessionDatabase["orm"],
  options: ListProjectionSettlementsOptions = {},
): ProjectionSettlementRecord[] {
  let records = database
    .select()
    .from(projectionSettlements)
    .orderBy(asc(projectionSettlements.createdAt), asc(projectionSettlements.id))
    .all()
    .map(projectionSettlementFromRow);
  if (options.projector)
    records = records.filter((row) => row.projector === options.projector);
  if (options.rootSessionId)
    records = records.filter(
      (row) => row.rootSessionId === options.rootSessionId,
    );
  if (options.status) {
    const statuses = new Set(
      Array.isArray(options.status) ? options.status : [options.status],
    );
    records = records.filter((row) => statuses.has(row.status));
  }
  return records;
}

export function markProjectionSettlementRetrying(database: SessionDatabase["orm"], id: string): ProjectionSettlementRecord {
  const timestamp = now();
  const result = database
    .update(projectionSettlements)
    .set({
      status: "retrying",
      attemptCount: sql<number>`${projectionSettlements.attemptCount} + 1`,
      lastError: null,
      nextRetryAt: null,
      updatedAt: timestamp,
    })
    .where(and(
      eq(projectionSettlements.id, id),
      inArray(projectionSettlements.status, ["pending", "retrying"]),
    ))
    .run();
  if (result.changes === 0) {
    const existing = getProjectionSettlement(database, id);
    if (!existing) throw new Error(`Projection settlement not found: ${id}`);
    return existing;
  }
  return getProjectionSettlement(database, id)!;
}

export function failProjectionSettlement(
  database: SessionDatabase["orm"],
  id: string,
  error: string,
  nextRetryAt?: number,
): ProjectionSettlementRecord {
  const result = database
    .update(projectionSettlements)
    .set({ status: "pending", lastError: error, nextRetryAt: nextRetryAt ?? null, updatedAt: now() })
    .where(and(
      eq(projectionSettlements.id, id),
      ne(projectionSettlements.status, "resolved"),
      ne(projectionSettlements.status, "abandoned"),
    ))
    .run();
  if (result.changes === 0 && !getProjectionSettlement(database, id)) {
    throw new Error(`Projection settlement not found: ${id}`);
  }
  return getProjectionSettlement(database, id)!;
}

export function resolveProjectionSettlement(database: SessionDatabase["orm"], id: string): ProjectionSettlementRecord {
  const timestamp = now();
  const result = database
    .update(projectionSettlements)
    .set({
      status: "resolved",
      lastError: null,
      nextRetryAt: null,
      updatedAt: timestamp,
      resolvedAt: sql<number>`coalesce(${projectionSettlements.resolvedAt}, ${timestamp})`,
    })
    .where(and(eq(projectionSettlements.id, id), ne(projectionSettlements.status, "abandoned")))
    .run();
  if (result.changes === 0 && !getProjectionSettlement(database, id)) {
    throw new Error(`Projection settlement not found: ${id}`);
  }
  return getProjectionSettlement(database, id)!;
}

export function abandonProjectionSettlement(
  database: SessionDatabase["orm"],
  id: string,
  error: string,
): ProjectionSettlementRecord {
  const result = database
    .update(projectionSettlements)
    .set({ status: "abandoned", lastError: error, nextRetryAt: null, updatedAt: now() })
    .where(and(eq(projectionSettlements.id, id), ne(projectionSettlements.status, "resolved")))
    .run();
  if (result.changes === 0 && !getProjectionSettlement(database, id)) {
    throw new Error(`Projection settlement not found: ${id}`);
  }
  return getProjectionSettlement(database, id)!;
}

function projectionSettlementFromRow(
  row: typeof projectionSettlements.$inferSelect,
): ProjectionSettlementRecord {
  return {
    id: row.id,
    projector: row.projector,
    rootSessionId: row.rootSessionId,
    eventSequence: row.eventSequence,
    action: row.action as ProjectionSettlementRecord["action"],
    payload: decode(row.payloadJson),
    status: row.status as ProjectionSettlementRecord["status"],
    attemptCount: row.attemptCount,
    ...(row.lastError ? { lastError: row.lastError } : {}),
    ...(row.nextRetryAt !== null
      ? { nextRetryAt: row.nextRetryAt }
      : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.resolvedAt !== null
      ? { resolvedAt: row.resolvedAt }
      : {}),
  };
}
