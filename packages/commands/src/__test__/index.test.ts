import { describe, it, expect } from "vitest";
import { CommandRegistry } from "../index.js";
import type { CommandDefinition, CommandContext, CommandResult } from "../index.js";

describe("CommandRegistry", () => {
  it("registers and gets a command", () => {
    const reg = new CommandRegistry();
    const cmd: CommandDefinition = {
      name: "hello",
      description: "says hello",
      handler: async () => ({ success: true, output: "hi" }),
    };
    reg.register(cmd);
    expect(reg.get("hello")).toBe(cmd);
  });

  it("registers aliases", () => {
    const reg = new CommandRegistry();
    const cmd: CommandDefinition = {
      name: "hello",
      description: "says hello",
      aliases: ["h", "hi"],
      handler: async () => ({ success: true, output: "hi" }),
    };
    reg.register(cmd);
    expect(reg.get("h")).toBe(cmd);
    expect(reg.get("hi")).toBe(cmd);
  });

  it("unregisters command and aliases", () => {
    const reg = new CommandRegistry();
    reg.register({
      name: "hello",
      description: "says hello",
      aliases: ["h"],
      handler: async () => ({ success: true }),
    });
    expect(reg.unregister("hello")).toBe(true);
    expect(reg.get("hello")).toBeUndefined();
    expect(reg.get("h")).toBeUndefined();
  });

  it("unregister returns false for unknown command", () => {
    const reg = new CommandRegistry();
    expect(reg.unregister("nope")).toBe(false);
  });

  it("list returns unique commands (no alias duplicates)", () => {
    const reg = new CommandRegistry();
    reg.register({
      name: "hello",
      description: "says hello",
      aliases: ["h"],
      handler: async () => ({ success: true }),
    });
    reg.register({
      name: "bye",
      description: "says bye",
      handler: async () => ({ success: true }),
    });
    const list = reg.list();
    expect(list).toHaveLength(2);
  });

  it("executes a command", async () => {
    const reg = new CommandRegistry();
    reg.register({
      name: "echo",
      description: "echoes input",
      handler: async (ctx: CommandContext) => ({
        success: true,
        output: ctx.raw,
      }),
    });
    const result = await reg.execute("echo", { args: {}, raw: "hello" });
    expect(result.success).toBe(true);
    expect(result.output).toBe("hello");
  });

  it("execute returns error for unknown command", async () => {
    const reg = new CommandRegistry();
    const result = await reg.execute("nope", { args: {}, raw: "" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown command");
  });

  it("execute catches handler errors", async () => {
    const reg = new CommandRegistry();
    reg.register({
      name: "fail",
      description: "always fails",
      handler: async () => {
        throw new Error("boom");
      },
    });
    const result = await reg.execute("fail", { args: {}, raw: "" });
    expect(result.success).toBe(false);
    expect(result.error).toBe("boom");
  });

  it("execute resolves alias", async () => {
    const reg = new CommandRegistry();
    reg.register({
      name: "hello",
      description: "says hello",
      aliases: ["h"],
      handler: async () => ({ success: true, output: "hi" }),
    });
    const result = await reg.execute("h", { args: {}, raw: "" });
    expect(result.success).toBe(true);
    expect(result.output).toBe("hi");
  });
});
