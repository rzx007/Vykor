export type ApplicationErrorCode =
  | "invalid_request"
  | "not_found"
  | "conflict"
  | "not_supported"
  | "plugin_ui_not_found"
  | "application_error";

export const APPLICATION_ERROR_HTTP_STATUS: Record<ApplicationErrorCode, number> = {
  invalid_request: 400,
  not_found: 404,
  plugin_ui_not_found: 404,
  conflict: 409,
  not_supported: 501,
  application_error: 500,
};

/** Application 抛出的稳定错误。接入层只按 code 转换，不判断错误文字。 */
export class ApplicationError extends Error {
  readonly code: ApplicationErrorCode;
  readonly status: number;

  constructor(status: number, message: string, code = codeFromStatus(status)) {
    super(message);
    this.name = "ApplicationError";
    this.code = code;
    this.status = APPLICATION_ERROR_HTTP_STATUS[code];
  }
}

function codeFromStatus(status: number): ApplicationErrorCode {
  if (status === 400) return "invalid_request";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 501) return "not_supported";
  return "application_error";
}
