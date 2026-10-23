import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifySandboxFailure,
  createProcess,
  resolveSandboxPolicy,
  SandboxPolicyDeniedError,
  SandboxUnavailableError,
  validateSandboxPath,
} from "../../index.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("resolveSandboxPolicy", () => {
  it("resolves disabled settings into an explicit off policy", () => {
    const policy = resolveSandboxPolicy({
      cwd: ".",
      sessionId: "  session-a  ",
      config: { enabled: false },
    });

    expect(policy).toMatchObject({
      mode: "off",
      enforcement: "off",
      enabled: false,
      failClosed: false,
      scope: {
        cwd: resolve("."),
        workspaceRoot: resolve("."),
        sessionId: "session-a",
      },
    });
  });

  it("distinguishes best-effort, required, and read-only policies", () => {
    const bestEffort = resolveSandboxPolicy({
      cwd: ".",
      config: { enabled: true, failIfUnavailable: false },
    });
    const required = resolveSandboxPolicy({
      cwd: ".",
      config: { enabled: true, failIfUnavailable: true },
    });
    const readOnly = resolveSandboxPolicy({
      cwd: ".",
      config: {
        enabled: true,
        filesystem: { allowRead: ["."], allowWrite: [], extraAllowedRoots: [] },
      },
    });

    expect(bestEffort.enforcement).toBe("best-effort");
    expect(required.enforcement).toBe("required");
    expect(required.failClosed).toBe(true);
    expect(readOnly.mode).toBe("read-only");
  });

  it("creates independent policy values for each call", () => {
    const first = resolveSandboxPolicy({ cwd: "one", config: { enabled: false } });
    const second = resolveSandboxPolicy({ cwd: "two", config: { enabled: true } });

    expect(first.scope.cwd).not.toBe(second.scope.cwd);
    expect(first.enabled).toBe(false);
    expect(second.enabled).toBe(true);
  });
});

describe("policy-backed path validation", () => {
  it("returns a structured policy denial for writes in read-only mode", async () => {
    const root = await temporaryRoot();
    const file = join(root, "notes.txt");
    await writeFile(file, "hello");
    const policy = resolveSandboxPolicy({
      cwd: root,
      config: {
        enabled: true,
        filesystem: { allowRead: ["."], allowWrite: [], extraAllowedRoots: [] },
      },
    });

    const read = await validateSandboxPath(file, {
      sandboxRoot: root,
      operation: "read",
      policy,
    });
    const write = await validateSandboxPath(file, {
      sandboxRoot: root,
      operation: "write",
      policy,
    });

    expect(read).toMatchObject({ allowed: true, decision: "allow" });
    expect(write).toMatchObject({
      allowed: false,
      decision: "deny",
      failureKind: "policy",
      denial: {
        kind: "policy",
        code: "filesystem_denied",
        operation: "write",
      },
    });
  });

  it("does not enforce filesystem rules when policy is off", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    const policy = resolveSandboxPolicy({ cwd: root, config: { enabled: false } });

    const result = await validateSandboxPath(join(outside, "new.txt"), {
      sandboxRoot: root,
      operation: "write",
      policy,
    });

    expect(result).toMatchObject({ allowed: true, decision: "allow" });
  });
});

describe("process policy and failure classification", () => {
  it("uses an explicit per-call policy instead of sandbox settings", async () => {
    const policy = resolveSandboxPolicy({ cwd: process.cwd(), config: { enabled: false } });
    const child = await createProcess(
      [process.execPath, "-e", "process.stdout.write('policy-override-ok')"],
      {
        cwd: process.cwd(),
        policy,
        settings: {
          model: "test",
          apiFormat: "openai",
          maxTurns: 1,
          permission: { mode: "default" },
          sandbox: { enabled: true, failIfUnavailable: true },
        },
      },
    );

    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    await new Promise<void>((resolvePromise, reject) => {
      child.once("error", reject);
      child.once("close", () => resolvePromise());
    });

    expect(output).toBe("policy-override-ok");
  });

  it("classifies policy and runner failures without treating commands as thrown errors", () => {
    expect(classifySandboxFailure(
      new SandboxPolicyDeniedError("filesystem_denied", "write", "denied"),
    )).toBe("policy");
    expect(classifySandboxFailure(new SandboxUnavailableError("missing runner"))).toBe("runner");
    expect(classifySandboxFailure(new Error("command failed"))).toBeUndefined();
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "oh-policy-"));
  tempRoots.push(root);
  return root;
}
