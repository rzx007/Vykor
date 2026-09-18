export class McpOAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "McpOAuthError";
  }
}

export function oauthError(code: string, message: string, retryable = false): McpOAuthError {
  return new McpOAuthError(code, message, retryable);
}
