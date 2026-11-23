import { EventEmitter } from "node:events"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createWindowsApps } from "../windows-apps"

const mocks = vi.hoisted(() => ({
  shell: vi.fn(),
  launch: vi.fn(),
  realpath: vi.fn(),
  stat: vi.fn(),
}))

vi.mock("node:child_process", () => ({ execFile: mocks.shell, spawn: mocks.launch }))
vi.mock("node:fs/promises", () => ({ realpath: mocks.realpath, stat: mocks.stat }))

const classic = "C:\\Registered\\Example.exe"
const signal = new AbortController().signal
const catalog = [
  { name: "Example", registration: "com.example.desktop", target: classic },
  { name: "Example Viewer", registration: "com.example.viewer", target: "C:\\Registered\\Viewer.exe" },
  { name: "画图", registration: "Microsoft.Paint_8wekyb3d8bbwe!App", target: "" },
]
const stats = (modified: bigint) => ({
  ino: 1n, birthtimeNs: 2n, mtimeNs: modified, size: 4n, isFile: () => true,
})

function mockShell(windows: Record<string, unknown> = { desktopAvailable: true, windows: [] }) {
  mocks.shell.mockImplementation((_file, args: string[], _options, finish) => {
    const script = args.at(-1)!
    const stdout = script.includes("$catalog =") ? JSON.stringify(catalog) : JSON.stringify(windows)
    finish(null, { stdout })
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  mockShell()
  mocks.realpath.mockImplementation(value => value)
  mocks.stat.mockResolvedValue(stats(3n))
  mocks.launch.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { unref: () => {} })
    queueMicrotask(() => child.emit("spawn"))
    return child
  })
})

describe("Windows application identity", () => {
  it("prefers exact registered names and resolves packaged aliases without forwarding the query", async () => {
    const native = createWindowsApps()
    expect((await native.discover("Example", signal)).map(app => app.name)).toEqual(["Example"])
    expect((await native.discover("MS Paint", signal)).map(app => app.name)).toEqual(["画图"])
    expect(await native.discover("C:\\unregistered.exe", signal)).toEqual([])
    expect(mocks.shell.mock.calls.every(([, , options]) =>
      !Object.values(options.env).includes("C:\\unregistered.exe"))).toBe(true)
  })

  it("launches only the resolved executable with fixed arguments and denies a fabricated app reference", async () => {
    const native = createWindowsApps()
    const [app] = await native.discover("Example", signal)
    await expect(native.launch({ ...app! }, signal)).rejects.toMatchObject({ reason: "app_changed" })
    await native.launch(app!, signal)
    expect(mocks.launch).toHaveBeenCalledExactlyOnceWith(classic, [], expect.objectContaining({ shell: false }))
  })

  it("rejects approval bound to an executable replaced before window reuse", async () => {
    const native = createWindowsApps()
    const [app] = await native.discover("Example", signal)
    mocks.stat.mockResolvedValue(stats(5n))
    await expect(native.windows(app!, signal)).rejects.toMatchObject({ reason: "app_changed" })
    expect(mocks.shell).toHaveBeenCalledOnce()
    await expect(native.launch(app!, signal)).rejects.toMatchObject({ reason: "app_changed" })
    expect(mocks.launch).not.toHaveBeenCalled()
  })

  it("distinguishes an empty inventory from a matching window Windows restricts", async () => {
    const native = createWindowsApps()
    const [app] = await native.discover("Example", signal)
    expect(await native.windows(app!, signal)).toEqual([])
    mockShell({ windows: [], restricted: true, desktopAvailable: true })
    await expect(native.windows(app!, signal)).rejects.toMatchObject({ reason: "window_restricted" })
  })
})
