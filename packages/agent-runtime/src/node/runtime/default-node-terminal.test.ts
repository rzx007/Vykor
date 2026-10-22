import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentJobHost } from "@vykor/jobs";
import type { AgentTerminalHost } from "@vykor/terminal";
import { describe, expect, it, vi } from "vitest";

import type {
  CreatedCapability,
  DefaultNodeTerminalProducer,
} from "./default-node-terminal.js";
import {
  createDefaultNodeTerminal,
  resolveDefaultNodeTerminal,
} from "./default-node-terminal.js";

describe("createDefaultNodeTerminal", () => {
  it("creates one owned bundle containing both terminal and job hosts", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "vykor-default-terminal-"));

    try {
      const created = await createDefaultNodeTerminal({
        cwd,
        sessionId: "session-1",
      });

      expect(created.value.value.open).toBeTypeOf("function");
      expect(created.value.jobs.list).toBeTypeOf("function");
      expect(created.cleanup).toBeTypeOf("function");
      expect(created.cleanupIdentity).toBeTypeOf("object");
      await expect(created.cleanup()).resolves.toBeUndefined();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("resolveDefaultNodeTerminal", () => {
  it("creates and owns a local terminal when the override is omitted", async () => {
    const created = fakeCreatedTerminal();
    const createLocal = vi.fn(async () => created);

    const result = await resolveDefaultNodeTerminal({
      override: undefined,
      createLocal,
    });

    expect(createLocal).toHaveBeenCalledOnce();
    expect(result).toEqual({
      status: "available",
      source: "default",
      ...created,
    });
  });

  it("borrows a host terminal without creating or owning it", async () => {
    const override = fakeTerminalProducer();
    const createLocal = vi.fn(async () => fakeCreatedTerminal());

    const result = await resolveDefaultNodeTerminal({ override, createLocal });

    expect(createLocal).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: "available",
      source: "override",
      value: override,
    });
    expect("cleanup" in result).toBe(false);
    expect("cleanupIdentity" in result).toBe(false);
  });

  it("disables the terminal without creating a local provider", async () => {
    const createLocal = vi.fn(async () => fakeCreatedTerminal());

    const result = await resolveDefaultNodeTerminal({
      override: false,
      createLocal,
    });

    expect(createLocal).not.toHaveBeenCalled();
    expect(result).toEqual({ status: "disabled" });
  });

  it("preserves a local terminal creation failure", async () => {
    const failure = new Error("local terminal failed");

    await expect(resolveDefaultNodeTerminal({
      override: undefined,
      createLocal: async () => { throw failure; },
    })).rejects.toBe(failure);
  });
});

function fakeCreatedTerminal(): CreatedCapability<DefaultNodeTerminalProducer> {
  return {
    value: fakeTerminalProducer(),
    cleanup: async () => {},
    cleanupIdentity: {},
  };
}

function fakeTerminalProducer(): DefaultNodeTerminalProducer {
  return {
    value: {
      async open() {
        throw new Error("not used");
      },
    } satisfies AgentTerminalHost,
    jobs: {} as AgentJobHost,
  };
}
