import { AttachmentError } from "@vykor/services";
import { DomainValidationError } from "@vykor/domain-contracts/inputs";
import { describe, expect, it } from "vitest";

import { applicationErrorResponse, attachmentErrorResponse, protocolValidationErrorResponse } from "./support.js";

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

describe("domain validation error adapters", () => {
  it("retains the existing wire error code and field details", async () => {
    const response = applicationErrorResponse(new DomainValidationError("invalid_text", "items", "invalid_value"));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: "invalid_request", message: "invalid_text",
      details: { field: "items", reason: "invalid_value" },
    });
  });

  it("retains the argument payload limit status and wire code", async () => {
    const response = protocolValidationErrorResponse(new DomainValidationError("arguments are too large", "args", "payload_too_large"));
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      code: "payload_too_large", message: "arguments are too large",
      details: { field: "args", reason: "payload_too_large" },
    });
  });
});
