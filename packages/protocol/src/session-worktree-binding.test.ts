import { describe, expect, it } from "vitest";
import {
  parseClearSessionWorktreeBindingRequest,
  ProtocolValidationError,
} from "./requests.js";
import {
  decodeClearedSessionWorktreeBinding,
  ProtocolDataError,
} from "./serialization.js";
describe("worktree binding maintenance input", () => {
  it("only accepts the exact expected binding and rejects mutable session fields", () => {
    const binding = {
      id: "worktree",
      path: "/tasks/worktree",
      branch: "vykor/task",
    };
    expect(parseClearSessionWorktreeBindingRequest(binding)).toEqual(binding);
    for (const invalid of [
      null,
      {},
      { ...binding, id: "" },
      { ...binding, path: "\0" },
      { ...binding, metadata: {} },
      { ...binding, title: "change title" },
    ])
      expect(() => parseClearSessionWorktreeBindingRequest(invalid)).toThrow(
        ProtocolValidationError,
      );
  });
  it("only accepts a saved acknowledgement with the binding removed from the expected archived session", () => {
    const session = {
      id: "session",
      cwd: "/tasks/worktree",
      title: "",
      model: "m",
      status: "archived",
      createdAt: 1,
      updatedAt: 2,
      metadata: { desktop: { settingsRoot: "/project" } },
    };
    expect(
      decodeClearedSessionWorktreeBinding(session, "session").metadata,
    ).toEqual(session.metadata);
    for (const invalid of [
      { ...session, id: "other" },
      { ...session, status: "idle" },
      { ...session, metadata: { desktop: { worktree: {} } } },
      { id: "session" },
    ])
      expect(() =>
        decodeClearedSessionWorktreeBinding(invalid, "session"),
      ).toThrow(ProtocolDataError);
  });
});
