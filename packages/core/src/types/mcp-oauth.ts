export interface McpOAuthSettings {
  scopes?: string[];
  clientId?: string;
  callbackPort?: number;
}

export type McpOAuthAuthStatus =
  | "not-configured"
  | "not-logged-in"
  | "valid"
  | "expired-refreshable"
  | "reauthentication-required"
  | "static"
  | "unsupported";

export interface McpOAuthCredentialRecord {
  serverUrl: string;
  revision: number;
  binding: {
    issuer: string;
    redirectUri: string;
    authorizationEndpoint: string;
    tokenEndpoint: string;
    registrationEndpoint?: string;
    revocationEndpoint?: string;
    authorizationResponseIssParameterSupported?: boolean;
  };
  registration: {
    client_id: string;
    client_secret?: string;
    token_endpoint_auth_method?: string;
    client_id_issued_at?: number;
    client_secret_expires_at?: number;
  };
  tokens: {
    accessToken: string;
    refreshToken?: string;
    tokenType: string;
    scope: string[];
    expiresAt?: number;
  };
  diagnostic?: {
    code: "reauthentication-required";
    updatedAt: number;
  };
}

export interface McpOAuthStoreFile {
  version: 1;
  servers: Record<string, McpOAuthCredentialRecord>;
}

/** How a configured HTTP MCP server authenticates requests. */
export type McpAuthMode = "none" | "oauth" | "bearer" | "custom";

/** Aggregate state of the active Runtime connections for one MCP server. */
export type McpRuntimeStatus =
  | "connected"
  | "disconnected"
  | "error"
  | "unavailable";

/**
 * Cross-process identity of a configured MCP server.
 *
 * `endpoint` is the normalized URL (host lowercased, default port dropped,
 * fragment removed, path and query preserved). `endpointFingerprint` is the
 * SHA-256 base64url digest of `endpoint`; only the fingerprint crosses the
 * daemon control-plane wire so the full endpoint never appears in logs.
 */
export interface McpServerIdentity {
  name: string;
  transport: "http";
  endpoint: string;
  endpointFingerprint: string;
}

export interface McpRuntimeSyncResult {
  status: McpRuntimeStatus;
  affectedRuntimes: number;
  failures: Array<{ runtimeId: string; message: string }>;
}

/** Secret-free public view of one configured MCP server. */
export interface McpAuthServerSnapshot {
  name: string;
  enabled: boolean;
  transport: "stdio" | "http" | "sse";
  endpoint?: string;
  authMode: McpAuthMode;
  authStatus: McpOAuthAuthStatus;
  scopes: string[];
  runtimeStatus: McpRuntimeStatus;
}

/** Reconnects or disconnects the active Runtimes matching one server identity. */
export interface McpRuntimeConnectionCoordinator {
  getStatus(identity: McpServerIdentity): Promise<McpRuntimeSyncResult>;
  synchronize(identity: McpServerIdentity): Promise<McpRuntimeSyncResult>;
}

/**
 * Narrow capability one active Session Runtime exposes to the coordinator.
 *
 * `synchronize` must check the generation before staging a connection and again
 * before publishing it. `getStatus` maps the Runtime's internal state onto
 * `McpRuntimeStatus` (initializing maps to `disconnected`).
 */
export interface ActiveMcpRuntimeHandle {
  runtimeId: string;
  identity(name: string): McpServerIdentity | undefined;
  synchronize(identity: McpServerIdentity, generation: number): Promise<void>;
  getStatus(identity: McpServerIdentity): McpRuntimeStatus;
}

/** Process-wide registry of active MCP Runtime handles. */
export interface McpRuntimeRegistry {
  register(handle: ActiveMcpRuntimeHandle): () => void;
  /** Monotonic per-identity generation shared with the coordinator. */
  currentGeneration(identity: McpServerIdentity): number;
}
