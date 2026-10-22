import type { AttachmentLimits } from "@vykor/domain-contracts/attachments";
export const DEFAULT_ATTACHMENT_LIMITS: Readonly<AttachmentLimits> = {
  maxFilesPerPrompt: 20,
  maxBytesPerFile: 100 * 1024 * 1024,
  maxBytesPerPrompt: 250 * 1024 * 1024,
  maxSessionReferencedBytes: 2 * 1024 * 1024 * 1024,
  resumableThresholdBytes: 25 * 1024 * 1024,
  uploadSessionTtlMs: 24 * 60 * 60 * 1_000,
  stagingTtlMs: 24 * 60 * 60 * 1_000,
};
