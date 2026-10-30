export * from "./session/session.js";
export * from "./runtime/maintenance.js";
export * from "./runtime/runtime-config.js";
export type { ApprovalMode, WorkMode } from "./permissions/approval-mode.js";
export type { ApprovalReviewEvidence, ApprovalReviewInput, ApprovalReviewOutcome, ApprovalReviewRecord, ApprovalReviewResult } from "./permissions/approval-review.js";
export * from "./requests/requests.js";
export type { JobCapabilities, JobTarget, JobInputReceipt, JobListResult, JobKind, JobReadResult, JobSnapshot, JobStatus, JobWaitResult } from "./runtime/job.js";
export type { TerminalCreateRequest, TerminalEvent, TerminalReadRequest, TerminalReadResult, TerminalResizeRequest, TerminalRuntime, TerminalSessionInfo, TerminalSessionStatus, TerminalSignal, TerminalSignalRequest, TerminalScope, TerminalSource, TerminalWaitResult, TerminalWriteRequest } from "./runtime/terminal.js";
export * from "./serialization/serialization.js";
export * from "./channels/channel.js";
export * from "./channels/channel-runtime.js";
export * from "./runtime/capabilities.js";
export * from "./attachments/attachment.js";
export * from "./session/session-input-items.js";
export * from "./session/session-goals.js";
export * from "./extensions/mcp-oauth.js";
export * from "./runtime/execution-observability.js";
export * from "./permissions/auto-review.js";
export * from "./workspace-changes.js";
export * from "./files/session-files.js";
export * from "./extensions/plugin-presentation.js";
export type { MarketplaceCatalog, MarketplaceSource, MarketplaceSourceView, MarketplaceEntry, MarketplaceSelection, MarketplacePreview, MarketplaceInstallInput, MarketplaceOperation, MarketplaceProvenance } from "@vykor/plugin-contracts/marketplace";
export * from "./knowledge/notes.js";
export * from "./knowledge/memory.js";
export * from "./attachments/office.js";
export * from "./extensions/plugin-apps.js";
export * from "./extensions/plugin-marketplace.js";

export type { JsonValue } from "./serialization/json.js";
export { isJsonObject, isJsonRecord, isNonnegativeInteger, isUuid, stringifyCanonicalJson, validateJsonRecord } from "./serialization/json.js";
export * from "./extensions/plugin-ui-history.js";

// Canonical tool-result data shared with the HTTP client.
export { parseMcpCallResultData, type McpCallResultData } from "@vykor/agent-contracts/tool-data";

export { PLUGIN_APP_MANIFEST_LIMITS, PLUGIN_APP_RESOURCE_LIMITS, PLUGIN_APP_DATA_LIMITS } from "@vykor/plugin-contracts/limits";
export { PLUGIN_APP_INPUT_LIMITS } from "@vykor/domain-contracts/plugin-apps";
export { MCP_APP_HTML_MIME_TYPE } from "@vykor/agent-contracts/tool-data";
