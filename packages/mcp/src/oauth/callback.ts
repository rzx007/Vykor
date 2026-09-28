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

export interface OAuthCallbackOptions {
  expectedState: string;
  expectedIssuer: string;
  requireIssuer?: boolean;
  /** Legacy loopback port; mutually exclusive with `callbackUrl`. */
  port?: number;
  /**
   * Explicit callback URL. A loopback HTTP URL is listened on directly; an
   * HTTPS URL is accepted only as a manual, externally-delivered callback.
   */
  callbackUrl?: string;
  deadlineMs?: number;
}

interface ParsedCallbackUrl {
  url: URL;
  manual: boolean;
}

/** Validate a configured callback URL: no userinfo, fragment or fixed query. */
export function parseCallbackUrl(value: string): ParsedCallbackUrl {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new McpOAuthError("oauth-callback-invalid", "OAuth callback URL is invalid");
  }
  if (url.username || url.password) {
    throw new McpOAuthError("oauth-callback-invalid", "OAuth callback URL must not contain userinfo");
  }
  if (url.hash) {
    throw new McpOAuthError("oauth-callback-invalid", "OAuth callback URL must not contain a fragment");
  }
  if (url.search) {
    throw new McpOAuthError("oauth-callback-invalid", "OAuth callback URL must not contain a fixed query");
  }
  if (url.protocol === "https:") return { url, manual: true };
  if (url.protocol === "http:" && isLoopbackHostname(url.hostname)) {
    if (!url.port || Number(url.port) === 0) throw new McpOAuthError("oauth-callback-invalid", "A loopback HTTP callback URL requires an explicit non-zero port");
    return { url, manual: false };
  }
  throw new McpOAuthError("oauth-callback-invalid", "OAuth callback URL must be loopback HTTP or HTTPS");
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

function listenHost(hostname: string): string {
  return hostname === "[::1]" ? "::1" : hostname;
}

export async function createOAuthCallback(options: OAuthCallbackOptions): Promise<OAuthCallbackController> {
  const configured = options.callbackUrl ? parseCallbackUrl(options.callbackUrl) : undefined;
  if (options.callbackUrl !== undefined && options.port !== undefined) {
    throw new McpOAuthError("oauth-callback-config-conflict", "Configure either callbackUrl or callbackPort, not both");
  }

  let consumed = false;
  let settled = false;
  let resolveResult!: (result: OAuthCallbackResult) => void;
  let rejectResult!: (error: unknown) => void;
  const resultPromise = new Promise<OAuthCallbackResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  // A callback can arrive before the caller attaches `wait()`; keep a settled
  // rejection from surfacing as an unhandled rejection in that window.
  resultPromise.catch(() => undefined);

  let server: Server | undefined;
  const closeServer = async () => {
    if (!server?.listening) return;
    await new Promise<void>(resolve => server!.close(() => resolve()));
  };
  let timer: NodeJS.Timeout | undefined;
  const clearWatch = () => {
    if (timer) clearTimeout(timer);
  };
  const close = async () => {
    clearWatch();
    await closeServer();
  };

  /**
   * Validate and, only when every check passes, consume the callback once.
   * Invalid input never settles the waiter, so unrelated or malformed requests
   * cannot cancel a legitimate pending authorization. A valid `error` response
   * (e.g. access_denied) is consumed and ends the wait as a failure.
   */
  const consume = async (url: URL): Promise<OAuthCallbackResult> => {
    if (url.username || url.password || url.hash) {
      throw new McpOAuthError("oauth-callback-invalid", "OAuth callback URL must not contain userinfo or a fragment");
    }
    const redirect = new URL(redirectUri);
    if (url.origin !== redirect.origin || url.pathname !== redirect.pathname) {
      throw new McpOAuthError("oauth-callback-mismatch", "OAuth callback URL does not match redirect URI");
    }
    if (url.searchParams.get("state") !== options.expectedState) {
      throw new McpOAuthError("oauth-state-mismatch", "OAuth callback state does not match");
    }
    const issuer = url.searchParams.get("iss") ?? undefined;
    assertIssuer(issuer, options.expectedIssuer, options.requireIssuer ?? false);
    if (consumed) throw new McpOAuthError("oauth-callback-consumed", "OAuth callback was already consumed");

    const oauthFailure = url.searchParams.get("error");
    if (oauthFailure) {
      consumed = true;
      settled = true;
      const error = new McpOAuthError("oauth-authorization-denied", "OAuth authorization was denied");
      rejectResult(error);
      clearWatch();
      throw error;
    }
    const code = url.searchParams.get("code");
    if (!code) throw new McpOAuthError("oauth-code-missing", "OAuth callback has no authorization code");
    consumed = true;
    settled = true;
    const result = { code, issuer };
    resolveResult(result);
    clearWatch();
    return result;
  };

  let redirectUri: string;
  let redirectPath: string;

  if (configured && configured.manual) {
    // HTTPS callbacks are delivered by the user; this process never fetches the
    // public URL and never opens a listener.
    redirectUri = configured.url.href;
    redirectPath = configured.url.pathname;
  } else {
    const host = configured ? listenHost(configured.url.hostname) : "127.0.0.1";
    const port = configured ? Number(configured.url.port) : options.port ?? 0;
    redirectPath = configured ? configured.url.pathname : "/oauth/callback";
    redirectUri = configured
      ? `http://${configured.url.hostname === "[::1]" ? "[::1]" : host}:${port}${redirectPath}`
      : "";
    server = createServer((request, response) => {
      let incoming: URL;
      try { incoming = new URL(request.url ?? "/", redirectUri || `http://${host}/`); }
      catch {
        response.statusCode = 400;
        response.end("Invalid callback URL");
        return;
      }
      if (incoming.pathname !== redirectPath) {
        response.statusCode = 404;
        response.end("Not found");
        return;
      }
      void consume(incoming).then(
        () => {
          response.statusCode = 200;
          response.end("Authorization complete. You may close this window.");
        },
        (error: unknown) => {
          response.statusCode = error instanceof McpOAuthError && error.code === "oauth-callback-consumed" ? 409 : 400;
          response.end("Authorization failed. Return to the terminal.");
        },
      );
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(port, host, () => resolve());
    });
    if (!configured) {
      const address = server.address() as { port: number };
      redirectUri = `http://127.0.0.1:${address.port}/oauth/callback`;
    }
  }

  const watchTimer = setTimeout(() => {
    if (settled) return;
    consumed = true;
    settled = true;
    rejectResult(new McpOAuthError("oauth-callback-timeout", "OAuth callback timed out"));
    void close();
  }, options.deadlineMs ?? 300_000);
  watchTimer.unref?.();
  timer = watchTimer;

  return {
    redirectUri,
    wait(signal) {
      const base = !signal
        ? resultPromise
        : signal.aborted
          ? Promise.reject(signal.reason)
          : Promise.race([
              resultPromise,
              new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
            ]);
      const promise = base.finally(() => clearTimeout(timer));
      // A callback may settle before the caller attaches its await; keep the
      // derived promise from surfacing as an unhandled rejection.
      promise.catch(() => undefined);
      return promise;
    },
    accept: consume,
    async close() {
      if (timer) clearTimeout(timer);
      await closeServer();
    },
  };
}
