import { createServer } from "node:http";
import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { dirname } from "node:path";

const [file, version = "1.2.3", protocol = "5", delay = "0"] = process.argv.slice(2);
const token = "fixture-secret";
if (process.env.START_RECORD) await appendFile(process.env.START_RECORD, "start\n");
if (process.env.START_PIDS) await appendFile(process.env.START_PIDS, `${process.pid}\n`);
await new Promise(resolve => setTimeout(resolve, Number(delay)));
const server = createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url === "/health") return res.end(JSON.stringify({ ok: true, version }));
  if (req.url === "/capabilities") return res.end(JSON.stringify({ serverVersion: version, protocol: { version: Number(protocol) }, features: {} }));
  if (req.headers.authorization !== `Bearer ${token}`) {
    res.statusCode = 401;
    return res.end('{}');
  }
  if (req.headers["x-vykor-protocol-version"] !== protocol) {
    res.statusCode = 426;
    return res.end('{}');
  }
  return res.end(JSON.stringify({ sessions: [] }));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
await mkdir(dirname(file), { recursive: true });
await writeFile(file, JSON.stringify({
  url: `http://127.0.0.1:${server.address().port}`, pid: process.pid,
  token, version, startedAt: Date.now(), storePath: "fixture.db",
}));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
