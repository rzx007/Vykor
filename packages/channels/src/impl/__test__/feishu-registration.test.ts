import { describe, expect, it, vi } from "vitest";

import { FeishuRegistration } from "../feishu-registration.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("FeishuRegistration", () => {
  it("emits QR ready then succeeds with credentials", async () => {
    const gate = deferred<{ client_id: string; client_secret: string; user_info: { open_id: string; tenant_brand: "lark" } }>();
    const onCredentials = vi.fn(async () => undefined);
    const registration = new FeishuRegistration({
      registerApp: vi.fn(async (options: any) => {
        options.onQRCodeReady({ url: "https://open.feishu.cn/page/launcher?x=1", expireIn: 600 });
        options.onStatusChange({ status: "polling" });
        return gate.promise;
      }),
      onCredentials,
      now: () => 1000,
    });

    registration.start({ domain: "feishu" });
    expect(registration.status().state).toBe("qr_ready");
    expect(registration.status().qrUrl).toContain("open.feishu.cn");

    gate.resolve({
      client_id: "cli_x",
      client_secret: "secret_x",
      user_info: { open_id: "ou_me", tenant_brand: "lark" },
    });
    await vi.waitFor(() => expect(registration.status().state).toBe("succeeded"));
    expect(onCredentials).toHaveBeenCalledWith({
      appId: "cli_x",
      appSecret: "secret_x",
      userId: "ou_me",
      domain: "lark",
    });
  });

  it("maps access_denied to error and abort to cancelled", async () => {
    const registration = new FeishuRegistration({
      registerApp: vi.fn(async () => {
        throw Object.assign(new Error("denied"), { code: "access_denied" });
      }),
      onCredentials: vi.fn(async () => undefined),
    });
    registration.start();
    await vi.waitFor(() => expect(registration.status().state).toBe("error"));
    expect(registration.status().error?.code).toBe("access_denied");
  });

  it("cancel aborts an active attempt without credentials", async () => {
    const onCredentials = vi.fn(async () => undefined);
    const registration = new FeishuRegistration({
      registerApp: vi.fn(async (options: any) => {
        options.onQRCodeReady({ url: "https://open.feishu.cn/x", expireIn: 600 });
        return new Promise(() => {});
      }),
      onCredentials,
    });
    registration.start();
    expect(registration.status().state).toBe("qr_ready");
    registration.cancel();
    expect(registration.status().state).toBe("cancelled");
    expect(onCredentials).not.toHaveBeenCalled();
  });
});
