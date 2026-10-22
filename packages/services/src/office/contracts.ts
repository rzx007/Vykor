import type { OfficeFormat } from "@vykor/domain-contracts/attachments";
export interface OfficeDocumentPreview {
  html: string;
  format: OfficeFormat;
  page: number;
  pageCount?: number;
  sha256: string;
}
