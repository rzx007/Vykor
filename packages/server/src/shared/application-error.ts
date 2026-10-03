export type ApplicationErrorCode =
  | "invalid_request"
  | "not_found"
  | "conflict"
  | "not_supported"
  | "plugin_ui_not_found"
  | "plugin_ui_request_conflict"
  | "plugin_ui_revision_conflict"
  | "plugin_ui_session_busy"
  | "plugin_ui_closed"
  | "plugin_ui_session_archived"
  | "plugin_ui_action_unknown"
  | "plugin_ui_permission_missing"
  | "plugin_ui_unavailable"
  | "plugin_ui_snapshot_changed"
  | "plugin_ui_invalid_definition"
  | "plugin_ui_action_not_allowed"
  | "plugin_ui_action_not_resumable"
  | "application_error";

export const APPLICATION_ERROR_HTTP_STATUS: Record<ApplicationErrorCode, number> = {
  invalid_request: 400,
  not_found: 404,
  plugin_ui_not_found: 404,
  plugin_ui_request_conflict: 409,
  plugin_ui_revision_conflict: 409,
  plugin_ui_session_busy: 409,
  plugin_ui_closed: 409,
  plugin_ui_session_archived: 409,
  plugin_ui_action_unknown: 409,
  plugin_ui_permission_missing: 403,
  plugin_ui_unavailable: 503,
  plugin_ui_snapshot_changed: 409,
  plugin_ui_invalid_definition: 409,
  plugin_ui_action_not_allowed: 403,
  plugin_ui_action_not_resumable: 409,
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
