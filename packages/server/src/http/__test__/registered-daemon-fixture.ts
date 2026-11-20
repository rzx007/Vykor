import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { CURRENT_PROTOCOL_VERSION, PROTOCOL_VERSION_HEADER } from "@vykor/protocol";
import { readDaemonRegistry } from "../../daemon/paths.js";
import { runRegisteredDaemon } from "../../daemon-host/registered-daemon.js";

const launcher = process.env.VYKOR_TEST_LAUNCHER;
const baseDataDirectory = process.env.VYKOR_TEST_BASE_DATA;
if ((launcher !== "desktop" && launcher !== "cli") || !baseDataDirectory)
  throw new Error("Missing daemon fixture configuration.");

const stop = new AbortController();
process.on("message", (message) => {
  if (message === "stop") stop.abort();
});
const file = join(baseDataDirectory, "daemon", "registry.json");
let launchError: unknown;
const running = runRegisteredDaemon({
  launcher, baseDataDirectory, version: "0.1.0", signal: stop.signal,
}).catch((error: unknown) => { launchError = error; });
try {
  const deadline = Date.now() + 25_000;
  let registry = readDaemonRegistry(file);
  while (!registry && !launchError && Date.now() < deadline) {
    await sleep(50);
    registry = readDaemonRegistry(file);
  }
  if (!registry) throw launchError ?? new Error("Daemon did not register.");
  const response = await fetch(`${registry.url}/sessions`, {
    headers: {
      authorization: `Bearer ${registry.token}`,
      [PROTOCOL_VERSION_HEADER]: String(CURRENT_PROTOCOL_VERSION),
    },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Session list returned HTTP ${response.status}.`);
  const { sessions } = await response.json() as { sessions: Array<{ id: string }> };
  const eventResponse = await fetch(`${registry.url}/events/stream?cursor=0`, {
    headers: {
      authorization: `Bearer ${registry.token}`,
      [PROTOCOL_VERSION_HEADER]: String(CURRENT_PROTOCOL_VERSION),
    },
    signal: AbortSignal.timeout(5_000),
  });
  if (!eventResponse.ok || !eventResponse.body) throw new Error("Event stream is unavailable.");
  const reader = eventResponse.body.pipeThrough(new TextDecoderStream()).getReader();
  let eventSeq: number | undefined;
  let content = "";
  try {
    while (eventSeq === undefined) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("Event stream closed before the seeded event.");
      content += chunk.value;
      const match = /id: (\d+)\nevent: session\.created\n/.exec(content);
      if (match) eventSeq = Number(match[1]);
    }
  } finally {
    await reader.cancel();
  }
  process.send?.({
    launcher, pid: process.pid, ownerPid: registry.pid, eventSeq, sessionIds: sessions.map((session) => session.id),
  });
  await running;
  if (launchError && (
    registry.pid === process.pid ||
    ((launchError as NodeJS.ErrnoException).code !== "ELOCKED" &&
      !(launchError instanceof Error && launchError.message.startsWith("Registry is still owned")))
  )) throw launchError;
} finally {
  stop.abort();
  await running;
  if (process.connected) process.disconnect?.();
}
