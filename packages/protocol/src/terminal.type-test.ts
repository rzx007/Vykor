import type { TerminalCreateRequest } from "./terminal.js";

const request: TerminalCreateRequest = {
  scope: { kind: "session", sessionId: "session-1" },
  runtime: "environment",
  cols: 120,
  rows: 30,
};
void request;

// @ts-expect-error scope is required
const missingScope: TerminalCreateRequest = { runtime: "local", cols: 80, rows: 24 };
void missingScope;

// @ts-expect-error projectId is only valid inside scope
const legacyProject: TerminalCreateRequest = { projectId: "project-1", runtime: "local", cols: 80, rows: 24 };
void legacyProject;

// @ts-expect-error sessionId is only valid inside scope
const legacySession: TerminalCreateRequest = { sessionId: "session-1", runtime: "local", cols: 80, rows: 24 };
void legacySession;
