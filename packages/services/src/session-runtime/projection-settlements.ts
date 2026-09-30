import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type Database from "better-sqlite3";
import type { CreateProjectionSettlementInput, ListProjectionSettlementsOptions, ProjectionSettlementRecord } from "@vykor/protocol";
import { decode, encode, now } from "./store-state.js";

export function createProjectionSettlement(
  database: Database.Database,
  input: CreateProjectionSettlementInput,
): ProjectionSettlementRecord {
  const existing = database
    .prepare(
      `
    SELECT * FROM projection_settlement
    WHERE projector = ? AND root_session_id = ? AND event_sequence = ?
  `,
    )
    .get(input.projector, input.rootSessionId, input.eventSequence) as
    | Record<string, unknown>
    | undefined;
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
    .prepare(
      `
    INSERT INTO projection_settlement
      (id, projector, root_session_id, event_sequence, action, payload_json,
       status, attempt_count, last_error, next_retry_at, created_at, updated_at, resolved_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, NULL, ?, ?, NULL)
  `,
    )
    .run(
      id,
      input.projector,
      input.rootSessionId,
      input.eventSequence,
      input.action,
      encode(input.payload),
      input.error ?? null,
      timestamp,
      timestamp,
    );
  return getProjectionSettlement(database, id)!;
}

export function getProjectionSettlement(database: Database.Database, id: string): ProjectionSettlementRecord | undefined {
  const row = database
    .prepare("SELECT * FROM projection_settlement WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;
  return row ? projectionSettlementFromRow(row) : undefined;
}

export function listProjectionSettlements(
  database: Database.Database,
  options: ListProjectionSettlementsOptions = {},
): ProjectionSettlementRecord[] {
  let records = (
    database
      .prepare("SELECT * FROM projection_settlement ORDER BY created_at, id")
      .all() as Array<Record<string, unknown>>
  ).map(projectionSettlementFromRow);
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

export function markProjectionSettlementRetrying(database: Database.Database, id: string): ProjectionSettlementRecord {
  const timestamp = now();
  const result = database
    .prepare(
      `
    UPDATE projection_settlement
    SET status = 'retrying', attempt_count = attempt_count + 1,
        last_error = NULL, next_retry_at = NULL, updated_at = ?
    WHERE id = ? AND status IN ('pending', 'retrying')
  `,
    )
    .run(timestamp, id);
  if (result.changes === 0) {
    const existing = getProjectionSettlement(database, id);
    if (!existing) throw new Error(`Projection settlement not found: ${id}`);
    return existing;
  }
  return getProjectionSettlement(database, id)!;
}

export function failProjectionSettlement(
  database: Database.Database,
  id: string,
  error: string,
  nextRetryAt?: number,
): ProjectionSettlementRecord {
  const result = database
    .prepare(
      `
    UPDATE projection_settlement
    SET status = 'pending', last_error = ?, next_retry_at = ?, updated_at = ?
    WHERE id = ? AND status != 'resolved' AND status != 'abandoned'
  `,
    )
    .run(error, nextRetryAt ?? null, now(), id);
  if (result.changes === 0 && !getProjectionSettlement(database, id)) {
    throw new Error(`Projection settlement not found: ${id}`);
  }
  return getProjectionSettlement(database, id)!;
}

export function resolveProjectionSettlement(database: Database.Database, id: string): ProjectionSettlementRecord {
  const timestamp = now();
  const result = database
    .prepare(
      `
    UPDATE projection_settlement
    SET status = 'resolved', last_error = NULL, next_retry_at = NULL,
        updated_at = ?, resolved_at = COALESCE(resolved_at, ?)
    WHERE id = ? AND status != 'abandoned'
  `,
    )
    .run(timestamp, timestamp, id);
  if (result.changes === 0 && !getProjectionSettlement(database, id)) {
    throw new Error(`Projection settlement not found: ${id}`);
  }
  return getProjectionSettlement(database, id)!;
}

export function abandonProjectionSettlement(
  database: Database.Database,
  id: string,
  error: string,
): ProjectionSettlementRecord {
  const result = database
    .prepare(
      `
    UPDATE projection_settlement
    SET status = 'abandoned', last_error = ?, next_retry_at = NULL, updated_at = ?
    WHERE id = ? AND status != 'resolved'
  `,
    )
    .run(error, now(), id);
  if (result.changes === 0 && !getProjectionSettlement(database, id)) {
    throw new Error(`Projection settlement not found: ${id}`);
  }
  return getProjectionSettlement(database, id)!;
}

function projectionSettlementFromRow(
  row: Record<string, unknown>,
): ProjectionSettlementRecord {
  return {
    id: row.id as string,
    projector: row.projector as string,
    rootSessionId: row.root_session_id as string,
    eventSequence: row.event_sequence as number,
    action: row.action as ProjectionSettlementRecord["action"],
    payload: decode(row.payload_json as string),
    status: row.status as ProjectionSettlementRecord["status"],
    attemptCount: row.attempt_count as number,
    ...(row.last_error ? { lastError: row.last_error as string } : {}),
    ...(row.next_retry_at !== null && row.next_retry_at !== undefined
      ? { nextRetryAt: row.next_retry_at as number }
      : {}),
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
    ...(row.resolved_at !== null && row.resolved_at !== undefined
      ? { resolvedAt: row.resolved_at as number }
      : {}),
  };
}
