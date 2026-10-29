import { createHash } from "node:crypto";
import { isCommittedModelPart, type SessionMessagePartRecord } from "@vykor/domain-contracts/sessions";
import { GOAL_READ_TOOL_NAME } from "../../goals/goal-read-tool.js";
import { GOAL_UPDATE_TOOL_NAME } from "../../goals/goal-update-tool.js";

const NO_PROGRESS_TURN_LIMIT = 3;
const RESULT_WINDOW_SIZE = 64;

/** Host-owned continuation state; only fingerprints, never copies of tool bodies. */
interface GoalRunProgress {
  version: 1;
  noProgressTurns: number;
  recentResults: string[];
}

/** A safety condition for automatic continuation, not a judgment of task completion. */
export function assessGoalRunProgress(
  parts: readonly SessionMessagePartRecord[],
  previous: unknown,
  terminalOutput: unknown,
): { state: GoalRunProgress; shouldPause: boolean } {
  const prior = readProgress(previous);
  const committed = parts.filter(isCommittedModelPart);
  const tools = committed.filter(part => part.type === "tool"
    && part.toolName !== GOAL_READ_TOOL_NAME && part.toolName !== GOAL_UPDATE_TOOL_NAME);
  let results: string[];
  if (tools.length) {
    // Rewording a report cannot hide execution that keeps failing or returning the same result.
    results = tools.filter(part => part.status === "completed" && !part.isError && part.output !== undefined)
      .map(part => fingerprint([part.toolName, part.input, resultBody(part.output)]));
  } else {
    const text = (typeof terminalOutput === "string" ? terminalOutput
      : committed.filter(part => part.type === "text" && part.status === "completed")
        .map(part => part.text ?? "").join("\n")).replace(/\s+/gu, " ").trim();
    results = text ? [fingerprint(["reply", text])] : [];
  }
  // One fingerprint per round keeps storage bounded even when a round used many tools.
  const result = results.length ? fingerprint([...new Set(results)].sort()) : undefined;
  const state: GoalRunProgress = {
    version: 1,
    noProgressTurns: result && !prior.recentResults.includes(result) ? 0 : prior.noProgressTurns + 1,
    recentResults: result ? [...prior.recentResults, result].slice(-RESULT_WINDOW_SIZE) : prior.recentResults,
  };
  return { state, shouldPause: state.noProgressTurns >= NO_PROGRESS_TURN_LIMIT };
}

function readProgress(value: unknown): GoalRunProgress {
  if (value && typeof value === "object") {
    const record = value as Partial<GoalRunProgress>;
    if (record.version === 1 && Number.isSafeInteger(record.noProgressTurns) && record.noProgressTurns! >= 0
      && Array.isArray(record.recentResults) && record.recentResults.length <= RESULT_WINDOW_SIZE
      && record.recentResults.every(result => typeof result === "string" && /^[a-f0-9]{64}$/.test(result))) {
      return record as GoalRunProgress;
    }
  }
  return { version: 1, noProgressTurns: 0, recentResults: [] };
}

/** Compare delivered data and checked file changes, not per-call IDs, handles or diagnostics. */
function resultBody(value: unknown): unknown {
  if (value && typeof value === "object" && "content" in value && Array.isArray(value.content)) {
    const result = value as { content: unknown[]; hostFileFacts?: unknown };
    return [result.content, result.hostFileFacts];
  }
  return value;
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

/** Property order and tool-use IDs are not execution progress. Array order still matters. */
function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
