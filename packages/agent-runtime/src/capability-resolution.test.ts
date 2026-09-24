import type { AgentBackgroundShellHost } from "@vykor/core";
import type { AgentJobHost } from "@vykor/jobs";
import type { AgentTerminalHost } from "@vykor/terminal";
import { describe, expect, it, vi } from "vitest";

import type {
  AgentCapabilityOverrides,
  ObservableJobProducer,
} from "./agent-options.js";
import {
  assertJobConfiguration,
  disabledCapability,
  resolveCapability,
  toAgentCapabilitySnapshot,
  toCapabilitySnapshot,
  unavailableCapability,
} from "./capability-resolution.js";

describe("resolveCapability", () => {
  it("uses the default only when an override is omitted", async () => {
    const factory = vi.fn(async () => "local");

    await expect(resolveCapability(undefined, factory)).resolves.toEqual({
      status: "available",
      value: "local",
      source: "default",
    });

    expect(factory).toHaveBeenCalledOnce();
  });

  it("uses an object override without creating a default", async () => {
    const factory = vi.fn(async () => "local");

    await expect(resolveCapability("host", factory)).resolves.toEqual({
      status: "available",
      value: "host",
      source: "override",
    });

    expect(factory).not.toHaveBeenCalled();
  });

  it("does not call the factory for false", async () => {
    const factory = vi.fn(async () => "local");

    await expect(resolveCapability(false, factory)).resolves.toEqual({
      status: "disabled",
    });

    expect(factory).not.toHaveBeenCalled();
  });

  it("removes capability implementation values from snapshots", () => {
    expect(toCapabilitySnapshot({
      status: "available",
      value: { secret: "implementation" },
      source: "override",
    })).toEqual({ status: "available", source: "override" });
    expect(toCapabilitySnapshot(disabledCapability())).toEqual({
      status: "disabled",
    });
    expect(toCapabilitySnapshot(unavailableCapability("No local scheduler"))).toEqual({
      status: "unavailable",
      reason: "No local scheduler",
    });
  });

  it("removes every implementation value from an agent capability snapshot", () => {
    const available = {
      status: "available" as const,
      value: { secret: "implementation" },
      source: "default" as const,
    };
    const snapshot = toAgentCapabilitySnapshot({
      terminal: available,
      backgroundShell: available,
      jobs: available,
      memory: disabledCapability(),
      childEnvironment: available,
      workflowRepository: available,
      schedules: unavailableCapability("No schedules"),
    });

    expect(snapshot).toEqual({
      terminal: { status: "available", source: "default" },
      backgroundShell: { status: "available", source: "default" },
      jobs: { status: "available", source: "default" },
      memory: { status: "disabled" },
      childEnvironment: { status: "available", source: "default" },
      workflowRepository: { status: "available", source: "default" },
      schedules: { status: "unavailable", reason: "No schedules" },
    });
  });
});

describe("AgentCapabilityOverrides", () => {
  it("allows terminal and background shell producers to share one Job Host", () => {
    const jobs = {} as AgentJobHost;
    const terminal: ObservableJobProducer<AgentTerminalHost> = {
      value: {} as AgentTerminalHost,
      jobs,
    };
    const backgroundShell: ObservableJobProducer<AgentBackgroundShellHost> = {
      value: {} as AgentBackgroundShellHost,
      jobs,
    };
    const overrides: AgentCapabilityOverrides = { terminal, backgroundShell };

    expect(overrides.terminal).not.toBe(false);
    expect(overrides.backgroundShell).not.toBe(false);
    expect(terminal.jobs).toBe(backgroundShell.jobs);
  });
});

describe("assertJobConfiguration", () => {
  it("rejects every producer that remains enabled when Jobs are disabled", () => {
    const cases: Array<[keyof Pick<
      AgentCapabilityOverrides,
      "terminal" | "backgroundShell" | "childEnvironment" | "workflowRepository"
    >, string]> = [
      ["terminal", "terminal"],
      ["backgroundShell", "background shell"],
      ["childEnvironment", "child environment"],
      ["workflowRepository", "workflow repository"],
    ];

    for (const [capability, expectedName] of cases) {
      const overrides: AgentCapabilityOverrides = {
        jobs: false,
        terminal: false,
        backgroundShell: false,
        childEnvironment: false,
        workflowRepository: false,
      };
      overrides[capability] = undefined;

      expect(() => assertJobConfiguration(overrides)).toThrow(
        new RegExp(`${expectedName}.*must also be disabled`, "i"),
      );
    }
  });

  it("accepts an explicitly disabled set of Job producers", () => {
    expect(() => assertJobConfiguration({
      jobs: false,
      terminal: false,
      backgroundShell: false,
      childEnvironment: false,
      workflowRepository: false,
    })).not.toThrow();
  });
});
