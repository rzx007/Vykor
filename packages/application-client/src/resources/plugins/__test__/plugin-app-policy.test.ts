import { expect, it } from "vitest";
import type { PluginAppToolDescriptor, PluginAppToolPolicy } from "@vykor/protocol";
import { getPluginAppToolPolicy } from "../plugin-app-policy.js";

const descriptor = (policy: PluginAppToolPolicy): PluginAppToolDescriptor => ({ name: "save", description: "save data", inputSchema: {}, policy });

it("uses the existing conservative display fallback for descriptors without policy", () => {
  expect(getPluginAppToolPolicy()).toEqual({ confirmation: "required", maxArgumentsBytes: 64 * 1024 });
});

it("copies a computed server descriptor policy without granting new rights", () => {
  const policy: PluginAppToolPolicy = { confirmation: "granted", authorization: "plugin-data-write", maxArgumentsBytes: 128 * 1024 };
  expect(getPluginAppToolPolicy(descriptor(policy))).toEqual(policy);
  expect(getPluginAppToolPolicy(descriptor(policy))).not.toBe(policy);
  expect(getPluginAppToolPolicy(descriptor({ confirmation: "required", maxArgumentsBytes: 64 * 1024 * 1024 })).maxArgumentsBytes).toBe(64 * 1024 * 1024);
});

it("rejects malformed descriptor policies with the existing error", () => {
  for (const policy of [
    { confirmation: "granted", maxArgumentsBytes: 1 },
    { confirmation: "required", maxArgumentsBytes: 0 },
    { confirmation: "required", maxArgumentsBytes: 64 * 1024 * 1024 + 1 },
    { confirmation: "required", maxArgumentsBytes: 1.5 },
    { confirmation: "unknown", maxArgumentsBytes: 1 },
    { confirmation: "required", maxArgumentsBytes: 1, authorization: "unknown" },
  ]) expect(() => getPluginAppToolPolicy(descriptor(policy as PluginAppToolPolicy))).toThrow("plugin_app_invalid_policy");
});
