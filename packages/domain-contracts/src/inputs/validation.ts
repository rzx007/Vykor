import { SESSION_INPUT_LIMITS, type SessionUserInputItem, type SkillSource, type PromptAttachment } from "./items.js";
import type { AttachmentIntent } from "../attachments/records.js";
import { DomainValidationError } from "../validation-error.js";
export { DomainValidationError } from "../validation-error.js";
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F-\u009F]/
const TEXT_CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/

export function validateSessionUserInputItems(
  items: readonly SessionUserInputItem[],
): SessionUserInputItem[] {
  if (items.length > SESSION_INPUT_LIMITS.maxItems) throw new DomainValidationError("item_limit_exceeded")

  let skillCount = 0
  let textBytes = 0
  for (const item of items) {
    if (item.type === "text") {
      assertValidText(item.text)
      textBytes += new TextEncoder().encode(item.text).byteLength
      continue
    }

    if (item.type === "context") {
      if (item.kind !== "conversation") throw new DomainValidationError("invalid_context_kind")
      assertValidString(item.id, "id")
      assertValidString(item.displayName, "displayName")
      assertMaximumLength(item.id, SESSION_INPUT_LIMITS.maxNameChars, "id")
      assertMaximumLength(item.displayName, SESSION_INPUT_LIMITS.maxDisplayNameChars, "displayName")
      continue
    }

    if (item.type === "capability") {
      if (item.kind !== "plugin" && item.kind !== "plugin_agent") throw new DomainValidationError("invalid_capability_kind")
      assertValidString(item.pluginId, "pluginId")
      assertValidString(item.displayName, "displayName")
      assertMaximumLength(item.pluginId, SESSION_INPUT_LIMITS.maxNameChars, "pluginId")
      assertMaximumLength(item.displayName, SESSION_INPUT_LIMITS.maxDisplayNameChars, "displayName")
      if (item.kind === "plugin_agent") {
        assertValidString(item.agentId, "agentId")
        assertMaximumLength(item.agentId, SESSION_INPUT_LIMITS.maxNameChars, "agentId")
      }
      continue
    }

    assertValidString(item.name, "name")
    assertValidString(item.path, "path")
    assertMaximumLength(item.name, SESSION_INPUT_LIMITS.maxNameChars, "name")
    if (item.displayName !== undefined) {
      assertValidString(item.displayName, "displayName")
      assertMaximumLength(item.displayName, SESSION_INPUT_LIMITS.maxDisplayNameChars, "displayName")
    }
    if (item.type === "skill") {
      skillCount += 1
      if (item.source !== undefined && !isSkillSource(item.source)) throw new DomainValidationError("invalid_skill_source")
    }
  }

  if (skillCount > SESSION_INPUT_LIMITS.maxSkills) throw new DomainValidationError("skill_item_limit_exceeded")
  if (textBytes > SESSION_INPUT_LIMITS.maxTextBytes) throw new DomainValidationError("text_byte_limit_exceeded")
  return [...items]
}

export function normalizeSessionUserInputItems(
  items: readonly SessionUserInputItem[],
): SessionUserInputItem[] {
  const normalized: SessionUserInputItem[] = []
  for (const item of validateSessionUserInputItems(items)) {
    if (item.type !== "text") {
      normalized.push(item)
    } else if (item.text.length > 0) {
      const previous = normalized.at(-1)
      if (previous?.type === "text") previous.text += item.text
      else normalized.push({ type: "text", text: item.text })
    }
  }
  return normalized
}

export function sessionUserInputText(items: readonly SessionUserInputItem[]): string {
  return normalizeSessionUserInputItems(items)
    .map((item) => item.type === "text"
      ? item.text
      : item.type === "context" || item.type === "capability"
        ? `@${item.displayName}`
        : `$${item.name}`)
    .join("")
}

function assertValidString(value: string, field: string): void {
  if (typeof value !== "string" || CONTROL_CHARACTER_PATTERN.test(value)) throw new DomainValidationError(`invalid_${field}`)
}

function assertValidText(value: string): void {
  if (typeof value !== "string" || TEXT_CONTROL_CHARACTER_PATTERN.test(value)) throw new DomainValidationError("invalid_text")
}

function assertMaximumLength(value: string, maximum: number, field: string): void {
  if (value.length > maximum) throw new DomainValidationError(`${field}_limit_exceeded`)
}

function isSkillSource(value: string): value is SkillSource {
  return value === "bundled" || value === "user" || value === "project" || value === "plugin"
}

type JsonRecord = Record<string, unknown>;
export function parseSessionInputItems(value: unknown): SessionUserInputItem[] {
  if (!Array.isArray(value)) {
    throw new DomainValidationError("items must be an array", "items");
  }
  const items = value.map((entry, index): SessionUserInputItem => {
    const field = `items[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new DomainValidationError(`${field} must be an object`, field);
    }
    const item = entry as JsonRecord;
    if (item.type === "text") {
      if (typeof item.text !== "string") {
        throw new DomainValidationError(
          `${field}.text must be a string`,
          `${field}.text`,
        );
      }
      return { type: "text", text: item.text };
    }
    if (item.type === "context") {
      if (
        item.kind !== "conversation" ||
        typeof item.id !== "string" ||
        typeof item.displayName !== "string"
      ) {
        throw new DomainValidationError(
          `${field} requires kind, id and displayName`,
          field,
        );
      }
      return {
        type: "context",
        kind: "conversation",
        id: item.id,
        displayName: item.displayName,
      };
    }
    if (item.type === "capability") {
      if (
        (item.kind !== "plugin" && item.kind !== "plugin_agent") ||
        typeof item.pluginId !== "string" ||
        typeof item.displayName !== "string" ||
        (item.kind === "plugin_agent" && typeof item.agentId !== "string")
      ) {
        throw new DomainValidationError(
          `${field} requires a valid kind, pluginId, displayName and agentId`,
          field,
        );
      }
      return item.kind === "plugin"
        ? {
            type: "capability",
            kind: "plugin",
            pluginId: item.pluginId,
            displayName: item.displayName,
          }
        : {
            type: "capability",
            kind: "plugin_agent",
            pluginId: item.pluginId,
            agentId: item.agentId as string,
            displayName: item.displayName,
          };
    }
    if (item.type !== "skill" && item.type !== "mention") {
      throw new DomainValidationError(
        `${field}.type is invalid`,
        `${field}.type`,
      );
    }
    if (typeof item.name !== "string" || typeof item.path !== "string") {
      throw new DomainValidationError(
        `${field} requires name and path`,
        field,
      );
    }
    if (
      item.displayName !== undefined &&
      typeof item.displayName !== "string"
    ) {
      throw new DomainValidationError(
        `${field}.displayName must be a string`,
        `${field}.displayName`,
      );
    }
    if (item.type === "mention") {
      return {
        type: "mention",
        name: item.name,
        path: item.path,
        ...(typeof item.displayName === "string"
          ? { displayName: item.displayName }
          : {}),
      };
    }
    if (
      item.source !== undefined &&
      item.source !== "bundled" &&
      item.source !== "user" &&
      item.source !== "project" &&
      item.source !== "plugin"
    ) {
      throw new DomainValidationError(
        `${field}.source is invalid`,
        `${field}.source`,
      );
    }
    return {
      type: "skill",
      name: item.name,
      path: item.path,
      ...(typeof item.displayName === "string"
        ? { displayName: item.displayName }
        : {}),
      ...(item.source !== undefined
        ? { source: item.source as SkillSource }
        : {}),
    };
  });
  try {
    return normalizeSessionUserInputItems(items);
  } catch (error) {
    if (!(error instanceof DomainValidationError)) throw error;
    throw new DomainValidationError(
      error instanceof DomainValidationError ? error.message : "items are invalid",
      "items",
    );
  }
}

export function parsePromptAttachments(
  value: unknown,
): PromptAttachment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new DomainValidationError(
      "attachments must be an array",
      "attachments",
    );
  }
  return value.map((entry, index) => {
    const field = `attachments[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new DomainValidationError(`${field} must be an object`, field);
    }
    const item = entry as JsonRecord;
    const assetId = item.assetId;
    if (typeof assetId !== "string" || assetId.length === 0) {
      throw new DomainValidationError(
        `${field}.assetId must be a non-empty string`,
        `${field}.assetId`,
      );
    }
    const intent = item.intent;
    const allowedIntents = [
      "auto",
      "vision",
      "ocr",
      "document",
      "tool_resource",
      "workspace_reference",
    ] as const satisfies readonly AttachmentIntent[];
    if (
      intent !== undefined &&
      (typeof intent !== "string" ||
        !allowedIntents.includes(intent as AttachmentIntent))
    ) {
      throw new DomainValidationError(
        `${field}.intent must be one of: ${allowedIntents.join(", ")}`,
        `${field}.intent`,
      );
    }
    const displayName = item.displayName;
    if (displayName !== undefined && typeof displayName !== "string") {
      throw new DomainValidationError(
        `${field}.displayName must be a string`,
        `${field}.displayName`,
      );
    }
    return {
      assetId,
      ...(intent !== undefined ? { intent: intent as AttachmentIntent } : {}),
      ...(displayName !== undefined ? { displayName } : {}),
    };
  });
}
