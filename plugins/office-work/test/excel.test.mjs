import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, copyFile, readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { registerTools } from "../tools/index.mjs";
import { hash } from "../tools/engine.mjs";
test("real OfficeCLI: Excel lifecycle preserves originals, formulas and immutable region reviews", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "office-excel-080-"));
  const base = {
    cwd,
    plugin: {
      root: resolve("plugins/office-work"),
      dataDir: join(cwd, "data"),
    },
    permissions: { filesystem: ["read", "write"], process: ["officecli"] },
    signal: new AbortController().signal,
  };
  const tools = Object.fromEntries(registerTools().map((t) => [t.name, t]));
  assert.equal(
    Object.keys(tools).filter((n) => n.startsWith("OfficeExcel")).length,
    6,
  );
  const raw = (name, input) =>
    tools["OfficeExcel" + name].invoke(input, {
      ...base,
      deadline: Date.now() + 120000,
    });
  const call = async (name, input) => {
    const r = await raw(name, input);
    assert.notEqual(r.isError, true, r.content[0].text);
    console.log(name, "ok");
    return JSON.parse(r.content[0].text);
  };
  try {
    const created = await call("Create", {
      path: "report.xlsx",
      sheets: [
        {
          name: "汇总",
          rows: [
            ["合计", { formula: "SUM('明细'!B2:B3)", format: "#,##0.00" }],
            ["比例", { formula: "B1/200", format: "0.00%" }],
          ],
          columns: [18, 18],
        },
        {
          name: "明细",
          rows: [
            ["编号", "金额"],
            ["00123", 100],
            ["=literal", 50],
          ],
          columns: [18, 18],
          freeze: "A2",
          filter: "A1:B3",
        },
      ],
    });
    assert.equal(created.cleanup_complete, true);
    assert.equal(created.formula_check.formulas[0].computed_value, "150");
    const read = await call("Read", { path: created.path, target: "/明细/A2" });
    assert.equal(read.document.text, "00123");
    assert.equal(read.document.format.type, "String");
    const edited = await call("Edit", {
      path: created.path,
      expected_sha256: created.sha256,
      operations: [{ path: "/明细/B2", props: { value: 120 } }],
    });
    assert.equal(edited.path, created.path);
    assert.deepEqual(edited.change_check.changed_cells, ["/明细/B2"]);
    assert.equal(edited.formula_check.formulas[0].computed_value, "170");
    assert.equal(edited.formula_check.formulas[1].computed_value, "0.85");
    assert.equal(edited.formula_check.excel_recalculation_verified, false);
    assert.equal(
      (
        await raw("Edit", {
          path: created.path,
          expected_sha256: created.sha256,
          operations: [{ path: "/明细/B2", props: { value: 1 } }],
        })
      ).isError,
      true,
    );
    const original = join(cwd, "user.xlsx");
    await copyFile(created.path, original);
    const before = hash(await readFile(original));
    const userEdited = await call("Edit", {
      path: original,
      expected_sha256: before,
      operations: [{ path: "/明细/A2", props: { value: "00099" } }],
    });
    assert.notEqual(userEdited.path, original);
    assert.equal(hash(await readFile(original)), before);
    const checked = await call("Check", { path: created.path });
    assert.equal(checked.structure_checked, true);
    assert.equal(checked.formula_check.formulas[0].computed_value, "170");
    const preview = await call("Preview", {
      path: created.path,
      sheet: "明细",
      range: "A1:B3",
    });
    assert.equal(preview.cleanup_complete, true);
    assert.equal(preview.sha256, edited.sha256);
    assert.equal(
      hash(await readFile(preview.image_path)),
      preview.image_sha256,
    );
    console.log("IMAGE", preview.image_path);
    const review = await call("Review", {
      path: created.path,
      expected_sha256: edited.sha256,
      regions: [
        {
          preview_id: preview.preview_id,
          conclusion: "issues",
          findings: "测试记录，不作为实际视觉验收。",
        },
      ],
    });
    const first = await readFile(review.record_path);
    const again = await call("Review", {
      path: created.path,
      expected_sha256: edited.sha256,
      regions: [
        {
          preview_id: preview.preview_id,
          conclusion: "issues",
          findings: "第二轮测试记录，不作为实际视觉验收。",
        },
      ],
    });
    assert.notEqual(again.record_path, review.record_path);
    assert.deepEqual(await readFile(review.record_path), first);
    assert.equal(
      (
        await raw("Review", {
          path: original,
          expected_sha256: before,
          regions: [
            {
              preview_id: preview.preview_id,
              conclusion: "passed",
              findings: "错误跨文件记录",
            },
          ],
        })
      ).isError,
      true,
    );
    assert.equal(hash(await readFile(created.path)), edited.sha256);
    assert.equal(
      (await readdir(cwd)).filter(
        (n) => n.startsWith(".office-work-") || n.endsWith(".office-work.lock"),
      ).length,
      0,
    );
    await rm(cwd, { recursive: true, force: true });
  } catch (e) {
    console.log("RETAINED_FIXTURE", cwd);
    throw e;
  }
});
