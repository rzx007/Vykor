import { copyFile, readFile, rename, link } from "node:fs/promises";
import { resolve } from "node:path";
import { engine, hash } from "./engine.mjs";
import {
  filePath,
  exists,
  known,
  receipt,
  currentReceipt,
} from "./document-files.mjs";
import {
  withFiles,
  assertFileAvailable,
  operationError,
} from "./file-access.mjs";
import { withWorkingFile } from "./working-file.mjs";
import {
  only,
  excelTarget,
  buildWorkbook,
  cellProps,
  cellsOf,
  verifyCellFormats,
  auditChanges,
  formulaReport,
} from "./excel-content.mjs";
import {
  workbookParts,
  simpleWorkbook,
  verifyWrittenCells,
} from "./excel-package.mjs";
import {
  previewExcel,
  recordExcelReview,
  excelVisualReview,
} from "./excel-visual.mjs";
async function get(run, file, target = "/", depth = 3) {
  const r = JSON.parse(
    await run(["get", file, target, "--depth", String(depth), "--json"]),
  );
  if (r.success !== true || r.data?.results?.length !== 1)
    throw new Error("未找到唯一工作表或单元格区域。");
  return r.data.results[0];
}
async function check(run, file) {
  const validation = JSON.parse(await run(["validate", file, "--json"]));
  if (validation.success !== true)
    throw new Error("Excel 结构验证失败，未保存。");
  const issues = JSON.parse(await run(["view", file, "issues", "--json"]));
  if (issues.success !== true) throw new Error("Excel 问题扫描未完成。");
  return { validation, issues };
}
function editOps(input) {
  if (
    !/^[a-f0-9]{64}$/.test(input.expected_sha256 ?? "") ||
    !Array.isArray(input.operations) ||
    !input.operations.length ||
    input.operations.length > 100
  )
    throw new Error("修改须提供最新摘要和 1–100 项单元格操作。");
  const seen = new Set();
  return input.operations.map((o) => {
    only(o, ["path", "props"]);
    excelTarget(o.path);
    if (!/^\/[^/]+\/[A-Z]+\d+$/.test(o.path) || seen.has(o.path))
      throw new Error("修改仅支持不同的单个单元格路径。");
    seen.add(o.path);
    return { command: "set", path: o.path, props: cellProps(o.props) };
  });
}
async function execute(kind, input, context) {
  const writing = ["Create", "Edit", "Preview", "Review"].includes(kind);
  if (
    !context.permissions.filesystem?.includes("read") ||
    (writing && !context.permissions.filesystem?.includes("write")) ||
    !context.permissions.process?.includes("officecli")
  )
    throw new Error("插件缺少文件或 OfficeCLI 权限。");
  const source = await filePath(
    context,
    input.path,
    kind === "Create",
    ".xlsx",
  );
  if (kind === "Preview") return previewExcel(source, input, context);
  if (kind === "Review") return recordExcelReview(source, input, context);
  const ops =
    kind === "Create"
      ? buildWorkbook(input)
      : kind === "Edit"
        ? editOps(input)
        : undefined;
  const selected = kind === "Read" ? excelTarget(input.target, true) : "/";
  const inPlace =
    kind === "Edit" &&
    (await known(context, source)) &&
    (!input.output_path || resolve(context.cwd, input.output_path) === source);
  const destination =
    kind !== "Edit" || inPlace
      ? source
      : await filePath(
          context,
          input.output_path ?? source.replace(/\.xlsx$/i, "-edited.xlsx"),
          true,
          ".xlsx",
        );
  return withFiles([source, destination], context, async () => {
    await assertFileAvailable(source);
    await assertFileAvailable(destination);
    if (
      ["Create", "Edit"].includes(kind) &&
      !inPlace &&
      (await exists(destination))
    )
      throw new Error("输出文件已存在，不能覆盖。");
    const before = kind === "Create" ? undefined : hash(await readFile(source));
    if (kind === "Edit" && before !== input.expected_sha256)
      throw new Error("文件版本已变化，请重新读取。");
    if (kind === "Edit") simpleWorkbook(workbookParts(await readFile(source)));
    const run = await engine({ ...context, maxOutputBytes: 2000000 });
    return withWorkingFile(destination, run, context, async (work, close) => {
      if (kind === "Create") await run(["create", work]);
      else await copyFile(source, work);
      if (kind === "Read" || kind === "Check") {
        const document = await get(
          run,
          work,
          selected,
          kind === "Read" && selected === "/" ? 1 : 3,
        );
        const checks = kind === "Check" ? await check(run, work) : undefined;
        const formulas =
          selected === "/" && kind === "Read"
            ? undefined
            : formulaReport(document);
        if (hash(await readFile(source)) !== before)
          throw new Error("读取期间文件已变化。");
        const prior =
            kind === "Check"
              ? await currentReceipt(context, source, before)
              : undefined,
          visual =
            kind === "Check"
              ? await excelVisualReview(source, before, context)
              : undefined;
        return {
          path: source,
          sha256: before,
          document,
          ...(formulas ? { formula_check: formulas } : {}),
          ...(checks
            ? { ...checks, structure_checked: true, visual_checked: false }
            : {}),
          ...(prior?.change_check ? { change_check: prior.change_check } : {}),
          ...(visual ? { visual_review: visual } : {}),
        };
      }
      let baseline;
      if (kind === "Edit") baseline = await get(run, work);
      await run(["batch", work, "--stop-on-error"], ops);
      const after = await get(run, work);
      cellsOf(after);
      verifyCellFormats(after, ops);
      const change = baseline
        ? auditChanges(
            baseline,
            after,
            ops.map((o) => o.path),
          )
        : undefined;
      const formula_check = formulaReport(after);
      const checks = await check(run, work);
      await close();
      verifyWrittenCells(workbookParts(await readFile(work)), ops);
      if (context.signal.aborted || Date.now() >= context.deadline - 1000)
        throw new Error("操作取消或到期，未保存目标文件。");
      await assertFileAvailable(source);
      await assertFileAvailable(destination);
      if (kind === "Edit" && hash(await readFile(source)) !== before)
        throw new Error("修改期间源文件变化，未发布副本。");
      const sha = hash(await readFile(work));
      if (inPlace) await rename(work, destination);
      else await link(work, destination);
      return receipt(context, destination, sha, {
        ...checks,
        formula_check,
        ...(change
          ? { change_check: { ...change, source_sha256: before, sha256: sha } }
          : {}),
      });
    });
  });
}
export function registerExcelTools() {
  const str = { type: "string" },
    cell = {
      type: "object",
      additionalProperties: false,
      properties: {
        value: { type: ["string", "number"] },
        formula: str,
        format: str,
        bold: { type: "boolean" },
        fill: str,
        color: str,
        wrap: { type: "boolean" },
        align: { type: "string", enum: ["left", "center", "right"] },
      },
    };
  const schemas = {
    Create: {
      path: str,
      sheets: {
        type: "array",
        minItems: 1,
        maxItems: 8,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "rows"],
          properties: {
            name: str,
            rows: {
              type: "array",
              minItems: 1,
              maxItems: 200,
              items: {
                type: "array",
                maxItems: 26,
                items: {
                  anyOf: [{ type: ["string", "number", "null"] }, cell],
                },
              },
            },
            columns: {
              type: "array",
              maxItems: 26,
              items: { type: "number", minimum: 5, maximum: 80 },
            },
            freeze: str,
            filter: str,
          },
        },
      },
    },
    Read: { path: str, target: str },
    Edit: {
      path: str,
      output_path: str,
      expected_sha256: str,
      operations: {
        type: "array",
        minItems: 1,
        maxItems: 100,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["path", "props"],
          properties: { path: str, props: cell },
        },
      },
    },
    Check: { path: str },
    Preview: { path: str, sheet: str, range: str },
    Review: {
      path: str,
      expected_sha256: str,
      regions: {
        type: "array",
        minItems: 1,
        maxItems: 30,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["preview_id", "conclusion", "findings"],
          properties: {
            preview_id: str,
            conclusion: { type: "string", enum: ["passed", "issues"] },
            findings: { type: "string", minLength: 1, maxLength: 6000 },
          },
        },
      },
    },
  };
  const descriptions = {
    Create:
      "创建多工作表 XLSX 常用报表，支持文字、数字、显式公式、数字格式、表头、列宽、冻结和筛选；不覆盖已有文件。字符串保持文本类型，编号不丢前导零。",
    Read: "读取工作表列表或实际 /工作表/A1:B10 区域，返回最新 sha256、类型、公式、缓存值及计算预测；默认 / 只列工作表。",
    Edit: "按最新 expected_sha256 修改明确单元格的值、公式或基础格式。用户文件另存，插件成果可原位修改；回读核对范围外内容与公式，原生 Excel 重算仍需验收。不插删行列或编辑复杂工作簿。",
    Check:
      "检查 Excel 结构、问题及公式，分别报告缓存、预测、无法计算和错误单元格；不把 evaluated=true 或缓存当作已完成 Excel 重算。",
    Preview:
      "生成指定工作表矩形区域 PNG，最多 12 列40行，供模型实际看图；HTML 截图不等于 Excel/WPS 显示或打印页，不自动通过。",
    Review:
      "保存实际看图后的区域发现，绑定文件版本、工作表、范围和图片摘要；每轮独立快照，仅汇总已检查区域，不代表全工作簿。",
  };
  return Object.keys(schemas).map((kind) => ({
    name: "OfficeExcel" + kind,
    description: descriptions[kind],
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: schemas[kind],
      required:
        kind === "Create"
          ? ["path", "sheets"]
          : kind === "Edit"
            ? ["path", "expected_sha256", "operations"]
            : kind === "Preview"
              ? ["path", "sheet", "range"]
              : kind === "Review"
                ? ["path", "expected_sha256", "regions"]
                : ["path"],
    },
    invoke: async (input, context) => {
      try {
        only(input, Object.keys(schemas[kind]));
        const result = await execute(kind, input, context);
        return {
          content: [
            { type: "text", text: JSON.stringify(result) },
            ...(kind === "Preview"
              ? [
                  {
                    type: "image",
                    source: {
                      type: "file",
                      mediaType: "image/png",
                      path: result.image_path,
                      sizeBytes: result.image_bytes,
                    },
                  },
                ]
              : []),
          ],
          executionState: "completed",
        };
      } catch (e) {
        return {
          content: [{ type: "text", text: JSON.stringify(operationError(e)) }],
          isError: true,
          failureKind: "precondition",
        };
      }
    },
  }));
}
