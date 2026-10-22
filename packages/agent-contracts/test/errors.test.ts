import { describe, expect, it } from "vitest";
import { AgentChildBudgetExceededError, AgentExecutionLimitError, AgentRunNotAcceptingInputError,
  ChildRunTerminationError, isAgentExecutionLimitError, ModelRequestFailure } from "../src/index.js";

it.each([
  ["@vykor/agent-contracts/AgentChildBudgetExceededError", AgentChildBudgetExceededError, () => new AgentChildBudgetExceededError("depth", 1, 2)],
  ["@vykor/agent-contracts/ChildRunTerminationError", ChildRunTerminationError, () => new ChildRunTerminationError("user_cancelled", "cancelled")],
  ["@vykor/agent-contracts/AgentRunNotAcceptingInputError", AgentRunNotAcceptingInputError, () => new AgentRunNotAcceptingInputError("run")],
  ["@vykor/core/AgentExecutionLimitError", AgentExecutionLimitError, () => new AgentExecutionLimitError("limited")],
] as const)("retains local and cross-bundle error identity: %s", (brand, ErrorClass, create) => {
  expect(create()).toBeInstanceOf(ErrorClass);
  expect({ [Symbol.for(brand)]: true } instanceof ErrorClass).toBe(true);
  for (const value of [null, undefined, {}, new Error(ErrorClass.name), { [Symbol.for(brand)]: false }]) {
    expect(value instanceof ErrorClass).toBe(false);
  }
});

it("keeps the execution-limit helper consistent with the shared brand", () => {
  expect(isAgentExecutionLimitError(new AgentExecutionLimitError("limited"))).toBe(true);
  expect(isAgentExecutionLimitError({ [Symbol.for("@vykor/core/AgentExecutionLimitError")]: true })).toBe(true);
  expect(isAgentExecutionLimitError(new Error("limited"))).toBe(false);
});

describe("ModelRequestFailure", () => {
  it("recognizes the existing global brand across separately loaded bundles", () => {
    const foreign = { [Symbol.for("@vykor/core/ModelRequestFailure")]: true };
    expect(foreign instanceof ModelRequestFailure).toBe(true);
    expect(new Error("unbranded") instanceof ModelRequestFailure).toBe(false);
  });

  it("preserves the original cause and structured info", () => {
    const cause = new Error("socket closed");
    const error = new ModelRequestFailure(
      "connection reset",
      { kind: "network", phase: "stream", retryable: true, statusCode: 503 },
      cause,
    );
    expect(error.name).toBe("ModelRequestFailure");
    expect(error.info).toEqual({
      kind: "network",
      phase: "stream",
      retryable: true,
      statusCode: 503,
    });
    expect(error.cause).toBe(cause);
  });
});
