import { expect, it } from "vitest"
import { DesktopOperationGate } from "../operation-gate"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

it("waits for an in-flight Git operation and permits only the final business drain before sealing", async () => {
  const gate = new DesktopOperationGate()
  let finish!: () => void
  let indexRefreshed = false
  const git = gate.run("git:changes", async () => { await new Promise<void>(resolve => { finish = resolve }); indexRefreshed = true })
  let drained = false
  const freeze = gate.freeze().then(() => { drained = true })
  await Promise.resolve()
  expect(drained).toBe(false)
  await expect(gate.run("git:changes", async () => {})).rejects.toThrow(/迁移/)
  let draft = ""
  await gate.run("business-data:write", async () => { draft = "last draft" })
  finish(); await git; await freeze
  await gate.seal()
  expect(indexRefreshed).toBe(true)
  expect(draft).toBe("last draft")
  await expect(gate.run("business-data:write", async () => {})).rejects.toThrow(/迁移/)
})

it("can freeze from its own migration handler without waiting on itself", async () => {
  const gate = new DesktopOperationGate()
  await gate.run("settings:data-root-migrate", async () => {
    await gate.freeze()
    await gate.seal()
  })
  await expect(gate.run("session:create", async () => {})).rejects.toThrow(/迁移/)
})

it("drains a real asynchronous git status that refreshes an owned index", async () => {
  const root = await mkdtemp(join(tmpdir(), "desktop-git-drain-")), execute = promisify(execFile)
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "empty-config") }
  try {
    await writeFile(env.GIT_CONFIG_GLOBAL, "")
    await execute("git", ["init", "-q"], { cwd: root, env, windowsHide: true })
    await writeFile(join(root, "tracked"), "content")
    await execute("git", ["add", "tracked"], { cwd: root, env, windowsHide: true })
    const before = await readFile(join(root, ".git/index"))
    await utimes(join(root, "tracked"), new Date(), new Date(Date.now() + 2000))
    const gate = new DesktopOperationGate(); let release!: () => void
    const status = gate.run("git:changes", async () => {
      await new Promise<void>(resolve => { release = resolve })
      await execute("git", ["status", "--porcelain"], { cwd: root, env, windowsHide: true })
    })
    let stopped = false
    const drain = gate.freeze().then(() => { stopped = true })
    await Promise.resolve(); expect(stopped).toBe(false)
    release(); await status; await drain
    expect(await readFile(join(root, ".git/index"))).not.toEqual(before)
    expect(stopped).toBe(true)
  } finally { await rm(root, { recursive: true, force: true }) }
})
