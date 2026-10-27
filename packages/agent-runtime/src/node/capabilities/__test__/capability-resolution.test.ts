import type { AgentBackgroundShellHost } from "@vykor/tools";
import type { AgentJobHost } from "@vykor/jobs";
import type { AgentTerminalHost } from "@vykor/terminal";
import { describe, expect, it, vi } from "vitest";

import type {
  AgentCapabilityOverrides,
} from "../../agent/agent-options.js";
import {
  disabledCapability,
  resolveCapability,
  toAgentCapabilitySnapshot,
  toCapabilitySnapshot,
  unavailableCapability,
} from "../capability-resolution.js";

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
