import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { buildDelegationSection } from "@vykor/prompts";
import { createJobTools } from "@vykor/tools";
import { validateToolInput } from "@vykor/core";

// Exercise the published examples against the real tools' input contract.
it.each(["JobWait", "JobRead", "JobSend", "JobCancel"])("provides an executable %s example that selects a specific child run", name => {
  const code = [...buildDelegationSection().matchAll(/`([^`]+)`/g)].map(match => match[1]!).find(example => example.startsWith(`${name}(`));
  expect(code).toBeDefined();
  const input = runInNewContext(code!, {
    target: { kind: "agent", jobId: "child-1", runId: "run-1" },
    [name]: (value: unknown) => value,
  });
  const tool = createJobTools().find(tool => tool.name === name)!;
  expect(validateToolInput(tool.inputSchema, input)).toBeNull();
  expect(name === "JobWait" ? input.targets[0].target : input.target).toEqual({
    kind: "agent", jobId: "child-1", runId: "run-1",
  });
});
