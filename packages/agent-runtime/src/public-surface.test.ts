import { describe, expect, it } from "vitest";
import {
  AgentChildBudgetExceededError as CoreBudgetError,
  AgentRunNotAcceptingInputError as CoreSteerError,
} from "@vykor/core";

import * as runtime from "./index.js";
import * as kernel from "./kernel-entry.js";

describe("agent-runtime public error surface", () => {
  it("re-exports steer and budget errors from the default entry", () => {
    expect(runtime.AgentRunNotAcceptingInputError).toBe(CoreSteerError);
    expect(runtime.AgentChildBudgetExceededError).toBe(CoreBudgetError);
  });

  it("re-exports steer and budget errors from the kernel entry", () => {
    expect(kernel.AgentRunNotAcceptingInputError).toBe(CoreSteerError);
    expect(kernel.AgentChildBudgetExceededError).toBe(CoreBudgetError);
  });

  it("keeps instanceof identity with core-thrown instances", () => {
    const steer = new CoreSteerError("run-1");
    const budget = new CoreBudgetError("depth", 2, 3);
    expect(steer).toBeInstanceOf(runtime.AgentRunNotAcceptingInputError);
    expect(budget).toBeInstanceOf(runtime.AgentChildBudgetExceededError);
    expect(steer).toBeInstanceOf(kernel.AgentRunNotAcceptingInputError);
    expect(budget).toBeInstanceOf(kernel.AgentChildBudgetExceededError);
  });
});
