import assert from "node:assert/strict"
import { mkdtemp, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

/** Start a test-owned MCP driver restricted to exact, already identified windows. */
export async function connectBoundedDriver({ executable, directory, windows, tools, onStderr }) {
  assert(isAbsolute(executable), "Use the absolute path of the verified Cua executable")
  assert(windows.length > 0 && windows.every(({ pid, window_id }) =>
    Number.isSafeInteger(pid) && pid > 0 && Number.isSafeInteger(window_id) && window_id > 0),
  "An exact PID and HWND are required for each test window")
  assert(tools.length > 0 && tools.every(name => /^[a-z][a-z_]*$/.test(name)), "Invalid manifest tool name")

  const isolated = await mkdtemp(join(resolve(directory), "cua-"))
  const manifest = join(isolated, "bounded.yaml")
  await writeFile(manifest, [
    "version: 3", "expires_after: 10m", "idle_timeout: 3m", "allow:",
    `  tools: [${tools.join(", ")}]`, "resources:", "  desktop:", "    display: false", "    windows:",
    ...windows.flatMap(({ pid, window_id }) => [`      - pid: ${pid}`, `        window_id: ${window_id}`]),
    "",
  ].join("\n"))

  const transport = new StdioClientTransport({
    command: executable,
    args: ["mcp", "--direct"],
    cwd: dirname(executable),
    stderr: "pipe",
    env: {
      LOCALAPPDATA: isolated,
      APPDATA: isolated,
      CUA_DRIVER_TELEMETRY_HOME: isolated,
      CUA_DRIVER_RS_TELEMETRY_ENABLED: "0",
      CUA_DRIVER_RS_UPDATE_CHECK: "0",
      CUA_DRIVER_PERMISSION_MODE: "bounded",
      CUA_DRIVER_CAPABILITY_MANIFEST_FILE: manifest,
      CUA_DRIVER_CAPABILITY_MANIFEST_APPROVED: "1",
    },
  })
  transport.stderr?.on("data", chunk => onStderr?.(chunk.toString()))
  const client = new Client({ name: "vykor-windows-probe", version: "1.0.0" })
  try {
    await client.connect(transport, { timeout: 10_000 })
    assert.equal(client.getServerVersion()?.version, "0.28.2", "Unexpected Cua executable version")
    return { client, pid: transport.pid, close: () => client.close() }
  } catch (error) {
    await transport.close()
    throw error
  }
}
