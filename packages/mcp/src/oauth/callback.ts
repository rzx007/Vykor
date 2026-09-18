import { createServer, type Server } from "node:http";
import { McpOAuthError } from "./errors.js";
import { assertIssuer } from "./security.js";

export interface OAuthCallbackResult {
  code: string;
  issuer?: string;
}

export interface OAuthCallbackController {
  redirectUri: string;
  wait(signal?: AbortSignal): Promise<OAuthCallbackResult>;
  accept(url: URL): Promise<OAuthCallbackResult>;
  close(): Promise<void>;
}

export async function createOAuthCallback(options: {
  expectedState: string;
  expectedIssuer: string;
  requireIssuer?: boolean;
  port?: number;
  deadlineMs?: number;
}): Promise<OAuthCallbackController> {
  let consumed = false;
  let settled = false;
  let resolveResult!: (result: OAuthCallbackResult) => void;
  let rejectResult!: (error: unknown) => void;
  const resultPromise = new Promise<OAuthCallbackResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  let server!: Server;
  const close = async () => {
    if (!server.listening) return;
    await new Promise<void>(resolve => server.close(() => resolve()));
  };

  const consume = async (url: URL): Promise<OAuthCallbackResult> => {
    if (consumed) throw new McpOAuthError("oauth-callback-consumed", "OAuth callback was already consumed");
    consumed = true;
    try {
      if (url.origin !== new URL(redirectUri).origin || url.pathname !== new URL(redirectUri).pathname) {
        throw new McpOAuthError("oauth-callback-mismatch", "OAuth callback URL does not match redirect URI");
      }
      if (url.searchParams.get("state") !== options.expectedState) {
        throw new McpOAuthError("oauth-state-mismatch", "OAuth callback state does not match");
      }
      const oauthFailure = url.searchParams.get("error");
      if (oauthFailure) {
        throw new McpOAuthError("oauth-authorization-denied", `OAuth authorization failed: ${oauthFailure}`);
      }
      const issuer = url.searchParams.get("iss") ?? undefined;
      assertIssuer(issuer, options.expectedIssuer, options.requireIssuer ?? false);
      const code = url.searchParams.get("code");
      if (!code) throw new McpOAuthError("oauth-code-missing", "OAuth callback has no authorization code");
      const result = { code, issuer };
      settled = true;
      resolveResult(result);
      return result;
    } catch (error) {
      settled = true;
      rejectResult(error);
      throw error;
    } finally {
      void close();
    }
  };

  let redirectUri = "";
  server = createServer((request, response) => {
    void consume(new URL(request.url ?? "/", redirectUri)).then(
      () => {
        response.statusCode = 200;
        response.end("Authorization complete. You may close this window.");
      },
      () => {
        response.statusCode = 400;
        response.end("Authorization failed. Return to the terminal.");
      },
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as { port: number };
  redirectUri = `http://127.0.0.1:${address.port}/oauth/callback`;
  const timer = setTimeout(() => {
    if (settled) return;
    consumed = true;
    settled = true;
    rejectResult(new McpOAuthError("oauth-callback-timeout", "OAuth callback timed out"));
    void close();
  }, options.deadlineMs ?? 300_000);
  timer.unref?.();

  return {
    redirectUri,
    wait(signal) {
      if (!signal) return resultPromise.finally(() => clearTimeout(timer));
      if (signal.aborted) return Promise.reject(signal.reason);
      return Promise.race([
        resultPromise,
        new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
      ]).finally(() => clearTimeout(timer));
    },
    accept: consume,
    async close() {
      clearTimeout(timer);
      await close();
    },
  };
}
