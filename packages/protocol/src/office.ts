export { OFFICE_MEDIA_TYPES, officeFormat, type OfficeFormat } from "@vykor/domain-contracts/attachments";
import type { OfficeFormat } from "@vykor/domain-contracts/attachments";
export interface OfficePreview {
  html: string;
  format: OfficeFormat;
  page: number;
  pageCount?: number;
  sha256: string;
}
