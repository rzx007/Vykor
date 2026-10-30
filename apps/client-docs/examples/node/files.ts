import { VykorApiError, VykorClient } from "@rzx/client";

const { VYKOR_BASE_URL, VYKOR_TOKEN } = process.env;
const sessionId = process.argv[2];
const relativePath = process.argv[3] ?? "README.md";
if (!VYKOR_BASE_URL || !VYKOR_TOKEN || !sessionId) {
  throw new Error("请提供 VYKOR_BASE_URL、VYKOR_TOKEN，并把已有 sessionId 作为第一个参数");
}

const client = new VykorClient({ baseUrl: VYKOR_BASE_URL, token: VYKOR_TOKEN });
const signal = AbortSignal.timeout(10_000);
const capabilities = await client.protocol.capabilities({ signal });
if ((capabilities.features.sessionFiles ?? 0) < 1) {
  throw new Error("daemon 尚未提供会话文件接口，请升级 daemon");
}

try {
  // 路径属于会话在 daemon 机器上的工作区，用 / 分隔；. 表示根目录。
  // 这些操作只读文件，不启动 Agent，也不调用模型。
  const directory = await client.files.list(sessionId, { path: ".", limit: 100, signal });
  const info = await client.files.stat(sessionId, relativePath, { signal });
  const text = await client.files.readText(sessionId, relativePath, { maxBytes: 64 * 1024, signal });
  const found = await client.files.find(sessionId, { path: ".", pattern: "**/*.ts", limit: 100, signal });
  const searched = await client.files.search(sessionId, {
    path: ".", query: "TODO", include: "**/*.ts", caseSensitive: false, limit: 100, signal,
  });
  console.table(directory.entries);
  console.log("文件信息:", info);
  console.log("文本:", text.content);
  console.log("TypeScript 文件:", found.files);
  console.table(searched.matches);
  console.log("结果是否截断:", {
    directory: directory.truncated, text: text.truncated,
    find: found.truncated, search: searched.truncated,
  });
} catch (error) {
  if (error instanceof VykorApiError) {
    console.error(`文件请求失败，HTTP ${error.status}: ${error.message}`);
    // 例如 403 表示读取策略拒绝；501 表示宿主缺少安全读取能力。
    // 能力标记不保证每种文件系统都支持正文读取。
  }
  throw error;
}
