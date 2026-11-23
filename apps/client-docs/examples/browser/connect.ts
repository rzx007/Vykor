import { VykorClient, type VykorClientOptions } from "@rzx/client";

// 由应用调用本函数并传入连接参数；不要把真实 token 写进源码或构建配置。
// daemon 需允许该网页的准确来源（--allow-origin）。
// 此示例连接 Agent 会话。项目资源管理器是 Electron 的本机功能，
// 浏览器若需要访问用户设备上的文件，应使用浏览器提供的文件选择能力。
export async function connect(
  options: VykorClientOptions,
  signal: AbortSignal = AbortSignal.timeout(10_000),
) {
  const client = new VykorClient(options);
  const capabilities = await client.protocol.capabilities({ signal });
  const sessions = await client.sessions.list({ limit: 10, signal });
  return { client, capabilities, sessions };
}
