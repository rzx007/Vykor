import assert from "node:assert/strict"
import { readFile, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  OFFICE_ASSETS,
  OFFICE_VERSION,
  hash,
  officeBinaryPath,
  createOfficeRunner,
} from "../../../packages/services/src/office/office-engine.mjs"

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const artifactIndex = process.argv.indexOf("--artifact")
if (artifactIndex >= 0 && !process.argv[artifactIndex + 1])
  throw new Error("Usage: --artifact <application resources directory> [--smoke]")
const resources =
  artifactIndex >= 0 ? resolve(process.argv[artifactIndex + 1]) : join(desktop, "out")
const asset = OFFICE_ASSETS[process.platform + "-" + process.arch]
assert.ok(asset, "unsupported Office platform")
const engine = join(resources, "office-engine", asset[0])
assert.equal(hash(await readFile(engine)), asset[1], "packaged OfficeCLI checksum mismatch")
const license = await readFile(join(resources, "office-engine/OFFICECLI-LICENSE"), "utf8")
assert.equal(
  license,
  await readFile(join(desktop, "../../packages/services/src/office/OFFICECLI-LICENSE"), "utf8"),
  "OfficeCLI license missing or changed"
)
const builder = await readFile(join(desktop, "electron-builder.yml"), "utf8")
assert.match(
  builder,
  /from: out\/office-engine\s+to: office-engine/,
  "builder must copy the Office engine outside asar"
)
if (artifactIndex >= 0) {
  const { extractFile } = await import("@electron/asar")
  const main = extractFile(join(resources, "app.asar"), join("out", "main", "index.js")).toString("utf8")
  assert.ok(
    main.includes("Word 段落解析结果不完整"),
    "application bundle is stale: Word table parsing fix missing"
  )
}
if (process.argv.includes("--smoke")) {
  // Run this script with the unpacked app executable and ELECTRON_RUN_AS_NODE=1.
  assert.equal(
    await officeBinaryPath(),
    engine,
    "runtime must find the installed engine without a path override"
  )
  assert.equal(
    process.env.VYKOR_OFFICECLI_PATH,
    undefined,
    "smoke must not rely on VYKOR_OFFICECLI_PATH"
  )
  const cwd = await mkdtemp(join(tmpdir(), "office-install-smoke-")),
    file = join(cwd, "smoke.docx")
  const run = await createOfficeRunner({
    cwd,
    signal: new AbortController().signal,
    deadline: Date.now() + 55000,
  })
  try {
    assert.ok((await run(["--version"])).includes(OFFICE_VERSION))
    await run(["create", file])
    await run(
      ["batch", file, "--stop-on-error"],
      [
        {
          command: "add",
          parent: "/body",
          type: "paragraph",
          props: { text: "Installed Office smoke" },
        },
        {
          command: "add",
          parent: "/body",
          type: "table",
          props: { data: "项目,负责人;表格验收,周宁" },
        },
      ]
    )
    const result = JSON.parse(await run(["query", file, "paragraph", "--json"]))
    assert.ok(result.success)
    assert.ok(
      result.data.results.some((node) => node.path.includes("/tc[") && node.text === "周宁")
    )
  } finally {
    try {
      await run(["close", file], undefined, true)
    } finally {
      await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }
}
console.log(
  `Office engine binary, license and packaging${artifactIndex >= 0 ? " artifact" : ""}${process.argv.includes("--smoke") ? " runtime smoke" : ""} verified.`
)
