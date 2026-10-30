import { VykorClient, type VykorClientOptions } from "@rzx/client";

// 由应用调用本函数并传入连接参数；不要把真实 token 写进源码或构建配置。
// daemon 需允许该网页的准确来源（--allow-origin）。
export async function connect(
  options: VykorClientOptions,
  signal: AbortSignal = AbortSignal.timeout(10_000),
) {
  const client = new VykorClient(options);
  const capabilities = await client.protocol.capabilities({ signal });
  const sessions = await client.sessions.list({ limit: 10, signal });
  return { client, capabilities, sessions };
}
