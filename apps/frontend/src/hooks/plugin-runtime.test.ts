import { expect, test } from "bun:test";
import type { SessionRecord } from "@vykor/client";
import { sessionRuntimeMetadata, shouldAutoActivateSession } from "./useServerSync";

function session(pluginsEnabled?: boolean): SessionRecord {
  return {
    id: "session-1",
    cwd: "/repo",
    title: "Session",
    model: "display-model",
    status: "idle",
    metadata: {
      runtime: {
        model: "runtime-model",
        ...(pluginsEnabled === undefined ? {} : { pluginsEnabled }),
      },
    },
    createdAt: 1,
    updatedAt: 1,
  };
}

test("TUI writes an explicit false plugin override into session metadata", () => {
  expect(sessionRuntimeMetadata({ model: "runtime-model", pluginsEnabled: false })).toEqual({
    runtime: { model: "runtime-model", pluginsEnabled: false },
  });
});

test("TUI does not reuse a session with a different plugin mode", () => {
  expect(shouldAutoActivateSession(session(), "runtime-model", false)).toBe(false);
  expect(shouldAutoActivateSession(session(false), "runtime-model", false)).toBe(true);
  expect(shouldAutoActivateSession(session(true), "runtime-model", false)).toBe(false);
});
