import { describe, expect, it } from "vitest";
import { connect } from "node:net";
import { createOAuthCallback } from "./callback.js";

describe("OAuth callback", () => {
  it("validates state and issuer and consumes a failed callback", async () => {
    const callback = await createOAuthCallback({ expectedState: "s1", expectedIssuer: "https://auth.test", requireIssuer: true, deadlineMs: 1_000 });
    const waiting = callback.wait();
    await expect(callback.accept(new URL(`${callback.redirectUri}?code=c&state=s1&iss=${encodeURIComponent("https://evil.test")}`)))
      .rejects.toMatchObject({ code: "oauth-issuer-mismatch" });
    await expect(waiting).rejects.toMatchObject({ code: "oauth-issuer-mismatch" });
    await expect(callback.accept(new URL(`${callback.redirectUri}?code=c&state=s1&iss=${encodeURIComponent("https://auth.test")}`)))
      .rejects.toMatchObject({ code: "oauth-callback-consumed" });
  });

  it("does not crash when a second queued request runs while the listener closes", async () => {
    const callback = await createOAuthCallback({
      expectedState: "s1",
      expectedIssuer: "https://auth.test",
      deadlineMs: 1_000,
    });
    const target = new URL(callback.redirectUri);
    const callbackPath = `${target.pathname}?code=c&state=s1`;
    const waiting = callback.wait();

    const rawResponse = await sendPipelinedRequests(
      Number(target.port),
      callbackPath,
      "/favicon.ico",
    );

    await expect(waiting).resolves.toMatchObject({ code: "c" });
    expect(rawResponse).toContain("200 OK");
    expect(rawResponse).toContain("400 Bad Request");
  });
});

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
