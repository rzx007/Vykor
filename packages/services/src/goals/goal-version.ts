import type { GoalVersion, GoalRequirement } from "@vykor/protocol";
import { parsePreparedGoalRequirements } from "@vykor/protocol";
import { and, asc, eq } from "drizzle-orm";
import type { StorageContext } from "../database/storage-context.js";
import { sessionGoalVersions } from "../session-runtime/schema.js";

type VersionRow = typeof sessionGoalVersions.$inferSelect;
const versionKey = (goalId: string, version: number): string => JSON.stringify([goalId, version]);

function fromRow(row: VersionRow): GoalVersion {
  return { goalId: row.goalId, objectiveVersion: row.objectiveVersion,
    ...(row.previousVersion === null ? {} : { previousVersion: row.previousVersion }), objective: row.objective,
    requirements: JSON.parse(row.requirementsJson) as GoalRequirement[], ...(row.frozenAt === null ? {} : { frozenAt: row.frozenAt }),
    changeKind: row.changeKind as GoalVersion["changeKind"], changeReason: row.changeReason, requestId: row.requestId,
    actor: JSON.parse(row.actorJson) as GoalVersion["actor"], inputIds: JSON.parse(row.inputIdsJson) as string[], createdAt: row.createdAt };
}

function saveRow(storage: StorageContext, row: VersionRow): void {
  if (storage.temporaryControls?.goals.has(row.goalId)) {
    const records = storage.temporaryControls;
    const key = versionKey(row.goalId, row.objectiveVersion);
    records.capture(records.versions, key);
    records.versions.set(key, row);
    return;
  }
  storage.database.orm.insert(sessionGoalVersions).values(row).onConflictDoUpdate({
    target: [sessionGoalVersions.goalId, sessionGoalVersions.objectiveVersion], set: row,
  }).run();
}

function toRow(version: GoalVersion): VersionRow {
  return { goalId: version.goalId, objectiveVersion: version.objectiveVersion, previousVersion: version.previousVersion ?? null,
    objective: version.objective, requirementsJson: JSON.stringify(version.requirements), frozenAt: version.frozenAt ?? null,
    changeKind: version.changeKind, changeReason: version.changeReason, requestId: version.requestId, actorJson: JSON.stringify(version.actor),
    inputIdsJson: JSON.stringify(version.inputIds), createdAt: version.createdAt };
}

export function getGoalVersion(storage: StorageContext, goalId: string, objectiveVersion: number): GoalVersion | undefined {
  const row = storage.temporaryControls?.versions.get(versionKey(goalId, objectiveVersion)) ?? storage.database.orm
    .select().from(sessionGoalVersions).where(and(eq(sessionGoalVersions.goalId, goalId), eq(sessionGoalVersions.objectiveVersion, objectiveVersion))).get();
  return row ? fromRow(row) : undefined;
}

export function listGoalVersions(storage: StorageContext, goalId: string): GoalVersion[] {
  const rows = storage.temporaryControls?.goals.has(goalId)
    ? [...storage.temporaryControls.versions.values()].filter(row => row.goalId === goalId)
    : storage.database.orm.select().from(sessionGoalVersions).where(eq(sessionGoalVersions.goalId, goalId)).orderBy(asc(sessionGoalVersions.objectiveVersion)).all();
  return rows.sort((left, right) => left.objectiveVersion - right.objectiveVersion).map(fromRow);
}

export function beginGoalVersion(storage: StorageContext, input: GoalVersion): GoalVersion {
  const existing = getGoalVersion(storage, input.goalId, input.objectiveVersion);
  if (existing) {
    const identity = (version: GoalVersion) => JSON.stringify({ goalId: version.goalId, objectiveVersion: version.objectiveVersion,
      previousVersion: version.previousVersion, objective: version.objective, changeKind: version.changeKind,
      changeReason: version.changeReason, requestId: version.requestId, actor: version.actor, createdAt: version.createdAt });
    if (identity(existing) !== identity(input) || input.inputIds.some(id => !existing.inputIds.includes(id))
      || (input.requirements.length && JSON.stringify(existing.requirements) !== JSON.stringify(input.requirements))) throw new Error("goal_version_conflict");
    return existing;
  }
  if (!Number.isSafeInteger(input.objectiveVersion) || input.objectiveVersion < 1 || !input.objective.trim() || input.objective.length > 32_000
    || !input.changeReason.trim() || input.changeReason.length > 4000 || !input.requestId.trim() || input.requestId.length > 256
    || input.frozenAt !== undefined || !Number.isSafeInteger(input.createdAt) || input.createdAt < 0
    || input.inputIds.length > 64 || new Set(input.inputIds).size !== input.inputIds.length
    || input.inputIds.some(id => !id.trim() || id.length > 256)
    || !["create", "refine", "pivot"].includes(input.changeKind)
    || (input.actor.kind !== "local_user" && (input.actor.kind !== "authenticated_user" || !input.actor.id.trim() || input.actor.id.length > 256))) throw new Error("goal_version_invalid");
  assertGoalRequirementDefinitions(input.requirements, false);
  if (listGoalVersions(storage, input.goalId).some(version => version.requestId === input.requestId)) throw new Error("goal_version_conflict");
  saveRow(storage, toRow(input));
  return getGoalVersion(storage, input.goalId, input.objectiveVersion)!;
}

export function appendGoalVersionInput(storage: StorageContext, goalId: string, objectiveVersion: number, inputId: string): void {
  const version = getGoalVersion(storage, goalId, objectiveVersion);
  if (!version) throw new Error("goal_version_missing");
  if (version.frozenAt !== undefined) throw new Error("goal_version_frozen");
  if (!inputId.trim() || inputId.length > 256) throw new Error("goal_version_input_invalid");
  if (version.inputIds.includes(inputId)) return;
  if (version.inputIds.length >= 64) throw new Error("goal_version_input_limit");
  saveRow(storage, toRow({ ...version, inputIds: [...version.inputIds, inputId] }));
}

export function assertGoalRequirementDefinitions(requirements: GoalRequirement[], requireNonEmpty = true): void {
  if (requireNonEmpty && !requirements.length) throw new Error("goal_version_requirements_invalid");
  const ids = new Set<string>();
  for (const requirement of requirements) {
    if (!requirement.id.trim() || requirement.id.length > 256 || ids.has(requirement.id)) throw new Error("goal_version_requirements_invalid");
    ids.add(requirement.id);
    if (requirement.replaces && (requirement.replaces.length > 64 || new Set(requirement.replaces).size !== requirement.replaces.length
      || requirement.replaces.some(id => !id.trim() || id.length > 256))) throw new Error("goal_version_requirements_invalid");
  }
  parsePreparedGoalRequirements(requirements.map(({ id: _id, replaces: _replaces, ...requirement }) => requirement));
}

/** Caller owns the atomic transaction and checks the current Goal/episode before this write. */
export function freezeGoalVersionRecord(storage: StorageContext, goalId: string, objectiveVersion: number, requirements: GoalRequirement[]): GoalVersion {
  const version = getGoalVersion(storage, goalId, objectiveVersion);
  if (!version) throw new Error("goal_version_missing");
  assertGoalRequirementDefinitions(requirements);
  if (version.frozenAt !== undefined) {
    if (JSON.stringify(version.requirements) !== JSON.stringify(requirements)) throw new Error("goal_version_frozen");
    return version;
  }
  const frozen = { ...version, requirements, frozenAt: Date.now() };
  saveRow(storage, toRow(frozen));
  return getGoalVersion(storage, goalId, objectiveVersion)!;
}
