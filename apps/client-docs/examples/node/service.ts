import { VykorClient } from "@rzx/client";
import { Service } from "@rzx/client/service";

// 可选 Node 入口。浏览器与连接已有 daemon 的脚本不需要导入它。
const mode = process.argv[2] ?? "--discover";
if (!["--discover", "--start", "--stop"].includes(mode)) {
  throw new Error("用法: node service.ts [--discover | --start | --stop]");
}

const endpoint = mode === "--start"
  ? await Service.ensure({ cwd: process.cwd(), timeoutMs: 15_000 })
  : await Service.discover({ timeoutMs: 1_000, signal: AbortSignal.timeout(5_000) });

if (!endpoint) {
  console.log("没有发现健康且协议兼容的本机 daemon；使用 --start 显式启动。");
} else if (mode === "--stop") {
  // 这是显式停整个共用 daemon，所有连接它的客户端都会受影响。
  console.log("正在停止整个共用 daemon。");
  const stopped = await Service.stop(endpoint, { timeoutMs: 5_000 });
  console.log(stopped ? "daemon 已停止。" : "登记实例已变化或无法核验，未停止进程。");
} else {
  // endpoint 含凭据，不要打印、持久化到公开文件或发到网页。
  const client = new VykorClient(Service.clientOptions(endpoint));
  const sessions = await client.sessions.list({ limit: 10, signal: AbortSignal.timeout(10_000) });
  console.table(sessions.map(({ id, title }) => ({ id, title })));
  console.log("脚本结束后 daemon 继续运行，供其他客户端使用。");
}
