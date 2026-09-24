import { AttachmentError } from "@vykor/services";
import { describe, expect, it } from "vitest";

import { applicationErrorResponse, attachmentErrorResponse } from "./support.js";

describe("attachmentErrorResponse", () => {
  it.each([
    ["prompt_content_required", 400],
    ["attachment_duplicate_reference", 400],
    ["attachment_not_found", 404],
    ["attachment_not_ready", 409],
    ["prompt_id_conflict", 409],
    ["attachment_in_use", 409],
    ["attachment_structured_steer_unsupported", 409],
    ["attachment_count_exceeded", 413],
    ["attachment_prompt_size_exceeded", 413],
    ["attachment_session_size_exceeded", 413],
  ] as const)("maps %s to HTTP %i", (code, status) => {
    expect(attachmentErrorResponse(new AttachmentError(code, "test")).status).toBe(
      status,
    );
  });

  it("uses the same attachment mapping through the general application handler", () => {
    expect(
      applicationErrorResponse(
        new AttachmentError("attachment_count_exceeded", "too many"),
      ).status,
    ).toBe(413);
  });
});
