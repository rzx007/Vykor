import { test } from "node:test";
import assert from "node:assert/strict";
import { chartCommands, chartSpec } from "../tools/excel-charts.mjs";
import {
  structurePlan,
  rewriteFormula,
  mapAddress,
  auditStructure,
} from "../tools/excel-structure.mjs";
import { preserveWorkbook } from "../tools/excel-preservation.mjs";
test("native charts bind real ranges, add axis floor after creation and reject arbitrary passthrough", () => {
  const c = chartSpec({
    type: "column",
    title: "金额",
    dataRange: "'明细'!B1:B4",
    categories: "'明细'!A2:A4",
    anchor: "D2:L18",
  });
  const ops = chartCommands("汇总", c, 1);
  assert.equal(ops[0].type, "chart");
  assert.equal(ops[0].props.dataRange, "'明细'!B1:B4");
  assert.deepEqual(ops[1], {
    command: "set",
    path: "/汇总/chart[1]",
    props: { axismin: "0" },
  });
  assert.throws(() => chartSpec({ ...c, raw: "xml" }));
  assert.throws(() => chartSpec({ ...c, categories: "明细!A2:A2" }));
});
test("whole-band edits protect deletion evidence and rewrite absolute/cross-sheet/range references but not strings", () => {
  const p = structurePlan({
    action: "insert_rows",
    sheet: "明细",
    index: 2,
    count: 1,
  });
  assert.equal(p.operations[0].index, 1);
  assert.equal(mapAddress("B2", p), "B3");
  assert.equal(
    rewriteFormula("SUM('明细'!$B$2:B4)+A1+IF(A1=\"B2\",1,0)", "汇总", p),
    "SUM('明细'!$B$3:B5)+A1+IF(A1=\"B2\",1,0)",
  );
  const d = structurePlan({
    action: "delete_rows",
    sheet: "明细",
    index: 2,
    count: 1,
    expected_cells: [],
  });
  assert.equal(rewriteFormula("SUM(B1:B3)+B2", "明细", d), "SUM(B1:B2)+#REF!");
  assert.throws(() =>
    structurePlan({
      action: "delete_columns",
      sheet: "明细",
      index: 1,
      count: 1,
    }),
  );
});
const W = '<workbook><sheets><sheet name="S" r:id="r1"/></sheets></workbook>',
  R =
    '<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>';
const pkg = (sheet, extra = []) =>
  new Map([
    ["xl/workbook.xml", W],
    ["xl/_rels/workbook.xml.rels", R],
    ["xl/worksheets/sheet1.xml", sheet],
    ...extra,
  ]);
test("complex preservation permits requested cells while protecting merges, validation, tables and drawings", () => {
  const a = pkg(
    '<worksheet><sheetData><row r="1"><c r="A1" t="str"><v>old</v></c></row></sheetData><mergeCells><mergeCell ref="A1:B1"/></mergeCells><dataValidations><dataValidation sqref="C1:C5" type="whole"><formula1>1</formula1></dataValidation></dataValidations></worksheet>',
    [
      ["xl/tables/table1.xml", '<table ref="A1:D5"/>'],
      ["xl/drawings/drawing1.xml", "<drawing/>"],
    ],
  );
  const b = new Map(a);
  b.set(
    "xl/worksheets/sheet1.xml",
    a.get("xl/worksheets/sheet1.xml").replace("old", "new"),
  );
  assert.equal(preserveWorkbook(a, b, { cells: ["/S/A1"] }).preserved, true);
  b.set("xl/tables/table1.xml", '<table ref="A1:D6"/>');
  assert.throws(
    () => preserveWorkbook(a, b, { cells: ["/S/A1"] }),
    /保留|范围/,
  );
});
import { verifyChart } from "../tools/excel-charts.mjs";
import { workbookSupport } from "../tools/excel-preservation.mjs";
import { checkDeletionEvidence } from "../tools/excel-structure.mjs";
import { parseXml, canonicalXml } from "../tools/excel-xml.mjs";
function chartPackage() {
  const parts = pkg(
    '<worksheet xmlns:r="rel"><sheetData><row r="1"><c r="A1" t="str"><v>name</v></c><c r="B1" t="str"><v>amount</v></c></row><row r="2"><c r="A2" t="str"><v>a</v></c><c r="B2"><v>2</v></c></row><row r="3"><c r="A3" t="str"><v>b</v></c><c r="B3"><v>3</v></c></row></sheetData><drawing r:id="d1"/></worksheet>',
  );
  parts.set(
    "xl/worksheets/_rels/sheet1.xml.rels",
    '<Relationships><Relationship Id="d1" Target="../drawings/drawing1.xml"/></Relationships>',
  );
  parts.set(
    "xl/drawings/drawing1.xml",
    '<wsDr xmlns:r="rel"><twoCellAnchor><from><col>3</col><row>1</row></from><to><col>11</col><row>17</row></to><graphicFrame><chart r:id="c1"/></graphicFrame></twoCellAnchor></wsDr>',
  );
  parts.set(
    "xl/drawings/_rels/drawing1.xml.rels",
    '<Relationships><Relationship Id="c1" Target="../charts/chart1.xml"/></Relationships>',
  );
  parts.set(
    "xl/charts/chart1.xml",
    '<chartSpace><chart><title><tx>Amount</tx></title><plotArea><barChart><barDir val="col"/><ser><cat><strRef><f>S!A2:A3</f><strCache><pt idx="0"><v>a</v></pt></strCache></strRef></cat><val><numRef><f>S!B2:B3</f><numCache><pt idx="0"><v>2</v></pt></numCache></numRef></val></ser></barChart><valAx><scaling><min val="0"/></scaling></valAx></plotArea></chart></chartSpace>',
  );
  return parts;
}
test("native chart verification checks type, real bindings, series count, zero axis and anchor", () => {
  const parts = chartPackage(),
    spec = chartSpec({
      type: "column",
      title: "Amount",
      dataRange: "S!B1:B3",
      categories: "S!A2:A3",
      anchor: "D2:L18",
    });
  assert.equal(verifyChart(parts, "S", 1, spec).native_editable, true);
  assert.throws(
    () => verifyChart(parts, "S", 1, { ...spec, dataRange: "S!C1:C3" }),
    /绑定/,
  );
  assert.throws(
    () => verifyChart(parts, "S", 1, { ...spec, anchor: "E2:L18" }),
    /位置/,
  );
});
test("editing chart data preserves graph bindings while allowing derived chart caches to change", () => {
  const a = chartPackage(),
    b = new Map(a);
  b.set(
    "xl/worksheets/sheet1.xml",
    b.get("xl/worksheets/sheet1.xml").replace("<v>2</v>", "<v>4</v>"),
  );
  b.set(
    "xl/charts/chart1.xml",
    b.get("xl/charts/chart1.xml").replace("<v>2</v>", "<v>4</v>"),
  );
  assert.equal(preserveWorkbook(a, b, { cells: ["/S/B2"] }).preserved, true);
  b.set(
    "xl/charts/chart1.xml",
    b.get("xl/charts/chart1.xml").replace("S!B2:B3", "S!C2:C3"),
  );
  assert.throws(() => preserveWorkbook(a, b, { cells: ["/S/B2"] }), /保留/);
});
test("complex scope rejects non-anchor merge edits and structural rewrites of complex objects", () => {
  const parts = pkg(
    '<worksheet><sheetData/><mergeCells><mergeCell ref="A1:C2"/></mergeCells></worksheet>',
  );
  assert.throws(() => workbookSupport(parts, { cells: ["/S/B1"] }), /左上角/);
  assert.throws(
    () => workbookSupport(parts, { structural: true }),
    /普通工作簿/,
  );
  assert.equal(
    workbookSupport(parts, { cells: ["/S/A1"] }).mode,
    "preserve_existing_objects",
  );
});
const cell = (path, text, formula) => ({
    type: "cell",
    path,
    text,
    format: formula ? { formula } : { type: "Number" },
    children: [],
    childCount: 0,
  }),
  tree = (cells) => ({
    type: "workbook",
    children: [{ path: "/S", type: "sheet", children: cells }],
  });
test("row/column audit verifies deletion before commands and rejects reference or scope mistakes", () => {
  const p = structurePlan({
      action: "delete_rows",
      sheet: "S",
      index: 2,
      count: 1,
      expected_cells: [{ path: "/S/A2", expected_text: "2" }],
    }),
    before = tree([cell("/S/A1", "1"), cell("/S/A2", "2"), cell("/S/A3", "3")]),
    after = tree([cell("/S/A1", "1"), cell("/S/A2", "3")]);
  checkDeletionEvidence(before, p);
  assert.equal(auditStructure(before, after, p).deleted_cells.length, 1);
  assert.throws(
    () => checkDeletionEvidence(before, { ...p, expected_cells: [] }),
    /证据/,
  );
  assert.throws(
    () =>
      auditStructure(
        before,
        tree([cell("/S/A1", "99"), cell("/S/A2", "3")]),
        p,
      ),
    /核对失败/,
  );
});
test("XML preservation is namespace-aware and rejects entity declarations", () => {
  assert.equal(
    canonicalXml(parseXml('<a:x xmlns:a="urn:test" k="1"/>')),
    canonicalXml(parseXml('<b:x k="1" xmlns:b="urn:test"></b:x>')),
  );
  assert.throws(() => parseXml('<!DOCTYPE x [<!ENTITY q "secret">]><x/>'));
  assert.notEqual(
    canonicalXml(parseXml('<x xmlns="one"/>')),
    canonicalXml(parseXml('<x xmlns="two"/>')),
  );
});
test("whole-band formulas support full columns/rows and do not rewrite quoted literals", () => {
  const r = structurePlan({
      action: "insert_rows",
      sheet: "S",
      index: 2,
      count: 1,
    }),
    c = structurePlan({
      action: "delete_columns",
      sheet: "S",
      index: 2,
      count: 1,
      expected_cells: [],
    });
  assert.equal(rewriteFormula('SUM(1:3)+"A:A"', "S", r), 'SUM(1:4)+"A:A"');
  assert.equal(
    rewriteFormula("SUM(B:D)+'S'!$B$1", "S", c),
    "SUM(B:C)+'S'!#REF!",
  );
  assert.equal(
    rewriteFormula('IF(A1="[literal]",1,0)', "S", r),
    'IF(A1="[literal]",1,0)',
  );
});
test("adding a graph preserves the old graph and unrelated drawing anchors", () => {
  const a = chartPackage(),
    b = new Map(a);
  b.set(
    "xl/drawings/drawing1.xml",
    b
      .get("xl/drawings/drawing1.xml")
      .replace(
        "</wsDr>",
        '<twoCellAnchor><from><col>3</col><row>20</row></from><to><col>11</col><row>35</row></to><graphicFrame><chart r:id="c2"/></graphicFrame></twoCellAnchor></wsDr>',
      ),
  );
  b.set(
    "xl/drawings/_rels/drawing1.xml.rels",
    b
      .get("xl/drawings/_rels/drawing1.xml.rels")
      .replace(
        "</Relationships>",
        '<Relationship Id="c2" Target="../charts/chart2.xml"/></Relationships>',
      ),
  );
  b.set(
    "xl/charts/chart2.xml",
    b.get("xl/charts/chart1.xml").replace("Amount", "Second"),
  );
  assert.equal(
    preserveWorkbook(a, b, {
      charts: [{ action: "add_chart", sheet: "S", index: 2 }],
    }).preserved,
    true,
  );
  b.set(
    "xl/drawings/drawing1.xml",
    b.get("xl/drawings/drawing1.xml").replace("<col>3</col>", "<col>4</col>"),
  );
  assert.throws(
    () =>
      preserveWorkbook(a, b, {
        charts: [{ action: "add_chart", sheet: "S", index: 2 }],
      }),
    /保留/,
  );
});
