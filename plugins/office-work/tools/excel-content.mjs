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
export function formulaReport(root) {
  const formulas = [],
    stale = [],
    missing = [],
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
    if (f.cachedValue === undefined || f.cachedValue === null) missing.push(r);
    if (f.computedValue === undefined) unknown.push(r);
    else if (
      f.cachedValue !== undefined && f.cachedValue !== null &&
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
    missing_cache_cells: missing,
    unverified_cells: unknown,
    error_cells: errors,
    evaluator_all_computed: !unknown.length && !errors.length,
    cached_values_current: !missing.length && !stale.length && !unknown.length,
    calculation_verified: false,
    excel_recalculation_verified: false,
  };
}
