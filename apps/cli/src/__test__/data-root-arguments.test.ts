import { Command } from "commander";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { parseDataRootArgument } from "@vykor/host-config/paths";

function parse(argv: string[]) {
  const selected = parseDataRootArgument(argv);
  const command = new Command().exitOverride().configureOutput({ writeErr: () => undefined })
    .option("--system-prompt <text>").option("-p, --print").argument("[prompt]");
  command.parse(selected.argv, { from: "user" });
  return { root: selected.explicitRoot, options: command.opts(), args: command.args };
}

it.each(["--data-root", "--data-root=/literal/prompt"])("preserves Commander option values matching %s", value => {
  expect(parse(["--system-prompt", value, "-p", "hi"]))
    .toEqual({ root: undefined, options: { systemPrompt: value, print: true }, args: ["hi"] });
});
it("accepts a leading root while preserving a later root-like prompt value", () => {
  const root = resolve("fixture-root");
  expect(parse(["--data-root", root, "--system-prompt", "--data-root", "hi"]))
    .toEqual({ root, options: { systemPrompt: "--data-root" }, args: ["hi"] });
});
it("rejects a standalone host root placed after command options", () => {
  expect(() => parse(["-p", "hi", "--data-root", resolve("fixture-root")])).toThrow(/unknown option.*data-root/);
});
