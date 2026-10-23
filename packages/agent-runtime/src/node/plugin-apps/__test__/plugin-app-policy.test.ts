import type { RunToolBinding } from "@vykor/agent-contracts";
import { expect, it } from "vitest";

import { PLUGIN_APP_DEFAULT_LIMITS, capturedAppToolPolicy, getPluginAppToolPolicy } from "../policy.js";
import { type CapturedPluginAppBackend } from "../plugin-app-backends.js";

it("identifies invalid host policies without using the error message", () => {
  expect(() => getPluginAppToolPolicy({ name: "save", description: "Save", inputSchema: {},
    policy: { confirmation: "required", maxArgumentsBytes: 0 } })).toThrowError(expect.objectContaining({ code: "plugin_app_invalid_policy" }));
});

it("never derives automatic approval from MCP hints, dual visibility, a quota alone or missing installed permission", () => {
  const binding: RunToolBinding = { ownerPluginId: "p", definition: { name: "mcp__notes__save", description: "Save", inputSchema: {},
    ui: { visibility: ["app"] }, execute: async () => ({ content: [] }) }, invoke: async () => ({ content: [] }) };
  const capture = { pluginId: "p", pluginDataWriteApproved: true,
    definition: { id: "notes", kind: "mcp-server", server: "notes", toolPolicies: [{ tool: "save", authorization: "plugin-data-write", maxArgumentsBytes: 1024 * 1024 }] },
    tools: new Map([["save", binding]]) } as unknown as CapturedPluginAppBackend;
  expect(capturedAppToolPolicy(capture, "save")).toEqual({ confirmation: "granted", authorization: "plugin-data-write", maxArgumentsBytes: 1024 * 1024 });
  expect(capturedAppToolPolicy({ ...capture, pluginDataWriteApproved: false }, "save").confirmation).toBe("required");
  const dual = { ...binding, definition: { ...binding.definition, ui: { visibility: ["model", "app"] as Array<"model" | "app"> } } };
  expect(capturedAppToolPolicy({ ...capture, tools: new Map([["save", dual]]) }, "save").confirmation).toBe("required");
  expect(capturedAppToolPolicy({ ...capture, definition: { ...capture.definition, toolPolicies: [{ tool: "save", maxArgumentsBytes: 1024 * 1024 }] } }, "save"))
    .toEqual({ confirmation: "required", maxArgumentsBytes: 1024 * 1024 });
  expect(capturedAppToolPolicy({ ...capture, definition: { ...capture.definition, toolPolicies: undefined } }, "save"))
    .toEqual({ confirmation: "required", maxArgumentsBytes: PLUGIN_APP_DEFAULT_LIMITS.argsBytes });
  expect(() => capturedAppToolPolicy(capture, "foreign")).toThrow("unavailable");
});
