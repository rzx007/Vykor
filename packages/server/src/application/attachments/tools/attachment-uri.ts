export interface ParsedAttachmentUri {
  assetId: string;
  displayName: string;
}

const ASSET_ID_PATTERN = /^[A-Za-z0-9._-]+$/u;

export function isAttachmentUri(value: string): boolean {
  return value.toLowerCase().startsWith("attachment:");
}

export function parseAttachmentUri(value: string): ParsedAttachmentUri {
  if (!value.startsWith("attachment://") || value.includes("?") || value.includes("#")) {
    throw new Error("Invalid attachment URI");
  }
  const remainder = value.slice("attachment://".length);
  const slash = remainder.indexOf("/");
  if (slash <= 0 || slash === remainder.length - 1) throw new Error("Invalid attachment URI");
  const rawAssetId = remainder.slice(0, slash);
  const rawDisplayName = remainder.slice(slash + 1);
  if (rawAssetId.includes("@") || rawAssetId.includes(":")) throw new Error("Invalid attachment URI");
  let assetId: string;
  let displayName: string;
  try {
    assetId = decodeURIComponent(rawAssetId);
    displayName = decodeURIComponent(rawDisplayName);
  } catch {
    throw new Error("Invalid attachment URI");
  }
  if (!ASSET_ID_PATTERN.test(assetId) || !displayName || displayName.includes("/") ||
      displayName.includes("\\") || displayName === "." || displayName === "..") {
    throw new Error("Invalid attachment URI");
  }
  return { assetId, displayName };
}
