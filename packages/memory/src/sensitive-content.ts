export type CredentialRisk = "private_key" | "bearer_token" | "key_assignment" | "api_key_prefix";

/** Detect only recognizable credential values; never return the matched text. */
export function detectCredentialValue(text: string): CredentialRisk | null {
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) return "private_key";
  if (/\bBearer\s+\S{10,}/i.test(text)) return "bearer_token";
  if (/\b(?:api[_-]?key|token|password|secret)\s*[:=]\s*\S{8,}/i.test(text)) return "key_assignment";
  if (/\bsk-[A-Za-z0-9_-]{16,}\b/.test(text)) return "api_key_prefix";
  return null;
}
