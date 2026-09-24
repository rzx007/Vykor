export const VYKOR_USER_AGENT = "vykor/1.0";
const SUPPORTED_VARIABLES = new Set(["sessionId", "userAgent"]);
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const TEMPLATE = /\{\{([^{}]+)\}\}/g;

export interface RequestHeaderTemplateContext {
  sessionId?: string;
  userAgent: string;
}

export class RequestHeaderTemplateError extends Error {
  constructor(
    message: string,
    readonly headerName?: string,
  ) {
    super(message);
    this.name = "RequestHeaderTemplateError";
  }
}

function assertStringHeaderValue(
  value: unknown,
  headerName: string,
): asserts value is string {
  if (typeof value !== "string") {
    throw new RequestHeaderTemplateError(
      `Header value must be a string for "${headerName}"`,
      headerName,
    );
  }
}

function validateTemplateVariables(value: string, headerName: string): void {
  for (const match of value.matchAll(TEMPLATE)) {
    const variable = match[1]?.trim();
    if (!variable || !SUPPORTED_VARIABLES.has(variable)) {
      throw new RequestHeaderTemplateError(
        `Unknown template variable in header "${headerName}": ${variable ?? ""}`,
        headerName,
      );
    }
  }
}

function validateHeaderValue(value: string, headerName: string): void {
  if (/[\r\n]/.test(value)) {
    throw new RequestHeaderTemplateError(
      `Header value must not contain CR or LF for "${headerName}"`,
      headerName,
    );
  }
  validateTemplateVariables(value, headerName);
}

export function normalizeRequestHeaderTemplates(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (headers === undefined) {
    return undefined;
  }

  const normalized: Record<string, string> = {};
  const seenLowercase = new Map<string, string>();

  for (const [rawName, rawValue] of Object.entries(headers)) {
    assertStringHeaderValue(rawValue, rawName);

    const name = rawName.trim();
    const value = rawValue.trim();

    if (name.length === 0 || value.length === 0) {
      continue;
    }

    if (!HEADER_NAME.test(name)) {
      throw new RequestHeaderTemplateError(
        `Invalid HTTP header name: "${name}"`,
        name,
      );
    }

    validateHeaderValue(value, name);

    const lowercaseName = name.toLowerCase();
    const existing = seenLowercase.get(lowercaseName);
    if (existing !== undefined) {
      throw new RequestHeaderTemplateError(
        `duplicate header name (case-insensitive): "${existing}" and "${name}"`,
        name,
      );
    }
    seenLowercase.set(lowercaseName, name);
    normalized[name] = value;
  }

  return normalized;
}

function expandTemplateValue(
  value: string,
  context: RequestHeaderTemplateContext,
): string {
  return value.replace(TEMPLATE, (_match, rawVariable: string) => {
    const variable = rawVariable.trim();
    if (variable === "sessionId") {
      const sessionId = context.sessionId?.trim();
      if (!sessionId) {
        throw new RequestHeaderTemplateError(
          "sessionId is required when header templates reference {{sessionId}}",
        );
      }
      return sessionId;
    }
    if (variable === "userAgent") {
      return context.userAgent;
    }
    throw new RequestHeaderTemplateError(
      `Unknown template variable: ${variable}`,
    );
  });
}

export function expandRequestHeaderTemplates(
  headers: Record<string, string> | undefined,
  context: RequestHeaderTemplateContext,
): Record<string, string> | undefined {
  const normalized = normalizeRequestHeaderTemplates(headers);
  if (normalized === undefined) {
    return undefined;
  }

  const expanded: Record<string, string> = {};
  for (const [name, value] of Object.entries(normalized)) {
    expanded[name] = expandTemplateValue(value, context);
  }
  return expanded;
}
