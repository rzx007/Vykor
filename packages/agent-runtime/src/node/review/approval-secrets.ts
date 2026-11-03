import type { ApprovalReviewInput } from "@vykor/agent-contracts/permissions";

const REMOVED = "[已移除凭据]";
const CREDENTIAL_FIELD =
  /password|passwd|secret|api[ _-]?key|access[_-]?key|authorization|cookie|credential|(?:access|refresh|auth|bearer)[_-]?token|(?:^|[_-])token$|密码|口令|密钥|令牌/i;
// Match the entire assigned name, including vendor-prefixed environment names.
// A bare reference such as $env:GROQ_API_KEY has no assignment and stays intact.
const LABEL =
  "(?:(?:[A-Za-z][A-Za-z0-9]*[_-])*(?:api[ _-]?key|access[_-]?key(?:[_-]?id)?|access[_-]?token|refresh[_-]?token|auth[_-]?token|password|passwd|secret|token|cookie|authorization|credentials?)(?:[_-][A-Za-z0-9]+)*|密码|口令|密钥|令牌)";
const ASSIGNMENT = new RegExp(
  `((?<![A-Za-z0-9_])(${LABEL})["']?[ \\t]*[:=：＝][ \\t]*)(?:"([^"\\r\\n]*)"|'([^'\\r\\n]*)'|([^\\s"'\u0060,;，；。]+))`,
  "gi",
);
const UNCLOSED_ASSIGNMENT = new RegExp(
  `(?<![A-Za-z0-9_])${LABEL}["']?[ \\t]*[:=：＝][ \\t]*["'](?!\\[已移除凭据\\]["'])`,
  "i",
);
const CLI_CREDENTIAL = new RegExp(
  `(--${LABEL}(?:=|[ \\t]+))(?:"([^"\\r\\n]*)"|'([^'\\r\\n]*)'|([^\\s"'\u0060,;，；。]+))`,
  "gi",
);
const UNCLOSED_CLI = new RegExp(
  `--${LABEL}(?:=|[ \\t]+)["'](?!\\[已移除凭据\\]["'])`,
  "i",
);
const PRIVATE_KEY_START = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/i;
const PRIVATE_KEY_BLOCK =
  /-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY)-----[\s\S]*?-----END \1-----/gi;
const PREFIXED_KEY =
  /(?<![A-Za-z0-9_])(?:gsk_[A-Za-z0-9_-]{12,}|sk-(?:proj-)?[A-Za-z0-9_-]{12,}|github_pat_[A-Za-z0-9_]{12,}|gh[pousr]_[A-Za-z0-9]{12,})/g;
const AUTH_SCHEME = /\b(?:Bearer|Basic)[ \t]+[A-Za-z0-9._~+/-]{8,}={0,2}/gi;
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{8,}\b/g;
const USERINFO_URL = /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi;

/** Credentials in history are replaced in place; the rest of the instruction stays intact. */
function redactApprovalText(value: string): string | undefined {
  let ambiguousCookie = false;
  let ambiguousCredential = false;
  let text = value.replace(PRIVATE_KEY_BLOCK, REMOVED);
  if (PRIVATE_KEY_START.test(text)) return undefined;
  text = text
    .replace(PREFIXED_KEY, REMOVED)
    .replace(AUTH_SCHEME, REMOVED)
    .replace(JWT, REMOVED)
    .replace(USERINFO_URL, (_match, scheme: string) => `${scheme}${REMOVED}@`);
  // A Cookie header may carry several separate values. Redact each value and
  // preserve separators and any surrounding prose, including restrictions.
  text = text.replace(
    /(\b(?:cookie|set-cookie)[ \t]*:[ \t]*)([^\r\n]*)/gi,
    (_match, prefix: string, body: string) => {
      if (
        (body.match(/"/g)?.length ?? 0) % 2 ||
        (body.match(/'/g)?.length ?? 0) % 2 ||
        body.includes("`")
      ) {
        ambiguousCookie = true;
        return _match;
      }
      return (
        prefix +
        body.replace(
          /(^|;[ \t]*)([A-Za-z0-9_.-]+[ \t]*=[ \t]*)(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s;"'，；。]*))/g,
          (
            match,
            separator: string,
            field: string,
            quoted: string | undefined,
            single: string | undefined,
            plain: string | undefined,
          ) =>
            (quoted ?? single ?? plain) === REMOVED
              ? match
              : `${separator}${field}${removedValue(quoted, single)}`,
        )
      );
    },
  );
  if (ambiguousCookie) return undefined;
  text = text
    .replace(
      ASSIGNMENT,
      (
        match,
        prefix: string,
        label: string,
        quoted: string | undefined,
        single: string | undefined,
        plain: string | undefined,
        offset: number,
        source: string,
      ) => {
        const secret = quoted ?? single ?? plain;
        if (
          secret === REMOVED ||
          (/cookie/i.test(label) &&
            /^[A-Za-z0-9_.-]+\s*=\s*\[已移除凭据\]$/.test(secret ?? ""))
        )
          return match;
        if (quoted?.includes("\\") || single?.includes("\\"))
          ambiguousCredential = true;
        if (
          plain !== undefined &&
          /password|passwd|secret|credential|authorization|密码|口令|密钥/i.test(
            label,
          ) &&
          /^[ \t]+[^\s,;，；。"'})\]]/.test(source.slice(offset + match.length))
        )
          ambiguousCredential = true;
        return `${prefix}${removedValue(quoted, single)}`;
      },
    )
    .replace(
      CLI_CREDENTIAL,
      (
        match,
        prefix: string,
        quoted: string | undefined,
        single: string | undefined,
        plain: string | undefined,
      ) => {
        if ((quoted ?? single ?? plain) === REMOVED) return match;
        if (quoted?.includes("\\") || single?.includes("\\"))
          ambiguousCredential = true;
        return `${prefix}${removedValue(quoted, single)}`;
      },
    );
  // An unmatched quote cannot establish the end of a credential reliably.
  return ambiguousCredential ||
    UNCLOSED_ASSIGNMENT.test(text) ||
    UNCLOSED_CLI.test(text)
    ? undefined
    : text;
}

function removedValue(
  quoted: string | undefined,
  single: string | undefined,
): string {
  return quoted !== undefined
    ? `"${REMOVED}"`
    : single !== undefined
      ? `'${REMOVED}'`
      : REMOVED;
}

/** Detect marked or recognizable credentials without treating ordinary hashes as keys. */
export function hasApprovalSecrets(
  value: unknown,
  visited = new WeakSet<object>(),
): boolean {
  if (typeof value === "string") return redactApprovalText(value) !== value;
  if (!value || typeof value !== "object" || visited.has(value)) return false;
  visited.add(value);
  return Object.entries(value).some(
    ([key, item]) =>
      CREDENTIAL_FIELD.test(key) || hasApprovalSecrets(item, visited),
  );
}

/** Build the one immutable-by-serialization review snapshot, without mutating the caller. */
export function prepareApprovalReviewInput(
  input: ApprovalReviewInput,
): ApprovalReviewInput | undefined {
  try {
    const prepared = structuredClone(input);
    if (
      hasApprovalSecrets(prepared.evidence.userInstruction) ||
      hasApprovalSecrets(prepared.tool) ||
      hasApprovalSecrets(prepared.input)
    )
      return undefined;
    if (prepared.evidence.userInstructionHistory) {
      const history = [];
      for (const previous of prepared.evidence.userInstructionHistory) {
        const content = redactApprovalText(previous.content);
        if (content === undefined) return undefined;
        history.push({ ...previous, content });
      }
      prepared.evidence.userInstructionHistory = history;
    }
    if (prepared.evidence.context) {
      const context = [];
      for (const reference of prepared.evidence.context) {
        const content = redactApprovalText(reference.content);
        if (content === undefined) return undefined;
        context.push({ ...reference, content });
      }
      prepared.evidence.context = context;
    }
    return hasApprovalSecrets(prepared) ? undefined : prepared;
  } catch {
    return undefined;
  }
}
