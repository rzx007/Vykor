import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { appendFileSync, existsSync, readFileSync } from "node:fs"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as sleep } from "node:timers/promises"
import { connectBoundedDriver } from "../cua-direct.mjs"

if (process.platform !== "win32" || process.arch !== "x64") {
  console.log("SKIP: the real Cua fixture requires an interactive Windows x64 session")
  process.exit(0)
}

const [driverArgument, evidenceRoot = tmpdir()] = process.argv.slice(2)
assert(driverArgument, "Usage: node direct-fixture.mjs <verified cua-driver.exe> [evidence directory]")
const executable = resolve(driverArgument)
await mkdir(evidenceRoot, { recursive: true })
const output = await mkdtemp(join(resolve(evidenceRoot), "vykor-cua-fixture-"))
const fixtureTrace = join(output, "fixture.jsonl")
const driverTrace = join(output, "driver.jsonl")
const fixtureExe = join(output, "Fixture.exe")
const systemRoot = process.env.SystemRoot ?? "C:\\Windows"
const compiler = join(systemRoot, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe")
const source = fileURLToPath(new URL("../fixtures/Fixture.cs", import.meta.url))

function record(kind, details) {
  appendFileSync(driverTrace, JSON.stringify({ kind, details, utc: new Date().toISOString() }) + "\n")
}

function rows() {
  if (!existsSync(fixtureTrace)) return []
  const contents = readFileSync(fixtureTrace, "utf8")
  return contents.slice(0, contents.lastIndexOf("\n") + 1).split("\n").filter(Boolean).map(line => JSON.parse(line))
}

async function until(read, description, timeout = 8_000) {
  const deadline = Date.now() + timeout
  do {
    const value = read()
    if (value) return value
    await sleep(40)
  } while (Date.now() < deadline)
  throw new Error(`Timed out waiting for ${description}`)
}

function activeDriverProcesses() {
  const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  const result = execFileSync(powershell, [
    "-NoProfile", "-NonInteractive", "-Command",
    "Get-CimInstance Win32_Process -Filter \"Name = 'cua-driver.exe' OR Name = 'cua-driver-uia.exe'\" | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress",
  ], { encoding: "utf8", windowsHide: true, timeout: 10_000 }).trim()
  return result ? [JSON.parse(result)].flat() : []
}

function toolResult(reply) {
  assert(!reply.isError, JSON.stringify(reply))
  const result = reply.structuredContent
  assert(result && typeof result === "object", "The driver returned no structured result")
  return result
}

function refusal(reply, pattern) {
  assert(reply.isError, `Expected a refusal, received ${JSON.stringify(reply)}`)
  assert.match(JSON.stringify(reply), pattern)
}

function element(state, label) {
  const matches = state.elements?.filter(item => item.label === label && item.element_token) ?? []
  assert.equal(matches.length, 1, `Expected exactly one current ${label} element`)
  return matches[0]
}

execFileSync(compiler, [
  "/nologo", "/target:winexe", "/platform:x64", "/r:System.Drawing.dll", "/r:System.Windows.Forms.dll",
  "/r:System.Web.Extensions.dll", `/out:${fixtureExe}`, source,
], { windowsHide: true, stdio: "inherit" })

const baseline = new Set(activeDriverProcesses().map(item => item.ProcessId))
const fixture = spawn(fixtureExe, [fixtureTrace, output.slice(-6)], { stdio: "ignore", windowsHide: false })
const fixtureExit = new Promise((resolveExit, reject) => {
  fixture.once("error", reject)
  fixture.once("exit", (code, signal) => resolveExit({ code, signal }))
})
fixtureExit.catch(() => {})
const openDrivers = new Set()
const ownedPids = new Set()
let checkFailed = false

async function connect(target) {
  const driver = await connectBoundedDriver({
    executable, directory: output, windows: [target],
    tools: ["start_session", "end_session", "list_windows", "get_window_state", "bring_to_front", "click", "set_value", "press_key"],
    onStderr: message => record("driver-stderr", message.trim()),
  })
  assert(driver.pid && !baseline.has(driver.pid), "The probe needs a dedicated stdio driver")
  openDrivers.add(driver)
  ownedPids.add(driver.pid)
  return driver
}

async function close(driver) {
  openDrivers.delete(driver)
  await driver.close()
  record("driver-closed", { pid: driver.pid })
}

let session = "fixture"
function caller(driver) {
  return async (name, args = {}) => {
    const reply = await driver.client.callTool({ name, arguments: { ...args, session } }, undefined, { timeout: 10_000 })
    const content = reply.content.map(item => item.type === "image"
      ? { type: item.type, mimeType: item.mimeType, encodedLength: item.data.length }
      : item)
    record("tool", { name, args, reply: { ...reply, content } })
    return reply
  }
}

function report(name, details = {}) {
  record("pass", { name, ...details })
  console.log("PASS", name)
}

async function foreground(call, window) {
  const state = toolResult(await call("bring_to_front", window))
  assert.equal(state.landed_on_target, true, "The owned test window must be in the foreground")
  assert.equal(Number(state.now_fg_hwnd), window.window_id)
}

try {
  const ready = await until(() => rows().find(row => row.kind === "ready"), "fixture windows")
  assert.equal(ready.pid, fixture.pid)
  assert(ready.target && ready.control && ready.target !== ready.control)
  assert(ready.interactive && ready.sessionId > 0, "Run the fixture in an interactive Windows session")
  assert.equal(ready.targetTitle, ready.controlTitle, "The negative control must share the target title")
  const target = { pid: ready.pid, window_id: ready.target }
  const secondary = { pid: ready.pid, window_id: ready.control }
  const controlDriver = await connect(secondary)
  const controlCall = caller(controlDriver)
  toolResult(await controlCall("start_session"))
  await foreground(controlCall, secondary)
  await close(controlDriver)
  const driver = await connect(target)
  const call = caller(driver)
  const observe = async () => toolResult(await call("get_window_state", {
    ...target, include_screenshot: false, max_elements: 50,
  }))

  toolResult(await call("start_session"))
  refusal(await call("list_windows", { pid: target.pid }), /outside.manifest|permission|bounded/i)
  refusal(await call("get_window_state", { ...secondary, include_screenshot: false }), /outside.manifest|permission|bounded/i)
  const first = await observe()
  assert.equal(first.window_title, ready.targetTitle)
  assert.match(first.tree_markdown, /clicks=0 edits=0 value=/)
  const oldButton = element(first, "Increment once")
  const current = await observe()
  refusal(await call("click", { ...target, element_token: oldButton.element_token, delivery_mode: "background" }),
    /stale|superseded/i)
  const button = element(current, "Increment once")
  refusal(await call("click", { ...secondary, element_token: button.element_token, delivery_mode: "background" }),
    /outside.manifest|permission|bounded/i)
  const actions = () => rows().filter(row => row.kind === "click" || row.kind === "edit")
  assert.equal(actions().length, 0, "The stale element must not produce input")
  report("exact HWND scope, same-PID refusal and stale element refusal")

  toolResult(await call("click", { ...target, element_token: button.element_token, delivery_mode: "background" }))
  const clicked = await until(() => actions().find(row => row.kind === "click"), "independent click evidence")
  assert.equal(clicked.window, "target")
  assert.equal(clicked.clicks, 1)
  const clickedTree = await observe()
  assert.match(clickedTree.tree_markdown, /clicks=1 edits=0 value=/)

  const text = "vykor-fixture-" + output.slice(-6)
  toolResult(await call("set_value", {
    ...target, element_token: element(clickedTree, "Probe input").element_token, value: text,
  }))
  const edited = await until(() => actions().find(row => row.kind === "edit" && row.value === text), "independent edit evidence")
  assert.equal(edited.window, "target")
  const editedTree = await observe()
  assert.equal(element(editedTree, "Probe input").value, text)
  assert.equal(actions().length, 2)
  for (const event of [clicked, edited]) assert.equal(event.foreground, ready.control, "A background action stole focus")
  report("background click and text readback with the control window in front")

  const capture = await call("get_window_state", { ...target, include_screenshot: true, max_dimension: 420 })
  const screenshot = capture.content.find(item => item.type === "image" && item.mimeType === "image/png")
  assert(screenshot?.data, "The exact-window snapshot did not include an inline PNG")
  const png = Buffer.from(screenshot.data, "base64")
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a")
  await writeFile(join(output, "target-window.png"), png)
  report("exact-window PNG", { width: png.readUInt32BE(16), height: png.readUInt32BE(20) })

  await foreground(call, target)
  const frontTree = await observe()
  toolResult(await call("click", { ...target, element_token: element(frontTree, "Increment once").element_token,
    delivery_mode: "foreground" }))
  const mouseUp = await until(() => rows().find(row => row.kind === "mouse-up-Left"), "fixture mouse release")
  const mouseDown = rows().find(row => row.kind === "mouse-down-Left")
  assert.equal(mouseDown?.window, "target")
  assert.equal(mouseUp.window, "target")
  assert(mouseUp.utc >= mouseDown.utc)
  assert.equal(actions().filter(row => row.kind === "click").length, 2)
  const keyTree = await observe()
  toolResult(await call("press_key", { ...target, key: "f8",
    element_token: element(keyTree, "Probe input").element_token, delivery_mode: "foreground" }))
  const keyUp = await until(() => rows().find(row => row.kind === "key-up-F8"), "fixture key release")
  const keyDown = rows().find(row => row.kind === "key-down-F8")
  assert.equal(keyDown?.window, "target")
  assert.equal(keyUp.window, "target")
  assert(keyUp.utc >= keyDown.utc)
  report("owned foreground mouse and key down/up pairs")

  const last = await observe()
  toolResult(await call("end_session"))
  refusal(await call("click", { ...target, element_token: element(last, "Increment once").element_token,
    delivery_mode: "background" }), /session.ended|ended.*session|session.*closed/i)
  assert.equal(actions().length, 3)
  report("ended session rejects writes")

  session = "fixture-eof"
  toolResult(await call("start_session"))
  const slow = element(await observe(), "Delayed action")
  const inFlight = call("click", { ...target, element_token: slow.element_token, delivery_mode: "background" })
    .then(() => "replied", () => "closed")
  await until(() => rows().find(row => row.kind === "slow-begin"), "delayed application action to start")
  const closedAt = new Date().toISOString()
  await close(driver)
  const completed = await until(() => rows().find(row => row.kind === "slow-done"), "already-delivered application action")
  assert(completed.utc > closedAt, "The fixture must demonstrate an already-delivered effect can continue after stop was requested")
  report("stdio close and already-delivered outcome", { request: await inFlight, closedAt, applicationDone: completed.utc })

  await writeFile(join(output, "recreate.request"), "")
  const recreated = await until(() => rows().find(row => row.kind === "recreated"), "recreated fixture HWND")
  assert.notEqual(recreated.hwnd, ready.target)
  const staleDriver = await connect(target)
  const staleCall = caller(staleDriver)
  toolResult(await staleCall("start_session"))
  const oldWindowResult = await staleCall("get_window_state", { ...target, include_screenshot: false })
  assert(oldWindowResult.isError, "The destroyed HWND must not return a window")
  refusal(await staleCall("get_window_state", { ...target, window_id: recreated.hwnd, include_screenshot: false }),
    /outside.manifest|permission|bounded/i)
  assert(actions().every(row => row.window === "target"), "The same PID negative control changed")
  await close(staleDriver)
  report("window replacement needs a new manifest")
} catch (error) {
  checkFailed = true
  record("failure", error.stack ?? String(error))
  console.error(error.message)
} finally {
  for (const driver of openDrivers) {
    await close(driver).catch(error => {
      checkFailed = true
      record("close-failure", error.message)
    })
  }
  await writeFile(join(output, "close.request"), "")
  let fixtureResult = await Promise.race([fixtureExit.catch(() => null), sleep(2_000, null, { ref: false })])
  if (!fixtureResult && fixture.pid) {
    fixture.kill()
    fixtureResult = await fixtureExit
  }
  const live = activeDriverProcesses().filter(item =>
    ownedPids.has(item.ProcessId) || ownedPids.has(item.ParentProcessId))
  record("cleanup", { fixtureResult, remainingDriverProcesses: live })
  if (live.length || fixtureResult?.code !== 0) {
    checkFailed = true
    console.error("Owned process cleanup did not finish gracefully")
  } else {
    report("direct driver and owned children exited")
  }
  console.log("Evidence:", output)
  if (checkFailed) process.exitCode = 1
}
