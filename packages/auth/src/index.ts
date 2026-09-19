export { CredentialStorage } from "./credential-storage";
export type { CredentialData } from "./credential-storage";
export {
  CODEX_AUTH_SOURCE,
  CODEX_PROVIDER,
  describeCodexAuthState,
  getCodexAuthPath,
  isCredentialExpired,
  loadCodexCredential,
} from "./external";
export type { ExternalAuthCredential, ExternalAuthState } from "./external";
export {
  resolveApiKey,
  type ApiKeyResolutionOptions,
} from "./credential-resolution";

export interface AuthCredentials {
  provider: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

export interface AuthProvider {
  name: string;
  authenticate(): Promise<AuthCredentials>;
  refresh(credentials: AuthCredentials): Promise<AuthCredentials>;
}

export class ApiKeyFlow implements AuthProvider {
  name = "api-key";
  private key: string;

  constructor(key: string) {
    this.key = key;
  }

  async authenticate(): Promise<AuthCredentials> {
    return { provider: this.name, accessToken: this.key };
  }

  async refresh(_credentials: AuthCredentials): Promise<AuthCredentials> {
    return { provider: this.name, accessToken: this.key };
  }
}

export class DeviceCodeFlow implements AuthProvider {
  name = "device-code";
  private clientId: string;
  private deviceCodeUrl: string;
  private tokenUrl: string;

  constructor(clientId: string, deviceCodeUrl: string, tokenUrl: string) {
    this.clientId = clientId;
    this.deviceCodeUrl = deviceCodeUrl;
    this.tokenUrl = tokenUrl;
  }

  async authenticate(): Promise<AuthCredentials> {
    const codeResp = await fetch(this.deviceCodeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ client_id: this.clientId, scope: "read:user" }),
    });

    if (!codeResp.ok) {
      throw new Error(`Device code request failed: ${codeResp.status}`);
    }

    const codeData = (await codeResp.json()) as {
      device_code: string;
      user_code: string;
      verification_uri: string;
      interval?: number;
      expires_in?: number;
    };

    console.log(`Enter code: ${codeData.user_code} at ${codeData.verification_uri}`);

    const interval = (codeData.interval ?? 5) * 1000;
    const expiresAt = Date.now() + (codeData.expires_in ?? 900) * 1000;

    while (Date.now() < expiresAt) {
      await new Promise((r) => setTimeout(r, interval));
      const tokenResp = await fetch(this.tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          client_id: this.clientId,
          device_code: codeData.device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      });

      const tokenData = (await tokenResp.json()) as any;
      if (tokenData.access_token) {
        return {
          provider: this.name,
          accessToken: tokenData.access_token,
          refreshToken: tokenData.refresh_token,
          expiresAt: tokenData.expires_in ? Date.now() + tokenData.expires_in * 1000 : undefined,
        };
      }
      if (tokenData.error === "authorization_pending") continue;
      if (tokenData.error === "slow_down") {
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      throw new Error(`Token error: ${tokenData.error ?? "unknown"}`);
    }

    throw new Error("Device code flow timed out");
  }

  async refresh(credentials: AuthCredentials): Promise<AuthCredentials> {
    if (!credentials.refreshToken) return credentials;
    const resp = await fetch(this.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: this.clientId,
        refresh_token: credentials.refreshToken,
        grant_type: "refresh_token",
      }),
    });
    if (!resp.ok) return credentials;
    const data = (await resp.json()) as any;
    return {
      provider: credentials.provider,
      accessToken: data.access_token ?? credentials.accessToken,
      refreshToken: data.refresh_token ?? credentials.refreshToken,
      expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : credentials.expiresAt,
    };
  }
}

export class AuthManager {
  private providers = new Map<string, AuthProvider>();
  private credentials = new Map<string, AuthCredentials>();

  registerProvider(provider: AuthProvider): void {
    this.providers.set(provider.name, provider);
  }

  async authenticate(providerName: string): Promise<AuthCredentials> {
    const provider = this.providers.get(providerName);
    if (!provider) throw new Error(`Unknown auth provider: ${providerName}`);
    const creds = await provider.authenticate();
    this.credentials.set(providerName, creds);
    return creds;
  }

  getCredentials(providerName: string): AuthCredentials | undefined {
    return this.credentials.get(providerName);
  }
}

export {
  McpOAuthCredentialStore,
  McpOAuthStoreError,
  shouldReuseCredentialAfterLock,
  type ExclusiveCredentialOperation,
} from "./mcp-oauth-credential-store";
export { ChannelCredentialStore, ChannelCredentialStoreError } from "./channel-credential-store";
export {
  ChannelConfigStore,
  ChannelConfigStoreError,
} from "./channel-config-store";
export type { FeishuChannelConfig, ChannelConfigFile, FeishuDomain } from "./channel-config-store";
