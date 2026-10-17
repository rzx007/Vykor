import { writeFile, copyFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createRunner } from "../../tools/engine.mjs";
import { withFiles } from "../../tools/file-access.mjs";
import { withWorkingFile } from "../../tools/working-file.mjs";
const file = process.argv[2],
  context = {
    signal: new AbortController().signal,
    deadline: Date.now() + 300000,
  };
const run = process.argv[3]
  ? createRunner(process.argv[3], { ...context, cwd: dirname(file) })
  : async () => {};
await withFiles([file], context, () =>
  withWorkingFile(file, run, context, async (work) => {
    if (process.argv[3]) {
      await copyFile(file, work);
      await run(["open", work]);
    } else await writeFile(work, "private interrupted copy");
    process.send({ ready: true, work });
    await new Promise(() => {
      setInterval(() => {}, 1000);
    });
  }),
);
