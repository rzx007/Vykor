import { describe, expect, it } from "vitest";

import {
  OPENHARNESS_USER_AGENT,
  RequestHeaderTemplateError,
  expandRequestHeaderTemplates,
  normalizeRequestHeaderTemplates,
} from "./request-header-templates.js";

describe("request header templates", () => {
  it("expands every supported placeholder without mutating input", () => {
    const input = {
      "User-Agent": "{{userAgent}}",
      "x-session": "prefix-{{sessionId}}-{{sessionId}}",
      "X-Tenant": "desktop",
    };

    expect(
      expandRequestHeaderTemplates(input, {
        sessionId: "session-1",
        userAgent: OPENHARNESS_USER_AGENT,
      }),
    ).toEqual({
      "User-Agent": "openharness-ts/1.0",
      "x-session": "prefix-session-1-session-1",
      "X-Tenant": "desktop",
    });
    expect(input["x-session"]).toBe("prefix-{{sessionId}}-{{sessionId}}");
  });

  it.each([
    [{ "Bad Header": "value" }, "name"],
    [{ "X-Test": "line1\r\nline2" }, "value"],
    [{ "X-Test": "{{unknown}}" }, "unknown"],
    [{ "X-Test": "one", "x-test": "two" }, "duplicate"],
  ])("rejects unsafe or ambiguous headers", (headers, reason) => {
    expect(() => normalizeRequestHeaderTemplates(headers)).toThrow(
      RequestHeaderTemplateError,
    );
    expect(() => normalizeRequestHeaderTemplates(headers)).toThrow(reason);
  });

  it("requires a session only when the template references it", () => {
    expect(() =>
      expandRequestHeaderTemplates(
        { "X-Session": "{{sessionId}}" },
        { userAgent: OPENHARNESS_USER_AGENT },
      ),
    ).toThrow("sessionId");
    expect(
      expandRequestHeaderTemplates(
        { "X-Static": "value" },
        { userAgent: OPENHARNESS_USER_AGENT },
      ),
    ).toEqual({ "X-Static": "value" });
  });
});
