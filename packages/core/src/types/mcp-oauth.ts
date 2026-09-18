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
