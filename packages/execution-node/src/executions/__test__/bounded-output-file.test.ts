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

  it("retains the first complete UTF-8 characters and reports actual rejected bytes", () => {
    const path = temporaryFile();
    expect(appendBoundedOutput(path, "A界B", 4, "prefix")).toEqual({ retainedBytes: 4, discardedBytes: 1 });
    expect(readFileSync(path, "utf8")).toBe("A界");
    expect(appendBoundedOutput(path, "C", 4, "prefix")).toEqual({ retainedBytes: 0, discardedBytes: 1 });
    expect(readFileSync(path, "utf8")).toBe("A界");
  });

  it("does not report loss when the prefix exactly fills its byte limit", () => {
    const path = temporaryFile();
    expect(appendBoundedOutput(path, "界", 3, "prefix")).toEqual({ retainedBytes: 3, discardedBytes: 0 });
  });

  it("preserves a UTF-8 BOM when prefix input is a Buffer", () => {
    const path = temporaryFile();
    expect(appendBoundedOutput(path, Buffer.from("\uFEFFabc"), 6, "prefix")).toEqual({ retainedBytes: 6, discardedBytes: 0 });
    expect(readFileSync(path, "utf8")).toBe("\uFEFFabc");
  });
});

function temporaryFile(): string {
  const directory = mkdtempSync(join(tmpdir(), "vykor-output-"));
  temporaryDirectories.push(directory);
  return join(directory, "task.log");
}
