import { describe, expect, it } from "vitest";
import { readWorkspaceChangesMetadata } from "./workspace-changes.js";

const summary = { version: 1, status: "complete", repositoryRoot: "D:/repo", files: [{ path: "src/a.ts", status: "modified", lines: 7 }], fileCount: 1, totalLines: 7, truncated: false };
describe("bounded workspace changes", () => {
  it("reads summary facts and strips arbitrary patch/body fields", () => {
    expect(readWorkspaceChangesMetadata({ ...summary, patch: "secret", files: [{ ...summary.files[0], body: "secret" }] })).toEqual(summary);
  });
  it.each([
    { status: "unavailable" }, { files: [{ path: "../secret", status: "added", lines: 0 }] },
    { repositoryRoot: "relative" }, { files: Array.from({ length: 129 }, (_, i) => ({ path: `${i}.ts`, status: "added", lines: 0 })) },
    { files: [{ path: ".env\n", status: "added", lines: 0 }] }, { fileCount: 0 }, { totalLines: -1 },
    { status: "captured" }, { reason: "invented_reason" },
  ])("rejects malformed or oversized observations %#", (bad) => {
    expect(readWorkspaceChangesMetadata({ ...summary, ...bad })).toBeUndefined();
  });
  it("keeps unavailability distinct from a successful empty repository observation", () => {
    expect(readWorkspaceChangesMetadata({ version: 1, status: "unavailable", reason: "concurrent_run_overlap", files: [], fileCount: 0, totalLines: 0, truncated: false })?.status).toBe("unavailable");
  });
});
