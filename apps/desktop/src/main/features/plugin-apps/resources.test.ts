import { expect, it } from "vitest"
import { appHtml, validateAppResource } from "./resources"
it("checks official resource shape, URI, MIME, finite decoded size and canonical base64", () => {
  expect(() => appHtml({ contents: [{ uri: "ui://x", mimeType: "text/html", text: "<p>" }] }, "ui://x")).toThrow("invalid_html")
  expect(() => validateAppResource({ contents: [{ uri: "ui://other", text: "x" }] }, "ui://x")).toThrow("uri_mismatch")
  expect(() => validateAppResource({ contents: [{ uri: "ui://x", blob: "abc!" }] }, "ui://x")).toThrow()
  expect(() => validateAppResource({ contents: [{ uri: "ui://x", text: "x".repeat(8 * 1024 * 1024 + 1) }] }, "ui://x")).toThrow("too_large")
  expect(appHtml({ contents: [{ uri: "ui://x", mimeType: "text/html;profile=mcp-app", text: "<p>" }] }, "ui://x").sha256).toMatch(/^[0-9a-f]{64}$/)
})
