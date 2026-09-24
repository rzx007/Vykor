import { describe, expect, it } from "vitest";
import {
  DefaultTrajectoryTracker,
  applyTrajectoryTracker,
  createTrajectoryLoopControl,
} from "./tracker.js";

const failed = (toolName = "Shell") => ({
  toolUse: { type: "tool_use" as const, id: crypto.randomUUID(), name: toolName, input: {} },
  result: { toolUseId: crypto.randomUUID(), toolName, content: [{ type: "text" as const, text: "failed" }], isError: true },
});

describe("DefaultTrajectoryTracker", () => {
  it("offers recovery guidance after consecutive failures", () => {
    const tracker = new DefaultTrajectoryTracker();
    const control = createTrajectoryLoopControl();
    applyTrajectoryTracker(tracker, { calls: [failed(), failed()] }, control);
    expect(control.guidance).toBeTruthy();
    expect(control.forceFinal).toBe(false);
  });

  it("keeps tools available after failures so the agent can recover", () => {
    const tracker = new DefaultTrajectoryTracker();
    const control = createTrajectoryLoopControl();
    applyTrajectoryTracker(tracker, { calls: [failed(), failed(), failed()] }, control);
    expect(control.guidance).toBeTruthy();
    expect(control.forceFinal).toBe(false);
    expect(control.hiddenTools).toEqual([]);
  });

  it.each(["text", "image", "empty"] as const)(
    "does not mistake successful %s results for stalled work",
    (kind) => {
      const tracker = new DefaultTrajectoryTracker();
      const control = createTrajectoryLoopControl();
      for (let step = 0; step < 4; step++) {
        const call = failed("Write");
        tracker.observe({ calls: [{
          ...call,
          toolUse: { ...call.toolUse, input: { file_path: "/work/a", content: String(step) } },
          result: {
            ...call.result,
            isError: false,
            content: kind === "text"
              ? [{ type: "text", text: "Successfully wrote to /work/a" }]
              : kind === "image"
                ? [{ type: "image", source: { type: "file", mediaType: "image/png", path: `/work/image-${step}.png` } }]
                : [],
          },
        }] }, control);
      }
      expect(control).toEqual({ guidance: undefined, forceFinal: false, hiddenTools: [] });
    },
  );

  it("clears recovery guidance when a batch ends with a successful result", () => {
    const tracker = new DefaultTrajectoryTracker();
    const control = createTrajectoryLoopControl();
    const success = failed("Read");
    success.result.isError = false;
    success.result.content[0]!.text = "Found the configuration";
    tracker.observe({ calls: [failed(), failed(), failed(), success] }, control);
    expect(control).toEqual({ guidance: undefined, forceFinal: false, hiddenTools: [] });
  });

  it("fully exempts background and Job tools", () => {
    const tracker = new DefaultTrajectoryTracker();
    const control = createTrajectoryLoopControl();
    applyTrajectoryTracker(tracker, {
      calls: [failed("BackgroundShellCreate"), failed("JobWait"), failed("JobRead"), failed("JobCancel")],
    }, control);
    expect(control).toEqual({ guidance: undefined, forceFinal: false, hiddenTools: [] });
  });

  it("does nothing when the single integration call has no tracker", () => {
    const control = createTrajectoryLoopControl();
    applyTrajectoryTracker(undefined, { calls: [failed(), failed(), failed()] }, control);
    expect(control).toEqual({ guidance: undefined, forceFinal: false, hiddenTools: [] });
  });
});
