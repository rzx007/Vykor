import { parseAttachmentLimits, type AttachmentLimits } from "./attachment.js";

export const CURRENT_PROTOCOL_VERSION = 5;
export const PROTOCOL_VERSION_HEADER = "x-vykor-protocol-version";

export interface ProtocolVersion {
  version: number;
}

export interface ServerCapabilities {
  serverVersion: string;
  protocol: ProtocolVersion;
  features: Record<string, number>;
  attachments?: AttachmentTransferCapabilities;
  agentEnvironments?: AgentEnvironmentCapabilities;
}

export interface AgentEnvironmentCapabilities {
  native: true;
  wsl: boolean;
}

export type AttachmentUploadMode = "single" | "resumable";

export interface AttachmentTransferCapabilities {
  limits: AttachmentLimits;
  uploadModes: readonly ["single"] | readonly ["single", "resumable"];
}

export interface ClientProtocolSupport {
  version: number;
}

export interface ProtocolCompatibility {
  compatible: boolean;
  reason?: string;
}

export function parseServerCapabilities(value: unknown): ServerCapabilities {
  if (!isRecord(value))
    throw new Error("Capabilities response must be an object");
  if (typeof value.serverVersion !== "string")
    throw new Error("serverVersion must be a string");
  if (!isRecord(value.protocol)) throw new Error("protocol must be an object");
  const version = positiveInteger(value.protocol.version, "protocol.version");
  if (!isRecord(value.features)) throw new Error("features must be an object");
  const features: Record<string, number> = {};
  for (const [name, version] of Object.entries(value.features)) {
    features[name] = positiveInteger(version, `features.${name}`);
  }
  const attachments = parseAttachmentTransferCapabilities(value.attachments);
  const agentEnvironments = parseAgentEnvironmentCapabilities(
    value.agentEnvironments,
  );
  return {
    serverVersion: value.serverVersion,
    protocol: { version },
    features,
    ...(attachments ? { attachments } : {}),
    ...(agentEnvironments ? { agentEnvironments } : {}),
  };
}

function parseAgentEnvironmentCapabilities(
  value: unknown,
): AgentEnvironmentCapabilities | undefined {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    value.native !== true ||
    typeof value.wsl !== "boolean"
  ) {
    throw new Error(
      "agentEnvironments must contain native=true and a boolean wsl value",
    );
  }
  return { native: true, wsl: value.wsl };
}

export function checkProtocolCompatibility(
  server: ServerCapabilities,
  client: ClientProtocolSupport,
): ProtocolCompatibility {
  if (client.version !== server.protocol.version) {
    return {
      compatible: false,
      reason: `Client protocol ${client.version} does not match server protocol ${server.protocol.version}`,
    };
  }
  return { compatible: true };
}

export function supportsFeature(
  capabilities: ServerCapabilities,
  feature: string,
  minimumVersion = 1,
): boolean {
  return (capabilities.features[feature] ?? 0) >= minimumVersion;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || Number(value) < 1)
    throw new Error(`${field} must be a positive integer`);
  return Number(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAttachmentTransferCapabilities(
  value: unknown,
): AttachmentTransferCapabilities | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("attachments must be an object");
  if (!Array.isArray(value.uploadModes) || value.uploadModes.length === 0) {
    throw new Error("attachments.uploadModes must be a non-empty array");
  }
  if (
    value.uploadModes[0] !== "single" ||
    value.uploadModes.length > 2 ||
    (value.uploadModes.length === 2 && value.uploadModes[1] !== "resumable")
  ) {
    throw new Error(
      'attachments.uploadModes must be ["single"] or ["single", "resumable"]',
    );
  }
  const uploadModes = value.uploadModes as ["single"] | ["single", "resumable"];
  return {
    limits: parseAttachmentLimits(value.limits),
    uploadModes,
  };
}
