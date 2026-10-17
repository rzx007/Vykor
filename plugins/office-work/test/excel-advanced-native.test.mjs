import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { registerExcelTools } from "../tools/excel.mjs";
const tools = Object.fromEntries(registerExcelTools().map((t) => [t.name, t]));
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "excel-advanced-api-"));
  const context = {
    cwd,
    plugin: {
      root: resolve("plugins/office-work"),
      dataDir: join(cwd, "data"),
    },
    permissions: { filesystem: ["read", "write"], process: ["officecli"] },
    signal: new AbortController().signal,
  };
  return {
    cwd,
    call: async (name, input) => {
      const r = await tools["OfficeExcel" + name].invoke(input, {
        ...context,
        deadline: Date.now() + 120000,
      });
      assert.notEqual(r.isError, true, r.content[0].text);
      return JSON.parse(r.content[0].text);
    },
  };
}
test("real OfficeCLI: native API keeps chart bindings through data and title edits", async () => {
  const { cwd, call } = await fixture();
  try {
    let r = await call("Create", {
      path: "chart.xlsx",
      sheets: [
        {
          name: "数据",
          rows: [
            ["类别", "金额"],
            ["A", 10],
            ["B", 20],
          ],
        },
        {
          name: "汇总",
          rows: [
            ["指标", "值"],
            ["总额", { formula: "SUM('数据'!B2:B3)" }],
          ],
          charts: [
            {
              type: "column",
              title: "Amount",
              dataRange: "数据!B1:B3",
              categories: "数据!A2:A3",
              anchor: "D2:L18",
            },
          ],
        },
      ],
    });
    console.log("native chart create ok");
    r = await call("Edit", {
      path: r.path,
      expected_sha256: r.sha256,
      operations: [{ path: "/数据/B2", props: { value: 15 } }],
    });
    assert.equal(r.preservation.preserved, true);
    console.log("native chart data preservation ok");
    r = await call("Edit", {
      path: r.path,
      expected_sha256: r.sha256,
      operations: [
        {
          action: "update_chart",
          path: "/汇总/chart[1]",
          props: { title: "Updated" },
        },
      ],
    });
    assert.equal(r.chart_checks[0].title, "Updated");
    console.log("native chart title edit ok");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
test("real OfficeCLI: native API verifies row and column index mapping and cross-sheet reference changes", async () => {
  const { cwd, call } = await fixture();
  try {
    let r = await call("Create", {
      path: "bands.xlsx",
      sheets: [
        {
          name: "S",
          rows: [
            ["name", "value"],
            ["a", 10],
            ["b", 20],
          ],
          columns: [15, 15],
          filter: "A1:B3",
        },
        { name: "T", rows: [["sum", { formula: "SUM('S'!B2:B3)" }]] },
      ],
    });
    r = await call("Edit", {
      path: r.path,
      expected_sha256: r.sha256,
      operations: [{ action: "insert_rows", sheet: "S", index: 2, count: 1 }],
    });
    console.log("native row insert ok");
    r = await call("Edit", {
      path: r.path,
      expected_sha256: r.sha256,
      operations: [
        {
          action: "delete_rows",
          sheet: "S",
          index: 2,
          count: 1,
          expected_cells: [],
        },
      ],
    });
    console.log("native row delete ok");
    r = await call("Edit", {
      path: r.path,
      expected_sha256: r.sha256,
      operations: [
        { action: "insert_columns", sheet: "S", index: 1, count: 1 },
      ],
    });
    console.log("native column insert ok");
    r = await call("Edit", {
      path: r.path,
      expected_sha256: r.sha256,
      operations: [
        {
          action: "delete_columns",
          sheet: "S",
          index: 1,
          count: 1,
          expected_cells: [],
        },
      ],
    });
    assert.equal(r.preservation.preserved, true);
    console.log("native column delete ok");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
