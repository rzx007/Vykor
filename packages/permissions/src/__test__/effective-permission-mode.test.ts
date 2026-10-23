import type { ApprovalMode, WorkMode } from "@vykor/agent-contracts/permissions";
import { expect, it } from "vitest";
import { effectivePermissionMode } from "../effective-permission-mode.js";

it.each<[ApprovalMode, WorkMode, "default" | "plan" | "full_auto"]>([
  ["ask", "execute", "default"],
  ["auto_review", "execute", "default"],
  ["full_access", "execute", "full_auto"],
  ["ask", "plan", "plan"],
  ["auto_review", "plan", "plan"],
  ["full_access", "plan", "plan"],
])("preserves the permission ceiling for %s / %s", (approval, work, expected) => {
  expect(effectivePermissionMode(approval, work)).toBe(expected);
});
