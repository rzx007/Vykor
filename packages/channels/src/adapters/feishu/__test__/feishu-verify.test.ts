import { describe, expect, it, vi } from "vitest";

import { verifyFeishuCredentials } from "../feishu-verify.js";

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 400,
    json: async () => body,
  } as unknown as Response;
}

describe("verifyFeishuCredentials", () => {
  it("returns bot info after a successful tenant token exchange", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ code: 0, tenant_access_token: "t-1" }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, bot: { app_name: "机器人", open_id: "ou_bot", activate_status: 2 } }));

    const result = await verifyFeishuCredentials({
      appId: "cli_x",
      appSecret: "sec",
      domain: "feishu",
      fetchImpl,
    });

    expect(result).toEqual({ appId: "cli_x", name: "机器人", openId: "ou_bot", activated: 2 });
    expect(fetchImpl.mock.calls[0]![0]).toBe(
      "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
    );
    const init = fetchImpl.mock.calls[0]![1]!;
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ app_id: "cli_x", app_secret: "sec" }));
    expect((init.headers as Record<string, string>)["content-type"]).toContain("application/json");
  });

  it("throws a network error when the token request rejects", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError("fetch failed"));

    await expect(
      verifyFeishuCredentials({ appId: "cli_x", appSecret: "sec", domain: "feishu", fetchImpl }),
    ).rejects.toThrow(/网络/);
  });

  it("throws a credential error when the token response is not ok", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ code: 10003, msg: "invalid app_secret" }, false));

    await expect(
      verifyFeishuCredentials({ appId: "cli_x", appSecret: "bad", domain: "feishu", fetchImpl }),
    ).rejects.toThrow(/凭据/);
  });

  it("throws a credential error when the token body is not an object", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => null,
      } as unknown as Response);

    await expect(
      verifyFeishuCredentials({ appId: "cli_x", appSecret: "sec", domain: "feishu", fetchImpl }),
    ).rejects.toThrow(/凭据/);
  });

  it("throws a credential error when the token body reports an error", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ code: 10003, msg: "invalid app_secret" }));

    await expect(
      verifyFeishuCredentials({ appId: "cli_x", appSecret: "bad", domain: "feishu", fetchImpl }),
    ).rejects.toThrow(/凭据/);
  });

  it("uses the Lark API base for the lark domain", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ code: 0, tenant_access_token: "t" }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, bot: {} }));

    await verifyFeishuCredentials({ appId: "cli_x", appSecret: "s", domain: "lark", fetchImpl });
    expect(fetchImpl.mock.calls[0]![0]).toBe(
      "https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal",
    );
  });

  it("still succeeds when bot info is unavailable", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ code: 0, tenant_access_token: "t" }))
      .mockResolvedValueOnce(jsonResponse({ code: 1, msg: "nope" }, false));

    await expect(
      verifyFeishuCredentials({ appId: "cli_x", appSecret: "s", domain: "feishu", fetchImpl }),
    ).resolves.toEqual({ appId: "cli_x" });
  });
});
