import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, parse, resolve } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { connectBoundedDriver } from "../cua-direct.mjs"

if (process.platform !== "win32" || process.arch !== "x64") {
  console.log("SKIP: the real-app probe requires an interactive Windows x64 session")
  process.exit(0)
}

const args = process.argv.slice(2)
const allowRunningNotepad = args.includes("--allow-running-notepad")
const inputs = args.filter(arg => arg !== "--allow-running-notepad")
const [driverPath, root = tmpdir()] = inputs
assert(driverPath && inputs.length <= 2 && inputs.every(arg => !arg.startsWith("--")),
  "Usage: node real-apps.mjs <verified cua-driver.exe> [evidence directory] [--allow-running-notepad]")

const executable = resolve(driverPath)
await mkdir(root, { recursive: true })
const directory = await mkdtemp(join(resolve(root), "vykor-cua-real-"))
const nonce = basename(directory).slice("vykor-cua-real-".length)
const sourceFile = join(directory, `seed-${nonce}.txt`)
const savedFolder = join(directory, "saved")
const savedFile = join(savedFolder, `saved-${nonce}.txt`)
const documentText = `Vykor Stage 1 ${nonce}\r\nPrepare the Windows probe\r\nRead back the saved file`
const systemRoot = process.env.SystemRoot ?? "C:\\Windows"
const compiler = join(systemRoot, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe")
const probe = join(directory, "ProbeWindows.exe")

await mkdir(savedFolder)
await writeFile(sourceFile, "", { flag: "wx" })
execFileSync(compiler, [
  "/nologo", "/target:exe", "/platform:x64", "/r:Microsoft.CSharp.dll",
  `/out:${probe}`, fileURLToPath(new URL("../fixtures/ProbeWindows.cs", import.meta.url)),
], { windowsHide: true, stdio: "inherit" })

const log = (kind, evidence) => appendFile(join(directory, "real-apps.jsonl"), JSON.stringify({
  kind, evidence, utc: new Date().toISOString(),
}) + "\n")
function query(...params) {
  const lines = execFileSync(probe, params.map(String), {
    encoding: "utf8", windowsHide: true, timeout: 4_000,
  }).trim()
  return lines ? lines.split(/\r?\n/u) : []
}
function windows(image, { pid = 0, owner = 0, title = "" } = {}) {
  return query("windows", image, pid, owner, title).map(line => {
    const [pid, window_id, owner] = line.split("\t").map(Number)
    return { image, pid, window_id, owner, title }
  })
}
function unique(values, description) {
  assert(values.length <= 1, `Expected one ${description}, found ${values.length}`)
  return values[0]
}
async function until(read, description) {
  const deadline = Date.now() + 8_000
  do {
    const result = await read()
    if (result) return result
    await sleep(180)
  } while (Date.now() < deadline)
  throw new Error(`Timed out waiting for ${description}`)
}
async function launch(file, path) {
  const app = spawn(file, [path], { stdio: "ignore", windowsHide: false, shell: false })
  await new Promise((success, failure) => {
    app.once("spawn", success)
    app.once("error", failure)
  })
  app.unref()
}

function normalize(value) {
  return typeof value === "string" ? value.replace(/\r\n?/gu, "\n") : value
}
function labelMatches(options, label) {
  return typeof label === "string" && options.some(option => option.toLowerCase() === label.toLowerCase())
}
function assertWindow(target) {
  assert(windows(target.image, { pid: target.pid, owner: target.owner, title: target.title }).some(item => item.window_id === target.window_id),
    "The expected Windows identity no longer owns the scoped window")
}
const tools = ["start_session", "end_session", "get_window_state", "click", "set_value", "type_text", "press_key", "bring_to_front"]

async function withWindow(target, work) {
  assertWindow(target)
  const scope = { pid: target.pid, window_id: target.window_id }
  const driver = await connectBoundedDriver({ executable, directory, windows: [scope], tools })
  let sessionOpen = false
  async function call(name, options = {}) {
    const lifecycle = name === "start_session" || name === "end_session"
    if (!lifecycle) assertWindow(target)
    const result = await driver.client.callTool({
      name, arguments: { session: "real-apps", ...options, ...(!lifecycle ? scope : {}) },
    }, undefined, { timeout: 12_000 })
    const body = result.structuredContent
    await log("call", { name, ...scope, route: body?.route, effect: body?.effect, delivery: body?.delivery,
      isError: Boolean(result.isError) })
    assert(!result.isError, result.content?.[0]?.text ?? `Cua failed ${name}`)
    return body
  }
  const observe = async queryText => {
    const state = await call("get_window_state", {
      include_screenshot: false, max_elements: 350, ...(queryText ? { query: queryText } : {}),
    })
    assert.equal(state.window_id, target.window_id)
    return state
  }
  async function find(queries, predicate, description) {
    for (const text of queries) {
      const match = unique((await observe(text)).elements.filter(predicate), description)
      if (match?.element_token) return match
    }
    throw new Error(`Could not identify the expected ${description}`)
  }
  const click = element => call("click", { element_token: element.element_token, delivery_mode: "background" })
  const focus = async () => {
    assert.equal((await call("bring_to_front")).landed_on_target, true, "The owned target did not receive focus")
    assert.equal(Number(query("foreground")[0]), target.window_id, "Windows foreground changed")
  }
  const press = (element, key) => {
    assert.equal(Number(query("foreground")[0]), target.window_id, "Do not send keyboard input to another window")
    return call("press_key", { element_token: element.element_token, key, modifiers: ["ctrl"], delivery_mode: "foreground" })
  }
  try {
    await call("start_session")
    sessionOpen = true
    return await work({ call, observe, find, click, focus, press })
  } finally {
    if (sessionOpen) await call("end_session").catch(() => {})
    await driver.close()
  }
}

const menuFile = ["文件", "File"]
const menuNewWindow = ["新建窗口", "New window"]
const menuSaveAs = ["另存为", "Save As"]
const fileNameQueries = ["文件名", "File name"]
const documentEditor = window => window.find(["文本编辑器", "Text editor"], element => element.role === "Document", "Notepad editor")
function menuItem(window, labels) {
  return window.find(labels, element => element.role === "MenuItem" && labelMatches(labels, element.label),
    labels.at(-1) + " menu item")
}
async function closeSavedTab(window) {
  await withWindow(window, async probeWindow => {
    const current = await probeWindow.observe(basename(savedFile))
    assert(current.window_title.startsWith(basename(savedFile)), "The saved test document is no longer active")
    await probeWindow.focus()
    const editor = await documentEditor(probeWindow)
    assert.equal(normalize(editor.value), normalize(documentText), "The exact test document must still be active")
    await probeWindow.press(editor, "w")
  })
  await until(() => windows("Notepad", { title: basename(savedFile) }).length === 0, "owned saved tab to close")
}

try {
  const previousNotepadProcesses = query("process", "Notepad")
  assert(allowRunningNotepad || previousNotepadProcesses.length === 0,
    "Cold start requires Notepad to be closed. Preserve existing tabs and pass --allow-running-notepad for a warm-only test.")
  assert.equal(windows("Notepad", { title: basename(sourceFile) }).length, 0)
  assert.equal(query("folder", savedFolder).length, 0)
  await launch(join(systemRoot, "System32", "notepad.exe"), sourceFile)
  const seed = await until(() => unique(windows("Notepad", { title: basename(sourceFile) }), "seed Notepad window"), "seed document")
  await log("started", { coldNotepad: previousNotepadProcesses.length === 0, pid: seed.pid, window_id: seed.window_id })
  const existingWindows = new Set(windows("Notepad", { pid: seed.pid }).map(item => item.window_id))
  await withWindow(seed, async window => {
    await window.click(await menuItem(window, menuFile))
    await window.click(await menuItem(window, menuNewWindow))
  })

  const editor = await until(() => unique(windows("Notepad", { pid: seed.pid })
    .filter(item => item.owner === 0 && !existingWindows.has(item.window_id)), "dedicated Notepad window"), "new test window")
  await withWindow(editor, async window => {
    // A fresh, separate blank document is required even when Notepad restored older tabs.
    const initial = await window.observe()
    assert.match(initial.window_title, /^(无标题|未命名|Untitled)(\s+[-–]|$)/iu)
    const field = await documentEditor(window)
    assert(!field.value, "The dedicated editor is not empty")
    await window.call("set_value", { element_token: field.element_token, value: documentText })
    assert.equal(normalize((await documentEditor(window)).value), normalize(documentText))
    await window.click(await menuItem(window, menuFile))
    await window.click(await menuItem(window, menuSaveAs))
  })

  const dialog = await until(() => {
    const candidates = menuSaveAs.flatMap(title => windows("Notepad", { pid: editor.pid, owner: editor.window_id, title }))
    return unique(candidates, "Save As dialog owned by the dedicated editor")
  }, "owned Save As dialog")
  await withWindow(dialog, async window => {
    const filename = () => window.find(fileNameQueries, item => item.role === "Edit", "Save As filename field")
    await window.focus()
    await window.press(await filename(), "a")
    const field = await filename()
    assert.equal(Number(query("foreground")[0]), dialog.window_id, "The owned Save As dialog must stay foreground")
    await window.call("type_text", { element_token: field.element_token, text: savedFile, delivery_mode: "foreground" })
    assert.equal((await filename()).value, savedFile, "Save As did not confirm the exact fixture path")
    const save = await window.find(["保存", "Save"], item =>
      item.role === "Button" && /^(保存|Save)(\s|\(|（|$)/iu.test(item.label), "Save button")
    await window.click(save)
  })

  const expectedBytes = Buffer.from(documentText, "utf8")
  const bytes = await until(async () => {
    try {
      const saved = await readFile(savedFile)
      return saved.length >= expectedBytes.length ? saved : undefined
    } catch (error) {
      if (error.code === "ENOENT") return undefined
      throw error
    }
  }, "independent saved file readback")
  assert.deepEqual(bytes, expectedBytes, "Saved bytes differ from the expected UTF-8 document")
  await log("saved", { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") })
  await until(() => windows("Notepad", { pid: editor.pid, title: basename(savedFile) })
    .some(item => item.window_id === editor.window_id), "saved name to appear on the same Notepad HWND")
  await closeSavedTab(editor)

  await launch(join(systemRoot, "explorer.exe"), savedFolder)
  const explorer = await until(() => {
    const hwnd = unique(query("folder", savedFolder).map(Number), "Explorer window for the exact fixture folder")
    return hwnd && windows("explorer").find(item => item.window_id === hwnd)
  }, "registered Explorer window for the dedicated fixture folder")
  await withWindow(explorer, async window => {
    const fileName = basename(savedFile)
    const stem = parse(fileName).name
    const item = await window.find([stem], candidate => candidate.role === "ListItem" &&
      labelMatches([fileName, stem], candidate.label) && candidate.actions?.includes("invoke"), "saved Explorer file item")
    assert.deepEqual(query("folder", savedFolder).map(Number), [explorer.window_id], "Explorer folder changed before invocation")
    await window.click(item)
  })

  const reopened = await until(() => unique(windows("Notepad", { title: basename(savedFile) }), "reopened saved document"), "Explorer-opened Notepad window")
  await withWindow(reopened, async window => {
    const result = await documentEditor(window)
    assert.equal(normalize(result.value), normalize(documentText), "Reopened editor text differs from the saved fixture")
  })
  await log("pass", { coldNotepad: previousNotepadProcesses.length === 0, reopened, explorer })
  console.log("PASS", previousNotepadProcesses.length ? "warm Notepad → Save As → Explorer → exact byte/UI readback"
    : "cold Notepad → Save As → Explorer → exact byte/UI readback")
} catch (error) {
  await log("failure", { message: error.message })
  console.error(error.message)
  process.exitCode = 1
} finally {
  console.log("Evidence:", directory)
}
