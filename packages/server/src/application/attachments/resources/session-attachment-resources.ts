import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { chmod, copyFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { classifyAttachmentCandidate } from "@openharness/services";

import type { AttachmentService } from "../attachment-service.js";
import type { AttachmentRoutingDecision } from "../routing/attachment-routing-types.js";

export interface SessionAttachmentResourcesOptions {
  root: string;
  attachments: AttachmentService;
}

export class SessionAttachmentResources {
  constructor(private readonly options: SessionAttachmentResourcesOptions) {
    rmSync(this.options.root, { recursive: true, force: true });
    mkdirSync(this.options.root, { recursive: true });
  }

  async prepareSession(sessionId: string): Promise<string> {
    return this.prepareSessionSync(sessionId);
  }

  prepareSessionSync(sessionId: string): string {
    const root = this.sessionRoot(sessionId);
    mkdirSync(root, { recursive: true });
    return root;
  }

  async materializeRun(input: {
    sessionId: string;
    runId: string;
    decisions: readonly AttachmentRoutingDecision[];
  }): Promise<() => Promise<void>> {
    const sessionRoot = await this.prepareSession(input.sessionId);
    const runRoot = join(sessionRoot, safeSegment(input.runId));
    await mkdir(runRoot, { recursive: false });
    try {
      for (const decision of input.decisions) {
        if (decision.route !== "text_resource") continue;
        const asset = this.options.attachments.get(decision.assetId);
        if (
          asset.status !== "ready" ||
          !asset.mediaType ||
          classifyAttachmentCandidate({
            displayName: asset.displayName,
            mediaType: asset.mediaType,
          }) !== "text"
        ) {
          throw new Error("attachment_resource_unavailable");
        }
        const source = await this.options.attachments.resolveReadyContentPath(asset.id);
        const destination = join(runRoot, safeSegment(asset.id));
        await copyFile(source.path, destination);
        await chmod(destination, 0o444);
      }
    } catch (error) {
      await rm(runRoot, { recursive: true, force: true });
      throw error;
    }
    let cleaned = false;
    return async () => {
      if (cleaned) return;
      cleaned = true;
      await rm(runRoot, { recursive: true, force: true });
    };
  }

  async close(): Promise<void> {
    await rm(this.options.root, { recursive: true, force: true });
  }

  private sessionRoot(sessionId: string): string {
    const digest = createHash("sha256").update(sessionId).digest("hex");
    return join(this.options.root, digest);
  }
}

function safeSegment(value: string): string {
  if (!/^[A-Za-z0-9._-]+$/u.test(value) || value === "." || value === "..") {
    return createHash("sha256").update(value).digest("hex");
  }
  return value;
}
