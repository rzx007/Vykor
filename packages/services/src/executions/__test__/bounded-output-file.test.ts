import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { appendBoundedOutput, writeBoundedOutput } from "../bounded-output-file.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("bounded execution output files", () => {
  it("keeps the newest bytes while output is appended", () => {
    const path = temporaryFile();
    appendBoundedOutput(path, "1234", 6);
    appendBoundedOutput(path, "5678", 6);
    expect(readFileSync(path, "utf8")).toBe("345678");
  });

  it("bounds a complete output written at once", () => {
    const path = temporaryFile();
    writeBoundedOutput(path, "12345678", 5);
    expect(readFileSync(path, "utf8")).toBe("45678");
  });
});

function temporaryFile(): string {
  const directory = mkdtempSync(join(tmpdir(), "vykor-output-"));
  temporaryDirectories.push(directory);
  return join(directory, "task.log");
}
