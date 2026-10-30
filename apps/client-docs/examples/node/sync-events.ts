import { VykorClient, selectVisibleSessionMessagesWithParts, syncEvents } from "@rzx/client";

const { VYKOR_BASE_URL, VYKOR_TOKEN } = process.env;
const sessionId = process.argv[2];
if (!VYKOR_BASE_URL || !VYKOR_TOKEN || !sessionId) {
  throw new Error("请提供 VYKOR_BASE_URL、VYKOR_TOKEN，并把已有 sessionId 作为第一个参数");
}

const client = new VykorClient({ baseUrl: VYKOR_BASE_URL, token: VYKOR_TOKEN });
const controller = new AbortController();
const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
const cancel = () => controller.abort();
process.once("SIGINT", cancel);

try {
  for await (const update of syncEvents(client, { sessionId, signal })) {
    // SDK 先取快照，再接收 SSE（服务端持续推送的事件）；断线后恢复快照。
    // 客户端 state 是展示用副本，持久化会话与运行仍归 daemon 保存。
    const messages = selectVisibleSessionMessagesWithParts(update.state.buckets[sessionId]);
    console.log(`更新来源: ${update.source}，当前消息数: ${messages.length}`);
    const latest = messages.at(-1);
    if (latest) {
      console.log(latest.parts.filter(part => part.type === "text").map(part => part.text ?? "").join(""));
    }
  }
} finally {
  // 这里只停止本地订阅；不停止此会话的后台 Agent，也不回复权限请求。
  controller.abort();
  process.removeListener("SIGINT", cancel);
}
