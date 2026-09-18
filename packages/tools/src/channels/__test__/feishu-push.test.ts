import { afterEach, describe, expect, it, vi } from "vitest";

import { feishuApiBase, getTenantToken } from "../feishu-push.js";

describe("feishu-push api base", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the Lark API base for the lark domain", () => {
    expect(feishuApiBase("lark")).toBe("https://open.larksuite.com");
  });

  it("defaults to the Feishu API base", () => {
    expect(feishuApiBase("feishu")).toBe("https://open.feishu.cn");
    expect(feishuApiBase(undefined)).toBe("https://open.feishu.cn");
  });

  it("sends the tenant token request to the passed base", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      json: async () => ({ tenant_access_token: "t-1" }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const token = await getTenantToken(
      "cli_x",
      "sec",
      new AbortController().signal,
      feishuApiBase("lark"),
    );

    expect(token).toBe("t-1");
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal",
    );
  });
});
