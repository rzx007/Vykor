import { mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { writeJsonFileAtomically } from "./atomic-json-write.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("writeJsonFileAtomically", () => {
  it("writes a same-directory temporary file before replacing the target", async () => {
    const directory = await createTemporaryDirectory();
    const target = join(directory, "settings.json");
    await writeFile(target, JSON.stringify({ value: "old" }), "utf8");
    const calls: string[] = [];

    await writeJsonFileAtomically(target, { value: "new" }, {
      async writeFile(path, content, encoding) {
        calls.push(`write:${String(path)}`);
        await writeFile(path, content, encoding);
      },
      async rename(from, to) {
        calls.push(`rename:${String(from)}->${String(to)}`);
        await rename(from, to);
      },
      rm,
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatch(new RegExp(`^write:${escapeRegex(target)}\\..+\\.tmp$`, "i"));
    expect(calls[1]).toMatch(
      new RegExp(`^rename:${escapeRegex(target)}\\..+\\.tmp->${escapeRegex(target)}$`, "i"),
    );
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ value: "new" });
    expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("preserves the old target and removes the temporary file when rename fails", async () => {
    const directory = await createTemporaryDirectory();
    const target = join(directory, "settings.json");
    const oldContent = JSON.stringify({ value: "old" });
    await writeFile(target, oldContent, "utf8");
    const failure = new Error("rename failed");

    await expect(
      writeJsonFileAtomically(target, { value: "new" }, {
        writeFile,
        async rename() {
          throw failure;
        },
        rm,
      }),
    ).rejects.toBe(failure);

    expect(await readFile(target, "utf8")).toBe(oldContent);
    expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "vykor-atomic-settings-"));
  temporaryDirectories.push(directory);
  return directory;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
