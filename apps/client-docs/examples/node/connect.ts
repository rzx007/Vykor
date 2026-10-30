import { IncompatibleProtocolError, VykorApiError, VykorClient } from "@rzx/client";

const { VYKOR_BASE_URL, VYKOR_TOKEN } = process.env;
if (!VYKOR_BASE_URL || !VYKOR_TOKEN) {
  throw new Error("请提供已有 daemon 的 VYKOR_BASE_URL 和 VYKOR_TOKEN");
}

// 构造客户端只保存连接参数，不启动 daemon。
const client = new VykorClient({ baseUrl: VYKOR_BASE_URL, token: VYKOR_TOKEN });
const signal = AbortSignal.timeout(10_000);

try {
  const capabilities = await client.protocol.capabilities({ signal });
  const sessions = await client.sessions.list({ limit: 10, signal });
  console.log("服务支持的功能:", capabilities.features);
  console.table(sessions.map(({ id, title }) => ({ id, title })));
} catch (error) {
  if (error instanceof IncompatibleProtocolError) {
    console.error("客户端和 daemon 的通信协议不兼容，请升级对应版本。");
  } else if (error instanceof VykorApiError) {
    console.error(`daemon 请求失败，HTTP ${error.status}: ${error.message}`);
  }
  throw error;
}
