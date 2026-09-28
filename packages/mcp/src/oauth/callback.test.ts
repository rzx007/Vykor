import { describe, expect, it } from "vitest";
import { connect } from "node:net";
import { createOAuthCallback, parseCallbackUrl } from "./callback.js";

describe("OAuth callback", () => {
  it.each(["https://user:pass@app.example/callback?code=c&state=s1", "https://app.example/callback?code=c&state=s1#secret"])("rejects unsafe submitted callback %s without consuming", async value => {
    const callback = await createOAuthCallback({ expectedState: "s1", expectedIssuer: "https://auth.test", callbackUrl: "https://app.example/callback" });
    try {
      await expect(callback.accept(new URL(value))).rejects.toMatchObject({ code: "oauth-callback-invalid" });
      await expect(callback.accept(new URL("https://app.example/callback?code=good&state=s1"))).resolves.toMatchObject({ code: "good" });
    } finally { await callback.close(); }
  });
  it("ignores unrelated paths, wrong state and wrong issuer without consuming the wait", async () => {
    const callback = await createOAuthCallback({ expectedState: "s1", expectedIssuer: "https://auth.test", requireIssuer: true, deadlineMs: 2_000 });
    const waiting = callback.wait();

    expect((await get(callback, "/favicon.ico")).status).toBe(404);
    expect((await get(callback, "//[")).status).toBe(400);
    expect((await get(callback, "/other?code=x&state=s1")).status).toBe(404);
    expect((await get(callback, "/oauth/callback?code=c&state=wrong")).status).toBe(400);
    expect((await get(callback, `/oauth/callback?code=c&state=s1&iss=${encodeURIComponent("https://evil.test")}`)).status).toBe(400);

    // The valid callback still succeeds after all the malformed traffic.
    const ok = await get(callback, `/oauth/callback?code=c&state=s1&iss=${encodeURIComponent("https://auth.test")}`);
    expect(ok.status).toBe(200);
    await expect(waiting).resolves.toMatchObject({ code: "c", issuer: "https://auth.test" });
    await callback.close();
  });

  it("consumes a valid access_denied once and rejects a later callback", async () => {
    const callback = await createOAuthCallback({ expectedState: "s1", expectedIssuer: "https://auth.test", deadlineMs: 2_000 });
    const waiting = callback.wait();

    expect((await get(callback, "/oauth/callback?error=access_denied&state=s1")).status).toBe(400);
    await expect(waiting).rejects.toMatchObject({ code: "oauth-authorization-denied" });
    expect((await get(callback, "/oauth/callback?code=c&state=s1")).status).toBe(409);
    await callback.close();
  });

  it("rejects a second successful callback", async () => {
    const callback = await createOAuthCallback({ expectedState: "s1", expectedIssuer: "https://auth.test", deadlineMs: 2_000 });
    const waiting = callback.wait();

    expect((await get(callback, "/oauth/callback?code=first&state=s1")).status).toBe(200);
    await expect(waiting).resolves.toMatchObject({ code: "first" });
    expect((await get(callback, "/oauth/callback?code=second&state=s1")).status).toBe(409);
    await callback.close();
  });

  it("keeps serving a pipelined unrelated request while the callback completes", async () => {
    const callback = await createOAuthCallback({
      expectedState: "s1",
      expectedIssuer: "https://auth.test",
      deadlineMs: 2_000,
    });
    const target = new URL(callback.redirectUri);
    const waiting = callback.wait();

    const rawResponse = await sendPipelinedRequests(
      Number(target.port),
      `${target.pathname}?code=c&state=s1`,
      "/favicon.ico",
    );

    await expect(waiting).resolves.toMatchObject({ code: "c" });
    expect(rawResponse).toContain("200 OK");
    expect(rawResponse).toContain("404 Not Found");
    await callback.close();
  });

  it("rejects a conflicting callbackUrl and callbackPort, and unsafe callback URLs", async () => {
    await expect(createOAuthCallback({
      expectedState: "s1",
      expectedIssuer: "https://auth.test",
      callbackUrl: "http://127.0.0.1:1234/cb",
      port: 4321,
    })).rejects.toMatchObject({ code: "oauth-callback-config-conflict" });

    for (const value of [
      "http://0.0.0.0:1234/cb",
      "http://example.com:1234/cb",
      "http://127.0.0.1/cb",
      "http://127.0.0.1:0/cb",
      "http://[::1]:0/cb",
      "http://user:pass@127.0.0.1:1234/cb",
      "http://127.0.0.1:1234/cb?x=1",
      "http://127.0.0.1:1234/cb#frag",
    ]) {
      expect(() => parseCallbackUrl(value)).toThrow();
    }
  });

  it("accepts an HTTPS callback in manual mode without opening a listener", async () => {
    const callback = await createOAuthCallback({
      expectedState: "s1",
      expectedIssuer: "https://auth.test",
      callbackUrl: "https://app.example/callback",
      deadlineMs: 2_000,
    });
    expect(callback.redirectUri).toBe("https://app.example/callback");
    await expect(callback.accept(new URL("https://app.example/callback?code=c&state=s1")))
      .resolves.toMatchObject({ code: "c" });
    await callback.close();
  });

  it("closes the listener when the wait is aborted", async () => {
    const callback = await createOAuthCallback({ expectedState: "s1", expectedIssuer: "https://auth.test", deadlineMs: 2_000 });
    const target = new URL(callback.redirectUri);
    const controller = new AbortController();
    const waiting = callback.wait(controller.signal);
    controller.abort(new Error("cancelled"));
    await expect(waiting).rejects.toBeDefined();
    await callback.close();
    await expect(get(`http://127.0.0.1:${target.port}`, "/oauth/callback?code=c&state=s1")).rejects.toBeDefined();
  });
});

function get(
  callbackOrUrl: { redirectUri: string } | string,
  path: string,
): Promise<{ status: number; body: string }> {
  const base = typeof callbackOrUrl === "string" ? callbackOrUrl : callbackOrUrl.redirectUri;
  const target = new URL(base);
  return request(Number(target.port), path);
}

function request(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let response = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Timed out waiting for callback response"));
    }, 2_000);
    socket.setEncoding("utf8");
    socket.on("data", chunk => { response += chunk; });
    socket.once("error", error => { clearTimeout(timer); reject(error); });
    socket.once("end", () => {
      clearTimeout(timer);
      const match = /HTTP\/1\.1 (\d+)/.exec(response);
      const [, , body] = response.split("\r\n\r\n");
      resolve({ status: match ? Number(match[1]) : 0, body: body ?? "" });
    });
    socket.once("connect", () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    });
  });
}

function sendPipelinedRequests(
  port: number,
  firstPath: string,
  secondPath: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let response = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Timed out waiting for callback responses"));
    }, 1_000);
    socket.setEncoding("utf8");
    socket.on("data", chunk => {
      response += chunk;
      if ((response.match(/HTTP\/1\.1/g) ?? []).length === 2) {
        clearTimeout(timer);
        socket.end();
        resolve(response);
      }
    });
    socket.once("error", error => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once("connect", () => {
      socket.write(
        `GET ${firstPath} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: keep-alive\r\n\r\n` +
        `GET ${secondPath} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`,
      );
    });
  });
}
