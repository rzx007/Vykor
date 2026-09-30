export function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

type GeneratedImageAssetMetadata = {
  assetId: string;
  displayName: string;
  mediaType: string;
  sizeBytes: number;
};

export function generatedImageAssets(value: unknown): GeneratedImageAssetMetadata[] {
  if (!Array.isArray(value)) return [];
  const images: GeneratedImageAssetMetadata[] = [];
  for (const item of value) {
    const record = recordValue(item);
    const assetId = stringValue(record?.assetId);
    const displayName = stringValue(record?.displayName);
    const mediaType = stringValue(record?.mediaType);
    const sizeBytes = record?.sizeBytes;
    if (
      !assetId ||
      !displayName ||
      !mediaType?.startsWith("image/") ||
      typeof sizeBytes !== "number" ||
      !Number.isSafeInteger(sizeBytes) ||
      sizeBytes < 0
    ) {
      continue;
    }
    images.push({ assetId, displayName, mediaType, sizeBytes });
  }
  return images;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
