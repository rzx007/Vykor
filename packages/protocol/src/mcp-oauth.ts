/**
 * Wire DTOs and validators for the MCP OAuth App Server interface.
 *
 * These are the only shapes that cross the daemon control plane. Tokens,
 * client secrets, PKCE verifiers and callback query parameters never appear in
 * a response or event.
 */

export const MCP_OAUTH_FEATURE = "mcpOAuth";
export const MCP_OAUTH_LOGIN_UPDATED_EVENT = "mcp.oauth.login.updated";
export const MCP_OAUTH_LOGIN_COMPLETED_EVENT = "mcp.oauth.login.completed";

export const MAX_OAUTH_ID_LENGTH = 200;
export const MAX_OAUTH_SCOPES = 50;
export const MAX_OAUTH_SCOPE_LENGTH = 200;
export const MAX_OAUTH_CALLBACK_URL_LENGTH = 4_096;

export type OAuthCallbackMode = "local" | "manual";
export type OAuthOperationState = "pending" | "completed" | "failed" | "cancelled";
export const MCP_OAUTH_AUTH_STATUSES = [
  "not-configured",
  "not-logged-in",
  "valid",
  "expired-refreshable",
  "reauthentication-required",
  "static",
  "unsupported",
] as const;
export type McpOAuthAuthStatus = (typeof MCP_OAUTH_AUTH_STATUSES)[number];

export interface McpOAuthServerSnapshot {
  name: string;
  enabled: boolean;
  transport: "stdio" | "http" | "sse";
  endpoint?: string;
  authMode: "none" | "oauth" | "bearer" | "custom";
  authStatus: McpOAuthAuthStatus;
  scopes: string[];
  runtimeStatus: "connected" | "disconnected" | "error" | "unavailable";
}

export interface McpOAuthStatusSnapshot {
  servers: McpOAuthServerSnapshot[];
}

export interface McpOAuthLoginInput {
  oauthInstanceId: string;
  requestId: string;
  scopes?: string[];
  callbackMode: OAuthCallbackMode;
}

export interface OAuthOperationView {
  loginId: string;
  name: string;
  state: OAuthOperationState;
  credentialCommitted: boolean;
  authorizationReady: boolean;
  errorCode?: string;
  /** Only present on an authenticated GET operation response. */
  authorizationUrl?: string;
  runtimeSync?: OAuthOperationEventData["runtimeSync"];
}

export interface McpOAuthLoginResponse {
  loginId: string;
  operation: OAuthOperationView;
}

export interface McpOAuthCallbackInput {
  callbackUrl: string;
}

export interface OAuthOperationEventData {
  loginId: string;
  name: string;
  state: OAuthOperationState;
  credentialCommitted: boolean;
  authorizationReady: boolean;
  errorCode?: string;
  runtimeSync?: {
    status: McpOAuthServerSnapshot["runtimeStatus"];
    affectedRuntimes: number;
    failures: Array<{ runtimeId: string; message: string }>;
  };
}

export interface OAuthOperationEvent {
  event: typeof MCP_OAUTH_LOGIN_UPDATED_EVENT | typeof MCP_OAUTH_LOGIN_COMPLETED_EVENT;
  data: OAuthOperationEventData;
}

export function parseMcpOAuthLoginInput(value: unknown): McpOAuthLoginInput {
  const record = requiredRecord(value, "login input");
  const oauthInstanceId = boundedId(record.oauthInstanceId, "oauthInstanceId");
  const requestId = boundedId(record.requestId, "requestId");
  const callbackMode = record.callbackMode;
  if (callbackMode !== "local" && callbackMode !== "manual") {
    throw new Error("callbackMode must be local or manual");
  }
  const scopes = parseScopes(record.scopes);
  return {
    oauthInstanceId,
    requestId,
    callbackMode,
    ...(scopes ? { scopes } : {}),
  };
}

export function parseMcpOAuthCallbackInput(value: unknown): McpOAuthCallbackInput {
  const record = requiredRecord(value, "callback input");
  const callbackUrl = record.callbackUrl;
  if (typeof callbackUrl !== "string" || callbackUrl.length === 0 || callbackUrl.length > MAX_OAUTH_CALLBACK_URL_LENGTH) {
    throw new Error("callbackUrl must be a non-empty string");
  }
  return { callbackUrl };
}

export function parseOAuthOperationView(value: unknown): OAuthOperationView {
  const record = requiredRecord(value, "operation view");
  const view: OAuthOperationView = {
    loginId: boundedId(record.loginId, "loginId"),
    name: boundedId(record.name, "name"),
    state: operationState(record.state),
    credentialCommitted: requiredBoolean(record.credentialCommitted, "credentialCommitted"),
    authorizationReady: requiredBoolean(record.authorizationReady, "authorizationReady"),
  };
  if (record.errorCode !== undefined) {
    view.errorCode = boundedId(record.errorCode, "errorCode");
  }
  if (record.authorizationUrl !== undefined) {
    if (typeof record.authorizationUrl !== "string" || record.authorizationUrl.length > MAX_OAUTH_CALLBACK_URL_LENGTH) {
      throw new Error("authorizationUrl must be a string");
    }
    view.authorizationUrl = record.authorizationUrl;
  }
  if (record.runtimeSync !== undefined) view.runtimeSync = parseRuntimeSync(record.runtimeSync);
  return view;
}

export function parseOAuthOperationEvent(value: unknown): OAuthOperationEvent {
  const record = requiredRecord(value, "operation event");
  if (record.event !== MCP_OAUTH_LOGIN_UPDATED_EVENT && record.event !== MCP_OAUTH_LOGIN_COMPLETED_EVENT) {
    throw new Error("unknown MCP OAuth event name");
  }
  const data = requiredRecord(record.data, "operation event data");
  const event: OAuthOperationEvent = {
    event: record.event,
    data: {
      loginId: boundedId(data.loginId, "loginId"),
      name: boundedId(data.name, "name"),
      state: operationState(data.state),
      credentialCommitted: requiredBoolean(data.credentialCommitted, "credentialCommitted"),
      authorizationReady: requiredBoolean(data.authorizationReady, "authorizationReady"),
      ...(data.errorCode !== undefined ? { errorCode: boundedId(data.errorCode, "errorCode") } : {}),
    },
  };
  if (data.runtimeSync !== undefined) {
    event.data.runtimeSync = parseRuntimeSync(data.runtimeSync);
  }
  return event;
}

function parseRuntimeSync(value: unknown): NonNullable<OAuthOperationEventData["runtimeSync"]> {
  const runtimeSync = requiredRecord(value, "runtimeSync");
  return {
    status: runtimeSyncStatus(runtimeSync.status),
    affectedRuntimes: nonNegativeInteger(runtimeSync.affectedRuntimes, "affectedRuntimes"),
    failures: Array.isArray(runtimeSync.failures)
      ? runtimeSync.failures.map((failure) => {
          const item = requiredRecord(failure, "runtimeSync failure");
          return { runtimeId: boundedId(item.runtimeId, "runtimeId"), message: boundedId(item.message, "message") };
        })
      : [],
  };
}

export function parseMcpOAuthStatusSnapshot(value: unknown): McpOAuthStatusSnapshot {
  const record = requiredRecord(value, "status snapshot");
  if (!Array.isArray(record.servers)) throw new Error("servers must be an array");
  return { servers: record.servers.map(parseServerSnapshot) };
}

function parseServerSnapshot(value: unknown): McpOAuthServerSnapshot {
  const record = requiredRecord(value, "server snapshot");
  const transport = record.transport;
  if (transport !== "stdio" && transport !== "http" && transport !== "sse") throw new Error("invalid transport");
  const authMode = record.authMode;
  if (authMode !== "none" && authMode !== "oauth" && authMode !== "bearer" && authMode !== "custom") {
    throw new Error("invalid authMode");
  }
  if (!MCP_OAUTH_AUTH_STATUSES.includes(record.authStatus as McpOAuthAuthStatus)) {
    throw new Error("invalid authStatus");
  }
  return {
    name: boundedId(record.name, "name"),
    enabled: requiredBoolean(record.enabled, "enabled"),
    transport,
    ...(typeof record.endpoint === "string" ? { endpoint: record.endpoint } : {}),
    authMode,
    authStatus: record.authStatus as McpOAuthAuthStatus,
    scopes: parseScopes(record.scopes) ?? [],
    runtimeStatus: runtimeSyncStatus(record.runtimeStatus),
  };
}

function parseScopes(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_OAUTH_SCOPES) throw new Error("scopes must be a bounded array");
  return value.map((scope) => {
    if (typeof scope !== "string" || scope.length === 0 || scope.length > MAX_OAUTH_SCOPE_LENGTH) {
      throw new Error("each scope must be a non-empty string");
    }
    return scope;
  });
}

function operationState(value: unknown): OAuthOperationState {
  if (value !== "pending" && value !== "completed" && value !== "failed" && value !== "cancelled") {
    throw new Error("invalid operation state");
  }
  return value;
}

function runtimeSyncStatus(value: unknown): McpOAuthServerSnapshot["runtimeStatus"] {
  if (value !== "connected" && value !== "disconnected" && value !== "error" && value !== "unavailable") {
    throw new Error("invalid runtime status");
  }
  return value;
}

function boundedId(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_OAUTH_ID_LENGTH) {
    throw new Error(`${field} must be a bounded non-empty string`);
  }
  return value;
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
  return value;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${field} must be a non-negative integer`);
  return Number(value);
}

function requiredRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}
