// Excel input planning and bounded readback checks; no Office process here.
export function only(value, allowed) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !allowed.includes(k))
  )
    throw new Error("包含不支持的 Excel 字段。");
}
export function sheetName(value) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 31 ||
    value.includes("!") ||
    /[\x00-\x1f\\/:?*\[\]]/.test(value) ||
    value.startsWith("'") ||
    value.endsWith("'")
  )
    throw new Error(
      "工作表名须为 1–31 字符，不能含路径或 Excel 禁用字符；首版另不支持含 ! 的表名。",
    );
  return value;
}
const colNumber = (s) =>
  [...s].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
export function column(index) {
  let out = "";
  for (let n = index + 1; n; n = Math.floor((n - 1) / 26))
    out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
  return out;
}
export function excelTarget(raw, root = false) {
  if (root && (raw === undefined || raw === "/")) return "/";
  if (typeof raw !== "string")
    throw new Error("须提供实际工作表及 A1 区域路径。");
  const m = raw.match(
    /^\/([^/]+)(?:\/([A-Z]{1,3})([1-9]\d*)(?::([A-Z]{1,3})([1-9]\d*))?)?$/,
  );
  if (!m) throw new Error("路径须为 /工作表、/工作表/A1 或 /工作表/A1:B10。");
  sheetName(m[1]);
  if (m[2]) {
    const a = colNumber(m[2]),
      b = m[4] ? colNumber(m[4]) : a,
      r = Number(m[3]),
      s = m[5] ? Number(m[5]) : r;
    if (
      b < a ||
      s < r ||
      b > 16384 ||
      s > 1048576 ||
      (b - a + 1) * (s - r + 1) > 2000
    )
      throw new Error("读取区域须顺序有效且最多 2000 个单元格。");
  }
  return raw;
}
export function cellProps(value) {
  const cell =
    typeof value === "string" || typeof value === "number" ? { value } : value;
  only(cell, [
    "value",
    "formula",
    "format",
    "bold",
    "fill",
    "color",
    "wrap",
    "align",
  ]);
  const props = {};
  if (cell.value !== undefined && cell.formula !== undefined)
    throw new Error("value 和 formula 不能同时填写。");
  if (cell.value !== undefined) {
    if (
      typeof cell.value !== "string" &&
      (typeof cell.value !== "number" || !Number.isFinite(cell.value))
    )
      throw new Error("单元格仅支持文字或有限数字。");
    if (String(cell.value).length > 4000)
      throw new Error("单元格内容超过 4000 字符。");
    props.clear = "true";
    props.value = String(cell.value);
    props.type = typeof cell.value === "string" ? "string" : "number";
  }
  if (cell.formula !== undefined) {
    if (
      typeof cell.formula !== "string" ||
      !cell.formula.trim() ||
      cell.formula.length > 2000 ||
      /[\[\]\r\n|]|(?:https?:|file:|\\\\)|\b(?:WEBSERVICE|HYPERLINK|RTD|DDE)\s*\(/i.test(
        cell.formula,
      )
    )
      throw new Error("公式为空、过长或包含外部引用／外部调用。");
    props.clear = "true";
    props.formula = cell.formula.replace(/^=/, "");
  }
  for (const key of ["bold", "wrap"])
    if (cell[key] !== undefined) {
      if (typeof cell[key] !== "boolean")
        throw new Error("bold/wrap 须为布尔值。");
      props[key] = String(cell[key]);
    }
  for (const key of ["fill", "color"])
    if (cell[key] !== undefined) {
      if (!/^#[a-f0-9]{6}$/i.test(cell[key]))
        throw new Error("颜色须为 #RRGGBB。");
      props[key === "color" ? "font.color" : key] = cell[key];
    }
  if (cell.format !== undefined) {
    if (
      typeof cell.format !== "string" ||
      !cell.format ||
      cell.format.length > 100
    )
      throw new Error("数字格式无效。");
    props.numberformat = cell.format;
  }
  if (cell.align !== undefined) {
    if (!["left", "center", "right"].includes(cell.align))
      throw new Error("对齐须为 left/center/right。");
    props.halign = cell.align;
  }
  if (!Object.keys(props).length) throw new Error("单元格修改不能为空。");
  return props;
}
export function buildWorkbook(input) {
  const sheets = input.sheets;
  if (!Array.isArray(sheets) || !sheets.length || sheets.length > 8)
    throw new Error("须提供 1–8 张工作表。");
  const seen = new Set(),
    ops = [];
  let cells = 0;
  for (const [i, s] of sheets.entries()) {
    only(s, ["name", "rows", "columns", "freeze", "filter", "charts"]);
    if (
      s.charts !== undefined &&
      (!Array.isArray(s.charts) || s.charts.length > 4)
    )
      throw new Error("每张表最多4张图表。");
    sheetName(s.name);
    if (seen.has(s.name.toLowerCase())) throw new Error("工作表名不能重复。");
    seen.add(s.name.toLowerCase());
    if (
      !Array.isArray(s.rows) ||
      !s.rows.length ||
      s.rows.length > 200 ||
      s.rows.some((r) => !Array.isArray(r) || r.length > 26)
    )
      throw new Error("每张表须为 1–200 行、最多 26 列。");
    ops.push(
      i
        ? {
            command: "add",
            parent: "/",
            type: "sheet",
            props: { name: s.name },
          }
        : { command: "set", path: "/Sheet1", props: { name: s.name } },
    );
  }
  for (const s of sheets) {
    if (s.columns !== undefined) {
      if (
        !Array.isArray(s.columns) ||
        s.columns.length > 26 ||
        s.columns.some((n) => !Number.isFinite(n) || n < 5 || n > 80)
      )
        throw new Error("列宽须为 5–80 的数字，最多 26 列。");
      s.columns.forEach((width, i) =>
        ops.push({
          command: "set",
          path: `/${s.name}/col[${column(i)}]`,
          props: { width: String(width) },
        }),
      );
    }
    s.rows.forEach((row, r) =>
      row.forEach((value, c) => {
        if (value === null) return;
        if (++cells > 5000) throw new Error("单次最多写入 5000 个单元格。");
        ops.push({
          command: "set",
          path: `/${s.name}/${column(c)}${r + 1}`,
          props: {
            font: "Microsoft YaHei",
            ...(r === 0 ? { bold: "true", fill: "#E8EFF8" } : {}),
            ...cellProps(value),
          },
        });
      }),
    );
    const settings = {};
    if (s.freeze !== undefined) {
      if (!/^[A-Z]{1,2}[1-9]\d{0,3}$/.test(s.freeze))
        throw new Error("冻结位置须为 A1 地址。");
      settings.freeze = s.freeze;
    }
    if (s.filter !== undefined) {
      excelTarget(`/${s.name}/${s.filter}`);
      if (!s.filter.includes(":")) throw new Error("筛选须指定矩形范围。");
      settings.autoFilter = s.filter;
    }
    if (Object.keys(settings).length)
      ops.push({ command: "set", path: `/${s.name}`, props: settings });
  }
  if (JSON.stringify(ops).length > 500000)
    throw new Error("报表内容过大，请缩小范围。");
  return ops;
}
export function cellsOf(root) {
  const cells = new Map();
  let count = 0;
  const walk = (n) => {
    if (++count > 15000) throw new Error("工作簿过大，请拆分后处理。");
    if (
      !["workbook", "sheet", "row", "column", "range", "cell"].includes(n.type)
    )
      return;
    if (n.type === "cell") {
      if (n.children?.length) throw new Error("不支持复杂单元格修改。");
      cells.set(n.path, n);
      return;
    }
    if (
      n.childCount !== undefined &&
      n.childCount !== (n.children ?? []).length
    )
      throw new Error("回读内容不完整，拒绝核对修改范围。");
    for (const child of n.children ?? []) walk(child);
  };
  walk(root);
  return cells;
}
const canonical = (n) => {
  const f = { ...n.format };
  delete f.computedValue;
  delete f.cachedValue;
  delete f.evaluated;
  delete f.empty;
  if (f.formula) delete f.type;
  return JSON.stringify({
    text: f.formula ? undefined : (n.text ?? ""),
    format: Object.fromEntries(
      Object.entries(f).sort(([a], [b]) => a.localeCompare(b)),
    ),
  });
};
export function auditChanges(before, after, requested) {
  const a = cellsOf(before),
    b = cellsOf(after),
    allowed = new Set(requested),
    changed = [];
  if (
    JSON.stringify(before.children?.map((s) => s.path)) !==
    JSON.stringify(after.children?.map((s) => s.path))
  )
    throw new Error("工作表范围或顺序发生变化，拒绝保存。");
  for (const path of new Set([...a.keys(), ...b.keys()])) {
    if (
      a.has(path) &&
      b.has(path) &&
      canonical(a.get(path)) === canonical(b.get(path))
    )
      continue;
    if (!allowed.has(path))
      throw new Error(`检测到修改范围之外的单元格变化：${path}，拒绝保存。`);
    changed.push(path);
  }
  return {
    scope: "cell_content_and_format_readback",
    requested_cells: requested,
    changed_cells: changed,
    formula_results_may_change: true,
  };
}
export function verifyCellFormats(root, operations) {
  const cells = cellsOf(root);
  const keys = {
    bold: "font.bold",
    wrap: "alignment.wrapText",
    halign: "alignment.horizontal",
    fill: "fill",
    "font.color": "font.color",
    numberformat: "numberformat",
  };
  for (const op of operations) {
    const cell = cells.get(op.path);
    if (!cell) {
      if (/^\/[^/]+\/[A-Z]+\d+$/.test(op.path))
        throw new Error(`单元格未能完整写入：${op.path}`);
      continue;
    }
    for (const [key, canonical] of Object.entries(keys)) {
      if (op.props[key] === undefined) continue;
      let actual = cell.format?.[canonical];
      if (["bold", "wrap"].includes(key)) actual = actual ?? false;
      if (key === "numberformat") actual = actual ?? "General";
      if (String(actual).toLowerCase() !== String(op.props[key]).toLowerCase())
        throw new Error(`单元格格式回读不符合请求：${op.path} (${key})`);
    }
  }
}
export function formulaReport(root) {
  const formulas = [],
    stale = [],
    unknown = [],
    errors = [];
  for (const n of cellsOf(root).values()) {
    const f = n.format ?? {};
    if (f.type === "Error") errors.push({ path: n.path, value: n.text });
    if (!f.formula) continue;
    const r = {
      path: n.path,
      formula: f.formula,
      cached_value: f.cachedValue,
      computed_value: f.computedValue,
    };
    formulas.push(r);
    if (f.computedValue === undefined) unknown.push(r);
    else if (
      f.cachedValue !== undefined &&
      String(f.cachedValue) !== String(f.computedValue)
    )
      stale.push(r);
    if (
      /^#(?:REF!|DIV\/0!|VALUE!|NAME\?|N\/A|NUM!|SPILL!|CALC!)/.test(
        String(f.computedValue),
      )
    )
      errors.push(r);
  }
  return {
    formula_count: formulas.length,
    formulas,
    stale_cache_cells: stale,
    unverified_cells: unknown,
    error_cells: errors,
    evaluator_all_computed: !unknown.length && !errors.length,
    cached_values_current: !stale.length && !unknown.length,
    calculation_verified: false,
    excel_recalculation_verified: false,
  };
}
