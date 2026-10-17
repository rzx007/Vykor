import { test } from "node:test";
import assert from "node:assert/strict";
import { createRunner } from "../tools/engine.mjs";
test("Office runner optional command limit is honored", async () => {
  const context = {
    cwd: process.cwd(),
    signal: new AbortController().signal,
    deadline: Date.now() + 30000,
    commandTimeoutMs: 1000,
  };
  await assert.rejects(
    () =>
      createRunner(
        process.execPath,
        context,
      )(["-e", "setTimeout(()=>{},5000)"]),
    /超时/,
  );
  assert.equal(
    await createRunner(process.execPath, {
      ...context,
      commandTimeoutMs: 3000,
    })(["-e", 'setTimeout(()=>process.stdout.write("ok"),1200)']),
    "ok",
  );
});
