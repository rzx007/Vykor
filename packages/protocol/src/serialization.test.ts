import { describe, expect, it } from "vitest";

import type {
  SessionEventRecord,
  SessionStateSnapshot,
} from "./session.js";
import {
  decodeJobSnapshot,
  decodeSessionStateSnapshot,
  decodeTerminalEvent,
  decodeTerminalSessionInfo,
  deserializeSessionEventRecord,
  deserializeSessionStateSnapshot,
  ProtocolDataError,
  serializeSessionEventRecord,
  serializeSessionStateSnapshot,
} from "./serialization.js";

const snapshot: SessionStateSnapshot = {
  cursor: 7,
  session: {
    id: "s1",
    cwd: "/repo",
    title: "Review",
    model: "gpt-test",
    status: "idle",
    metadata: { runtime: { model: "gpt-test" } },
    createdAt: 1,
    updatedAt: 2,
  },
  inputs: [
    {
      id: "i1",
      sessionId: "s1",
      seq: 1,
      delivery: "queue",
      content: "Review this",
      attachments: [],
      metadata: {},
      createdAt: 2,
    },
  ],
  messages: [],
  parts: [],
  runs: [],
  attempts: [],
  tasks: [],
  permissions: [],
};

const event: SessionEventRecord = {
  id: "e1",
  seq: 7,
  type: "session.updated",
  schemaVersion: 1,
  sessionId: "s1",
  payload: { title: "Review" },
  createdAt: 3,
};

describe("protocol serialization", () => {
  it("round-trips a Session snapshot through JSON", () => {
    const text = serializeSessionStateSnapshot(snapshot);
    expect(deserializeSessionStateSnapshot(text)).toEqual(snapshot);
  });

  it("round-trips a Session event envelope through JSON", () => {
    const text = serializeSessionEventRecord(event);
    expect(deserializeSessionEventRecord(text)).toEqual(event);
  });

  it("reports the exact path of malformed snapshot data", () => {
    expect(() =>
      decodeSessionStateSnapshot({
        ...snapshot,
        inputs: [{ ...snapshot.inputs[0], seq: "first" }],
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ProtocolDataError>>({
        code: "invalid_protocol_data",
        details: { path: "snapshot.inputs[0].seq" },
      }),
    );
  });

  it("requires and validates ordered input attachment records", () => {
    const { attachments: _attachments, ...legacyInput } = snapshot.inputs[0]!;
    expect(() =>
      decodeSessionStateSnapshot({
        ...snapshot,
        inputs: [legacyInput],
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ProtocolDataError>>({
        details: { path: "snapshot.inputs[0].attachments" },
      }),
    );

    expect(() =>
      decodeSessionStateSnapshot({
        ...snapshot,
        inputs: [{
          ...snapshot.inputs[0],
          attachments: [{
            id: "ref_1",
            sessionId: "s1",
            inputId: "i1",
            assetId: "att_1",
            seq: 0,
            intent: "describe",
            displayName: "screen.png",
            mediaType: "image/png",
            sizeBytes: 42,
            metadata: {},
            createdAt: 3,
          }],
        }],
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ProtocolDataError>>({
        details: { path: "snapshot.inputs[0].attachments[0].intent" },
      }),
    );
  });

  it("decodes typed attachment and transformation message parts", () => {
    const decoded = decodeSessionStateSnapshot({
      ...snapshot,
      parts: [
        {
          id: "part_attachment",
          sessionId: "s1",
          messageId: "m1",
          seq: 1,
          type: "attachment",
          status: "completed",
          assetId: "att_1",
          intent: "vision",
          displayName: "screen.png",
          mediaType: "image/png",
          sizeBytes: 42,
          metadata: { inputAttachmentId: "ref_1" },
          createdAt: 3,
          updatedAt: 3,
        },
        {
          id: "part_transformation",
          sessionId: "s1",
          messageId: "m1",
          seq: 2,
          type: "transformation",
          status: "running",
          assetId: "att_1",
          kind: "direct",
          processor: "native-image-router",
          metadata: {},
          createdAt: 4,
          updatedAt: 4,
        },
      ],
    });

    expect(decoded.parts).toMatchObject([
      { type: "attachment", assetId: "att_1", intent: "vision" },
      { type: "transformation", assetId: "att_1", kind: "direct" },
    ]);
  });

  it("rejects malformed JSON before reading an event", () => {
    expect(() => deserializeSessionEventRecord("{")).toThrow(
      "Protocol data must be valid JSON",
    );
  });

  it("decodes portable Job and Terminal responses", () => {
    expect(
      decodeJobSnapshot({
        id: "job-1",
        kind: "shell",
        label: "tests",
        ownerSession: "s1",
        status: "running",
        capabilities: { read: true, wait: true, send: false, cancel: true },
        cwd: "/repo",
        startedAt: 1,
        updatedAt: 2,
      }).id,
    ).toBe("job-1");

    expect(
      decodeTerminalSessionInfo({
        id: "terminal-1",
        name: "Terminal",
        scope: { kind: "session", sessionId: "s1" },
        sessionId: "s1",
        runtime: "local",
        source: "user",
        status: "running",
        cwd: "/repo",
        shell: "pwsh",
        cols: 120,
        rows: 30,
        createdAt: "2026-08-22T00:00:00.000Z",
      }).id,
    ).toBe("terminal-1");

    expect(() => decodeTerminalSessionInfo({
      id: "terminal-2",
      name: "Terminal",
      scope: { kind: "session", sessionId: "s1" },
      sessionId: "different",
      runtime: "local",
      source: "user",
      status: "running",
      cwd: "/repo",
      shell: "pwsh",
      cols: 120,
      rows: 30,
      createdAt: "2026-08-22T00:00:00.000Z",
    })).toThrow("terminal.sessionId must match terminal.scope.sessionId");

    expect(
      decodeTerminalEvent({
        type: "data",
        terminalId: "terminal-1",
        data: "ok",
        sequence: 1,
      }),
    ).toEqual({
      type: "data",
      terminalId: "terminal-1",
      data: "ok",
      sequence: 1,
    });
  });

  it("preserves actual Job exit results and rejects invalid codes", () => {
    const legacy = {
      id: "job-1", kind: "shell", label: "tests", ownerSession: "s1",
      status: "failed", capabilities: { read: true, wait: true, send: false, cancel: false },
      cwd: "/repo", startedAt: 1, updatedAt: 2,
    };
    expect(decodeJobSnapshot(legacy).exitCode).toBeUndefined();
    for (const exitCode of [0, 7, null]) {
      expect(decodeJobSnapshot({ ...legacy, exitCode }).exitCode).toBe(exitCode);
    }
    for (const exitCode of ["7", NaN, Infinity, 1.5]) {
      expect(() => decodeJobSnapshot({ ...legacy, exitCode })).toThrow();
    }
  });
});
