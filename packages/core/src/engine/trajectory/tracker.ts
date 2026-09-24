import type { ToolExecutionResult } from "../../types/tools.js";
import type { ToolUseBlock } from "../../types/messages.js";

export interface TrajectoryCall {
  toolUse: ToolUseBlock;
  result: ToolExecutionResult;
}

export interface TrajectoryEvent {
  calls: TrajectoryCall[];
}

export interface TrajectoryLoopControl {
  guidance: string | undefined;
  forceFinal: boolean;
  hiddenTools: string[];
}

export interface TrajectoryTracker {
  observe(event: TrajectoryEvent, control: TrajectoryLoopControl): void;
}

const EXEMPT_TOOLS = new Set([
  "BackgroundShellCreate",
  "JobList",
  "JobRead",
  "JobWait",
  "JobSend",
  "JobCancel",
]);

export class DefaultTrajectoryTracker implements TrajectoryTracker {
  private consecutiveFailures = 0;

  observe(event: TrajectoryEvent, control: TrajectoryLoopControl): void {
    for (const call of event.calls) {
      if (EXEMPT_TOOLS.has(call.toolUse.name)) continue;
      // Identical acknowledgements, images and empty successful results can all
      // represent progress. Text novelty is not a reliable execution limit.
      if (!call.result.isError) {
        this.consecutiveFailures = 0;
        control.guidance = undefined;
        continue;
      }

      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= 2) {
        control.guidance =
          "Recent tool calls failed. Use the errors to correct the input, check prerequisites, or choose another authorized approach. Continue independent work when possible. Do not repeat an unchanged failed operation or bypass a permission denial. Explain a blocker only when further progress requires user input or an external change.";
      }
    }
  }
}

export function createTrajectoryLoopControl(): TrajectoryLoopControl {
  return { guidance: undefined, forceFinal: false, hiddenTools: [] };
}

/** The Query Engine's single removable integration point for trajectory policy. */
export function applyTrajectoryTracker(
  tracker: TrajectoryTracker | undefined,
  event: TrajectoryEvent,
  control: TrajectoryLoopControl,
): void {
  tracker?.observe(event, control);
}
