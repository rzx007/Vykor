import type { GoalVersion } from "@vykor/domain-contracts/goals";
import { and, asc, eq } from "drizzle-orm";
import type { StorageContext } from "../database/storage-context.js";
import { sessionGoalVersions } from "../session-runtime/schema.js";

type VersionRow = typeof sessionGoalVersions.$inferSelect;
const versionKey = (goalId: string, version: number): string =>
  JSON.stringify([goalId, version]);

function fromRow(row: VersionRow): GoalVersion {
  return {
    goalId: row.goalId,
    objectiveVersion: row.objectiveVersion,
    ...(row.previousVersion === null
      ? {}
      : { previousVersion: row.previousVersion }),
    objective: row.objective,
    requestId: row.requestId,
    actor: JSON.parse(row.actorJson) as GoalVersion["actor"],
    createdAt: row.createdAt,
  };
}

export function getGoalVersion(
  storage: StorageContext,
  goalId: string,
  objectiveVersion: number,
): GoalVersion | undefined {
  const row =
    storage.temporaryControls?.versions.get(
      versionKey(goalId, objectiveVersion),
    ) ??
    storage.database.orm
      .select()
      .from(sessionGoalVersions)
      .where(
        and(
          eq(sessionGoalVersions.goalId, goalId),
          eq(sessionGoalVersions.objectiveVersion, objectiveVersion),
        ),
      )
      .get();
  return row ? fromRow(row) : undefined;
}

export function listGoalVersions(
  storage: StorageContext,
  goalId: string,
): GoalVersion[] {
  const rows = storage.temporaryControls?.goals.has(goalId)
    ? [...storage.temporaryControls.versions.values()].filter(
        (row) => row.goalId === goalId,
      )
    : storage.database.orm
        .select()
        .from(sessionGoalVersions)
        .where(eq(sessionGoalVersions.goalId, goalId))
        .orderBy(asc(sessionGoalVersions.objectiveVersion))
        .all();
  return rows
    .sort((left, right) => left.objectiveVersion - right.objectiveVersion)
    .map(fromRow);
}

/** The caller checks the current Goal binding in the same transaction. Records are immutable. */
export function beginGoalVersion(
  storage: StorageContext,
  input: GoalVersion,
): GoalVersion {
  const existing = getGoalVersion(
    storage,
    input.goalId,
    input.objectiveVersion,
  );
  if (existing) {
    const identity = (version: GoalVersion) =>
      JSON.stringify({
        goalId: version.goalId,
        objectiveVersion: version.objectiveVersion,
        previousVersion: version.previousVersion,
        objective: version.objective,
        requestId: version.requestId,
        actor: version.actor,
        createdAt: version.createdAt,
      });
    if (identity(existing) !== identity(input))
      throw new Error("goal_version_conflict");
    return existing;
  }
  if (
    !Number.isSafeInteger(input.objectiveVersion) ||
    input.objectiveVersion < 1 ||
    !input.objective.trim() ||
    input.objective.length > 32_000 ||
    !input.requestId.trim() ||
    input.requestId.length > 256 ||
    !Number.isSafeInteger(input.createdAt) ||
    input.createdAt < 0 ||
    (input.actor.kind !== "local_user" &&
      (input.actor.kind !== "authenticated_user" ||
        !input.actor.id.trim() ||
        input.actor.id.length > 256))
  )
    throw new Error("goal_version_invalid");
  if (
    listGoalVersions(storage, input.goalId).some(
      (version) => version.requestId === input.requestId,
    )
  )
    throw new Error("goal_version_conflict");
  const row: VersionRow = {
    goalId: input.goalId,
    objectiveVersion: input.objectiveVersion,
    previousVersion: input.previousVersion ?? null,
    objective: input.objective,
    requestId: input.requestId,
    actorJson: JSON.stringify(input.actor),
    createdAt: input.createdAt,
  };
  if (storage.temporaryControls?.goals.has(row.goalId)) {
    const records = storage.temporaryControls;
    const key = versionKey(row.goalId, row.objectiveVersion);
    records.capture(records.versions, key);
    records.versions.set(key, row);
  } else storage.database.orm.insert(sessionGoalVersions).values(row).run();
  return getGoalVersion(storage, input.goalId, input.objectiveVersion)!;
}
