import {
  copyFile,
  mkdir,
  readFile,
  writeFile,
  rename,
  rm,
} from "node:fs/promises";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { hash, engine } from "./engine.mjs";
import { withFiles, assertFileAvailable } from "./file-access.mjs";
import { withWorkingFile } from "./working-file.mjs";
import { excelTarget, sheetName, only } from "./excel-content.mjs";
const reviewPath = (source, sha, context) =>
  join(
    context.plugin.dataDir,
    "spreadsheet-reviews",
    `${hash(source.toLowerCase())}-${sha}.latest.json`,
  );
export async function excelVisualReview(source, sha, context) {
  try {
    const r = JSON.parse(
      await readFile(reviewPath(source, sha, context), "utf8"),
    );
    return r.path === source && r.sha256 === sha ? r : undefined;
  } catch (e) {
    if (e.code === "ENOENT") return undefined;
    throw e;
  }
}
const ready = (context) => {
  if (context.signal.aborted || Date.now() >= context.deadline - 1000)
    throw new Error("保存截图或检查记录已取消／到期。");
};
export async function previewExcel(source, input, context) {
  sheetName(input.sheet);
  const target = excelTarget(`/${input.sheet}/${input.range}`);
  if (!/\/[A-Z]+\d+(?::[A-Z]+\d+)?$/.test(target))
    throw new Error("截图须指定 A1 单元格或矩形区域。");
  const m = input.range.match(/^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/),
    col = (s) => [...s].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
  if (
    col(m[3] ?? m[1]) - col(m[1]) + 1 > 12 ||
    Number(m[4] ?? m[2]) - Number(m[2]) + 1 > 40
  )
    throw new Error("截图范围最多 12 列、40 行，请缩小范围。");
  return withFiles([source], context, async () => {
    await assertFileAvailable(source);
    const sha = hash(await readFile(source)),
      run = await engine({ ...context, commandTimeoutMs: 45000 });
    return withWorkingFile(source, run, context, async (work, close) => {
      await copyFile(source, work);
      const doc = JSON.parse(await run(["get", work, target, "--json"]));
      if (doc.success !== true || doc.data?.results?.length !== 1)
        throw new Error("截图工作表或区域不存在。");
      const output = join(dirname(work), "region.png");
      await run([
        "view",
        work,
        "screenshot",
        "--render",
        "html",
        "--range",
        `${input.sheet}!${input.range}`,
        "--screenshot-width",
        "1400",
        "--screenshot-height",
        "1000",
        "-o",
        output,
      ]);
      await close();
      const bytes = await readFile(output);
      if (
        bytes.length < 24 ||
        bytes.length > 8 * 1024 * 1024 ||
        !bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) ||
        bytes.readUInt32BE(16) > 5000 ||
        bytes.readUInt32BE(20) > 10000
      )
        throw new Error("未生成有效且大小适当的区域 PNG。");
      if (hash(await readFile(source)) !== sha)
        throw new Error("截图期间文件版本变化，请重新截图。");
      ready(context);
      const id = randomUUID(),
        dir = join(context.plugin.dataDir, "spreadsheet-previews"),
        imagePath = join(dir, `${id}.png`);
      await mkdir(dir, { recursive: true });
      const result = {
        path: source,
        sha256: sha,
        sheet: input.sheet,
        range: input.range,
        preview_id: id,
        image_path: imagePath,
        image_sha256: hash(bytes),
        image_bytes: bytes.length,
        renderer: "officecli-html",
        capture_method: "xlsx-region-v1",
        rendered: true,
        visual_checked: false,
        source_unchanged: true,
      };
      await writeFile(imagePath, bytes, { flag: "wx" });
      await writeFile(join(dir, id + ".json"), JSON.stringify(result), {
        flag: "wx",
      });
      return result;
    });
  });
}
export async function recordExcelReview(source, input, context) {
  if (
    !/^[a-f0-9]{64}$/.test(input.expected_sha256 ?? "") ||
    !Array.isArray(input.regions) ||
    !input.regions.length ||
    input.regions.length > 30
  )
    throw new Error("须提供截图版本摘要及 1–30 项区域检查。");
  return withFiles([source], context, async () => {
    await assertFileAvailable(source);
    const sha = input.expected_sha256,
      current = async () => {
        if (hash(await readFile(source)) !== sha)
          throw new Error("文件版本变化，请重新截图检查。");
      };
    await current();
    const previous = await excelVisualReview(source, sha, context),
      regions = new Map(
        (previous?.regions ?? []).map((r) => [r.sheet + "!" + r.range, r]),
      ),
      seen = new Set();
    for (const item of input.regions) {
      only(item, ["preview_id", "conclusion", "findings"]);
      if (
        !/^[a-f0-9-]{36}$/.test(item.preview_id ?? "") ||
        !["passed", "issues"].includes(item.conclusion) ||
        typeof item.findings !== "string" ||
        !item.findings.trim() ||
        item.findings.length > 6000
      )
        throw new Error("须提供截图编号、passed/issues 和具体观察。");
      const dir = join(context.plugin.dataDir, "spreadsheet-previews"),
        p = JSON.parse(
          await readFile(join(dir, item.preview_id + ".json"), "utf8"),
        );
      if (
        p.preview_id !== item.preview_id ||
        p.path !== source ||
        p.sha256 !== sha ||
        p.capture_method !== "xlsx-region-v1" ||
        hash(await readFile(join(dir, item.preview_id + ".png"))) !==
          p.image_sha256
      )
        throw new Error("截图不属于当前文件版本或内容已变化。");
      const key = p.sheet + "!" + p.range;
      if (seen.has(key)) throw new Error("同一区域不能重复提交。");
      seen.add(key);
      regions.set(key, {
        sheet: p.sheet,
        range: p.range,
        preview_id: p.preview_id,
        image_sha256: p.image_sha256,
        conclusion: item.conclusion,
        findings: item.findings.trim(),
        checked_at: new Date().toISOString(),
      });
    }
    const record = {
      path: source,
      sha256: sha,
      renderer: "officecli-html",
      review_source: "model_reported",
      scope: "checked_regions_only",
      regions: [...regions.values()],
      conclusion: [...regions.values()].some((r) => r.conclusion === "issues")
        ? "issues"
        : "passed_for_checked_regions",
      updated_at: new Date().toISOString(),
    };
    await current();
    ready(context);
    const latest = reviewPath(source, sha, context),
      snapshot = latest.replace(".latest.json", `-${randomUUID()}.json`),
      tmp = snapshot + ".tmp";
    await mkdir(dirname(latest), { recursive: true });
    const bytes = JSON.stringify(record);
    await writeFile(snapshot, bytes, { flag: "wx" });
    try {
      await writeFile(tmp, bytes, { flag: "wx" });
      await rename(tmp, latest);
    } finally {
      await rm(tmp, { force: true });
    }
    return { recorded: true, record_path: snapshot, visual_review: record };
  });
}
