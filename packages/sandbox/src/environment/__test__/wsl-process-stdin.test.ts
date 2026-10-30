import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { spawnWslProcess } from "../wsl-environment.js";

const distributions = process.platform === "win32"
  ? spawnSync("wsl.exe", ["--list", "--quiet"], { windowsHide: true, timeout: 5000 }).stdout
    ?.toString("utf16le").split(/\r?\n/).map(value => value.trim()).filter(Boolean)
  : [];
const distribution = distributions?.find(value => /ubuntu/i.test(value));

it.skipIf(!distribution).each([false, true])("passes stdin to a real WSL process with cancellation supervision=%s", async supervised => {
  const child = spawnWslProcess({
    argv: ["/bin/cat"], cwd: "/tmp", distribution,
    ...(supervised ? { signal: new AbortController().signal } : {}),
  });
  let output = "", errorOutput = "";
  child.stdout!.on("data", chunk => { output += chunk.toString("utf8"); });
  child.stderr!.on("data", chunk => { errorOutput += chunk.toString("utf8"); });
  child.stdin!.on("error", () => {});
  const exit = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  child.stdin!.end("stdin survives supervision\n");
  try {
    expect(await exit, errorOutput).toBe(0);
    expect(output).toBe("stdin survives supervision\n");
  } finally {
    child.kill();
  }
}, 20_000);
