import {
  type AttachmentIntegrityService,
  DEFAULT_RETENTION_POLICY,
  type RetentionPolicy,
} from "@openharness/services";

export interface RetentionStoreOperations {
  applyRetention(policy: RetentionPolicy, timestamp: number): unknown;
  listRetentionAudits(): Array<Record<string, unknown>>;
}

/** 手动或定时运行的数据清理入口；每次结果都会写入 retention_audit。 */
export class ApplicationRetentionService {
  constructor(
    private readonly store: RetentionStoreOperations,
    private readonly attachmentIntegrity?: AttachmentIntegrityService,
  ) {}

  get policy(): RetentionPolicy {
    return { ...DEFAULT_RETENTION_POLICY };
  }

  run(policy: RetentionPolicy = DEFAULT_RETENTION_POLICY, timestamp = Date.now()) {
    return this.store.applyRetention(policy, timestamp);
  }

  audits(): Array<Record<string, unknown>> {
    return this.store.listRetentionAudits();
  }

  scanAttachments() {
    return this.requireAttachmentIntegrity().scan({
      gracePeriodMs: DEFAULT_RETENTION_POLICY.attachmentGracePeriodMs,
    });
  }

  repairAttachments() {
    return this.requireAttachmentIntegrity().repairSafe({
      gracePeriodMs: DEFAULT_RETENTION_POLICY.attachmentGracePeriodMs,
    });
  }

  gcAttachments() {
    return this.requireAttachmentIntegrity().gc({
      gracePeriodMs: DEFAULT_RETENTION_POLICY.attachmentGracePeriodMs,
    });
  }

  private requireAttachmentIntegrity(): AttachmentIntegrityService {
    if (!this.attachmentIntegrity) {
      throw new Error("Attachment integrity service is not configured");
    }
    return this.attachmentIntegrity;
  }
}
