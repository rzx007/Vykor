/** Structured domain validation failure; adapters retain their own public error types. */
export class DomainValidationError extends Error {
  readonly code = "invalid_request";
  constructor(message: string, readonly field?: string, readonly reason?: string) {
    super(message);
    this.name = "DomainValidationError";
  }
}
