import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildWorkbook,
  cellProps,
  excelTarget,
  auditChanges,
  formulaReport,
} from "../tools/excel-content.mjs";
test("Excel keeps text identifiers and formats, uses set for column widths and creates sheets before formulas", () => {
  const ops = buildWorkbook({
    sheets: [
      {
        name: "汇总",
        rows: [[{ formula: "SUM('明细'!B2:B3)" }]],
        columns: [18],
      },
      {
        name: "明细",
        rows: [
          ["编号", "金额"],
          ["00123", 100],
          ["=literal", 50],
        ],
      },
    ],
  });
  assert.equal(ops.find((o) => o.path === "/明细/A2").props.type, "string");
  assert.equal(ops.find((o) => o.path === "/明细/A3").props.value, "=literal");
  assert.ok(ops.some((o) => o.path === "/汇总/col[A]" && o.command === "set"));
  assert.equal(
    ops.some((o) => o.type === "column"),
    false,
  );
  assert.ok(
    ops.findIndex((o) => o.type === "sheet") <
      ops.findIndex((o) => o.props?.formula),
  );
  assert.throws(() => cellProps({ formula: "[other.xlsx]Sheet1!A1" }));
  assert.throws(() => cellProps({ value: 1, formula: "1+1" }));
  assert.throws(() =>
    buildWorkbook({
      sheets: [
        { name: "a", rows: [[1]] },
        { name: "A", rows: [[2]] },
      ],
    }),
  );
  assert.throws(() => excelTarget("/Sheet1/A1:XFD1048576"));
  assert.throws(() => excelTarget("/Sheet1/cell[A1]"));
});
const cell = (path, text, format = {}) => ({
  type: "cell",
  path,
  text,
  format,
  children: [],
});
const tree = (cells) => ({
  type: "workbook",
  path: "/",
  format: {},
  childCount: 1,
  children: [
    {
      type: "sheet",
      path: "/S",
      format: {},
      childCount: 1,
      children: [
        {
          type: "row",
          path: "/S/row[1]",
          format: {},
          childCount: cells.length,
          children: cells,
        },
      ],
    },
  ],
});
test("Excel audit allows dependent formula results, rejects unrelated values/formulas and reports stale caches", () => {
  const a = tree([
    cell("/S/A1", "1", { type: "Number" }),
    cell("/S/B1", "2", {
      formula: "A1*2",
      cachedValue: "2",
      computedValue: "2",
      type: "Number",
    }),
  ]);
  const b = tree([
    cell("/S/A1", "3", { type: "Number" }),
    cell("/S/B1", "2", {
      formula: "A1*2",
      cachedValue: "2",
      computedValue: "6",
      type: "Number",
    }),
  ]);
  assert.deepEqual(auditChanges(a, b, ["/S/A1"]).changed_cells, ["/S/A1"]);
  assert.equal(formulaReport(b).stale_cache_cells[0].path, "/S/B1");
  b.children[0].children[0].children[1].format.formula = "A1*3";
  assert.throws(() => auditChanges(a, b, ["/S/A1"]), /范围/);
  const unknown = tree([
    cell("/S/A1", "old", {
      formula: "UNSUPPORTED(1)",
      cachedValue: "old",
      evaluated: true,
    }),
  ]);
  assert.equal(formulaReport(unknown).unverified_cells.length, 1);
});
import {
  workbookParts,
  simpleWorkbook,
  verifyWrittenCells,
} from "../tools/excel-package.mjs";
import { verifyCellFormats } from "../tools/excel-content.mjs";
test("Excel raw readback distinguishes text identifiers, formula content and unsupported structures", () => {
  assert.throws(() => workbookParts(Buffer.alloc(40)), /文件包/);
  assert.throws(
    () => simpleWorkbook(new Map([["xl/tables/table1.xml", ""]])),
    /复杂/,
  );
  const parts = new Map([
    [
      "xl/workbook.xml",
      '<workbook><sheets><sheet name="明细" r:id="r1"/></sheets></workbook>',
    ],
    [
      "xl/_rels/workbook.xml.rels",
      '<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>',
    ],
    [
      "xl/worksheets/sheet1.xml",
      '<worksheet><c r="A1" t="inlineStr"><is><t>00123</t></is></c><c r="B1"><f>SUM(B2:B3)</f><v>150</v></c></worksheet>',
    ],
  ]);
  assert.equal(
    verifyWrittenCells(parts, [
      {
        command: "set",
        path: "/明细/A1",
        props: { value: "00123", type: "string" },
      },
      { command: "set", path: "/明细/B1", props: { formula: "SUM(B2:B3)" } },
    ]).written_cells_verified,
    true,
  );
  assert.throws(
    () =>
      verifyWrittenCells(parts, [
        {
          command: "set",
          path: "/明细/A1",
          props: { value: "00124", type: "string" },
        },
      ]),
    /核对失败/,
  );
  assert.throws(
    () =>
      verifyWrittenCells(parts, [
        { command: "set", path: "/明细/B1", props: { formula: "SUM(B2:B4)" } },
      ]),
    /核对失败/,
  );
  const t = tree([cell("/S/A1", "1", { "font.bold": true })]);
  assert.throws(
    () => verifyCellFormats(t, [{ path: "/S/A1", props: { bold: "false" } }]),
    /格式/,
  );
  assert.throws(
    () => auditChanges({ ...t, childCount: 2 }, t, ["/S/A1"]),
    /不完整/,
  );
  const report = formulaReport(
    tree([
      cell("/S/A1", "#DIV/0!", {
        formula: "1/0",
        computedValue: "#DIV/0!",
        type: "Error",
      }),
    ]),
  );
  assert.ok(report.error_cells.length);
  assert.equal(report.evaluator_all_computed, false);
});
