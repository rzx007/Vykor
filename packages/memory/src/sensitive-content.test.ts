import { describe, expect, it } from "vitest";

import { detectCredentialValue } from "./sensitive-content.js";

describe("detectCredentialValue", () => {
  it("recognizes explicit credential values without returning them", () => {
    expect(detectCredentialValue("api_key=example-secret-value")).toBe("key_assignment");
    expect(detectCredentialValue("Bearer exampletoken123456")).toBe("bearer_token");
    expect(detectCredentialValue("-----BEGIN PRIVATE KEY-----")).toBe("private_key");
    expect(detectCredentialValue("sk-examplelongtoken123")).toBe("api_key_prefix");
  });

  it("keeps variable names and general guidance usable", () => {
    expect(detectCredentialValue("OPENAI_API_KEY")).toBeNull();
    expect(detectCredentialValue("API key 保存在环境变量中")).toBeNull();
  });
});
