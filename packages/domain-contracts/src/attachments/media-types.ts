export const OFFICE_MEDIA_TYPES = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
} as const;

export type OfficeFormat = keyof typeof OFFICE_MEDIA_TYPES;
export function officeFormat(name: string): OfficeFormat | undefined {
  const basename = name.split(/[\\/]/).at(-1) ?? "";
  const extension = basename.includes(".") ? basename.split(".").at(-1)?.toLowerCase() : undefined;
  return extension && Object.hasOwn(OFFICE_MEDIA_TYPES, extension)
    ? (extension as OfficeFormat)
    : undefined;
}
