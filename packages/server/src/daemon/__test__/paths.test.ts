import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createDaemonRegistryEntry,
  readDaemonRegistry,
  writeDaemonRegistry,
} from "../paths.js";

function tempPath(): string {
  return join(mkdtempSync(join(tmpdir(), "vk-registry-")), "registry.json");
}

describe("daemon registry execution surface", () => {
  it("round-trips the execution surface", () => {
    const path = tempPath();
    const entry = createDaemonRegistryEntry({
      url: "http://127.0.0.1:1234",
      pid: 7,
      token: "t",
      storePath: "sessions.db",
      version: "1.0.0",
      executionSurface: "desktop_managed",
      startedAt: 123,
    });
    writeDaemonRegistry(entry, path);
    expect(readDaemonRegistry(path)).toEqual(entry);
  });

  it("tolerates a legacy registry without an execution surface", () => {
    const path = tempPath();
    writeFileSync(
      path,
      JSON.stringify({
        url: "http://127.0.0.1:1234",
        pid: 7,
        token: "t",
        storePath: "sessions.db",
        startedAt: 1,
        version: "1.0.0",
      }),
    );
    expect(readDaemonRegistry(path)?.executionSurface).toBeUndefined();
  });
});
