import { only, excelTarget, sheetName } from "./excel-content.mjs";
export const numberOfColumn = (s) =>
  [...s.toUpperCase()].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
export const letterOfColumn = (n) => {
  let s = "";
  for (; n; n = Math.floor((n - 1) / 26))
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};
function point(raw) {
  const m = raw.match(/^(\$?)([A-Z]{1,3})(\$?)([1-9]\d*)$/i);
  if (!m || numberOfColumn(m[2]) > 16384 || Number(m[4]) > 1048576)
    throw new Error("单元格地址无效。");
  return {
    column: numberOfColumn(m[2]),
    row: Number(m[4]),
    absoluteColumn: m[1],
    absoluteRow: m[3],
  };
}
function position(n, p) {
  if (p.insert) return n >= p.index ? n + p.count : n;
  return n < p.index ? n : n >= p.index + p.count ? n - p.count : null;
}
export function mapAddress(address, p) {
  const a = point(address),
    key = p.axis === "row" ? "row" : "column",
    n = position(a[key], p);
  if (n === null) return null;
  a[key] = n;
  if (a.row > 1048576 || a.column > 16384)
    throw new Error("行列移动超出工作表边界。");
  return `${a.absoluteColumn}${letterOfColumn(a.column)}${a.absoluteRow}${a.row}`;
}
function shiftedRange(a, b, p) {
  if (!b) return mapAddress(a, p) ?? "#REF!";
  const x = point(a),
    y = point(b),
    key = p.axis === "row" ? "row" : "column";
  if (x[key] > y[key]) throw new Error("首版行列操作不支持倒序引用。");
  let lo = x[key],
    hi = y[key];
  if (p.insert) {
    if (p.index <= lo) {
      lo += p.count;
      hi += p.count;
    } else if (p.index <= hi) hi += p.count;
  } else {
    const end = p.index + p.count - 1;
    if (hi < p.index) {
    } else if (lo > end) {
      lo -= p.count;
      hi -= p.count;
    } else {
      lo = lo < p.index ? lo : p.index;
      hi = hi > end ? hi - p.count : p.index - 1;
      if (hi < lo) return "#REF!";
    }
  }
  if (hi > (p.axis === "row" ? 1048576 : 16384))
    throw new Error("引用移动超出工作表边界。");
  x[key] = lo;
  y[key] = hi;
  const show = (v) =>
    `${v.absoluteColumn}${letterOfColumn(v.column)}${v.absoluteRow}${v.row}`;
  return show(x) + ":" + show(y);
}
export function rewriteFormula(formula, formulaSheet, p) {
  const applies = (prefix) =>
    (prefix
      ? prefix.slice(0, -1).replace(/^'|'$/g, "").replace(/''/g, "'")
      : formulaSheet
    ).toLowerCase() === p.sheet.toLowerCase();
  return formula
    .split(/("(?:[^"]|"")*")/g)
    .map((part, i) => {
      if (i % 2) return part;
      if (/\[|\]|(?:'[^']*:[^']*'|[\w]+:[\w]+)!/.test(part))
        throw new Error("行列移动暂不支持外部、结构化或三维公式引用。");
      let result = part.replace(
        /(?<![\p{L}\p{N}_.$])((?:'(?:[^']|'')+'|[\p{L}_][\p{L}\p{N}_.]*)!)?(\$?[A-Z]{1,3}\$?[1-9]\d*)(?::(\$?[A-Z]{1,3}\$?[1-9]\d*))?(?![\p{L}\p{N}_.]|\s*\()/gu,
        (all, prefix, a, b) =>
          applies(prefix) ? (prefix ?? "") + shiftedRange(a, b, p) : all,
      );
      result = result.replace(
        /(?<![\p{L}\p{N}_.$])((?:'(?:[^']|'')+'|[\p{L}_][\p{L}\p{N}_.]*)!)?(\$?[A-Z]{1,3}):(\$?[A-Z]{1,3})(?![\p{L}\p{N}_])/gu,
        (all, prefix, a, b) => {
          if (p.axis !== "column" || !applies(prefix)) return all;
          const range = shiftedRange(a + "1", b + "1", p);
          return (
            (prefix ?? "") +
            (range === "#REF!" ? range : range.replace(/1/g, ""))
          );
        },
      );
      return result.replace(
        /(?<![\p{L}\p{N}_.$])((?:'(?:[^']|'')+'|[\p{L}_][\p{L}\p{N}_.]*)!)?(\$?[1-9]\d*):(\$?[1-9]\d*)(?![\p{L}\p{N}_])/gu,
        (all, prefix, a, b) => {
          if (p.axis !== "row" || !applies(prefix)) return all;
          const range = shiftedRange("A" + a, "A" + b, p);
          return (
            (prefix ?? "") +
            (range === "#REF!" ? range : range.replace(/A/g, ""))
          );
        },
      );
    })
    .join("");
}
export function structurePlan(input) {
  only(input, ["action", "sheet", "index", "count", "expected_cells"]);
  if (!/^(insert|delete)_(rows|columns)$/.test(input.action ?? ""))
    throw new Error("行列操作无效。");
  sheetName(input.sheet);
  const axis = input.action.endsWith("rows") ? "row" : "column",
    limit = axis === "row" ? 1048576 : 16384,
    count = input.count ?? 1;
  if (
    !Number.isSafeInteger(input.index) ||
    input.index < 1 ||
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > 20 ||
    input.index + count - 1 > limit
  )
    throw new Error("行列位置无效，单次最多20行或列。");
  const insert = input.action.startsWith("insert");
  if (!insert && !Array.isArray(input.expected_cells))
    throw new Error("删除必须提供刚读取的 expected_cells，不允许无证据删除。");
  if (input.expected_cells?.length > 2000)
    throw new Error("删除范围数据过多，请缩小范围。");
  const operations = Array.from({ length: count }, (_, i) =>
    insert
      ? axis === "row"
        ? {
            command: "add",
            parent: `/${input.sheet}`,
            type: "row",
            index: input.index - 1,
            props: {},
          }
        : {
            command: "add",
            parent: `/${input.sheet}`,
            type: "column",
            props: { name: letterOfColumn(input.index) },
          }
      : {
          command: "remove",
          path: `/${input.sheet}/${axis === "row" ? `row[${input.index + count - 1 - i}]` : `col[${letterOfColumn(input.index + count - 1 - i)}]`}`,
        },
  );
  return { ...input, count, axis, insert, operations };
}
export function auditStructure(before, after, p) {
  const collect = (root) => {
    const out = new Map();
    const visit = (n) => {
      if (n.type === "cell") out.set(n.path, n);
      else for (const c of n.children ?? []) visit(c);
    };
    visit(root);
    return out;
  };
  const a = collect(before),
    b = collect(after),
    expected = new Map(),
    deleted = [];
  if (!before.children?.some((s) => s.path === `/${p.sheet}`))
    throw new Error("目标工作表不存在。");
  if (
    JSON.stringify(before.children.map((s) => s.path)) !==
    JSON.stringify(after.children.map((s) => s.path))
  )
    throw new Error("工作表顺序改变，未保存。");
  for (const [path, n] of a) {
    const [, sheet, address] = path.split("/");
    const target = sheet === p.sheet ? mapAddress(address, p) : address;
    if (!target) {
      if (n.text || n.format?.formula)
        deleted.push({
          path,
          expected_text: n.text ?? "",
          ...(n.format?.formula ? { expected_formula: n.format.formula } : {}),
        });
      continue;
    }
    const format = { ...n.format };
    delete format.cachedValue;
    delete format.computedValue;
    delete format.evaluated;
    delete format.empty;
    if (format.formula) {
      format.formula = rewriteFormula(format.formula, sheet, p);
      delete format.type;
    }
    expected.set(`/${sheet}/${target}`, {
      text: format.formula ? undefined : (n.text ?? ""),
      format,
    });
  }
  checkDeletionEvidence(before, p);
  for (const [path, n] of b) {
    const format = { ...n.format };
    delete format.cachedValue;
    delete format.computedValue;
    delete format.evaluated;
    delete format.empty;
    if (format.formula) delete format.type;
    const value = { text: format.formula ? undefined : (n.text ?? ""), format };
    const wanted = expected.get(path);
    const stable = (o) =>
      JSON.stringify({
        text: o.text,
        format: Object.fromEntries(
          Object.entries(o.format).sort(([a], [b]) => a.localeCompare(b)),
        ),
      });
    if (wanted) {
      if (stable(wanted) !== stable(value))
        throw new Error(`行列移动后的内容或公式核对失败：${path}`);
      expected.delete(path);
    } else if (n.text || n.format?.formula)
      throw new Error(`行列操作出现额外内容：${path}`);
  }
  if ([...expected.values()].some((n) => n.text || n.format.formula))
    throw new Error("行列移动后原有数据丢失，未保存。");
  return {
    scope: "whole_band_content_formula_and_package",
    action: p.action,
    sheet: p.sheet,
    index: p.index,
    count: p.count,
    deleted_cells: deleted,
    formula_references_checked: true,
  };
}
export function bandRange(range, p) {
  if (!/^[A-Z]+\d+(?::[A-Z]+\d+)?$/.test(range))
    throw new Error("不支持此结构范围。");
  return shiftedRange(...[range.split(":")[0], range.split(":")[1], p]);
}
export function checkDeletionEvidence(root, p) {
  if (p.insert) return;
  const deleted = [];
  const visit = (n) => {
    if (n.type === "cell") {
      const [, sheet, address] = n.path.split("/");
      if (
        sheet === p.sheet &&
        mapAddress(address, p) === null &&
        (n.text || n.format?.formula)
      )
        deleted.push({
          path: n.path,
          expected_text: n.text ?? "",
          ...(n.format?.formula ? { expected_formula: n.format.formula } : {}),
        });
    } else for (const c of n.children ?? []) visit(c);
  };
  visit(root);
  const stable = (list) =>
    JSON.stringify(
      list
        .map((v) => {
          only(v, ["path", "expected_text", "expected_formula"]);
          if (
            typeof v.path !== "string" ||
            typeof v.expected_text !== "string" ||
            (v.expected_formula !== undefined &&
              typeof v.expected_formula !== "string")
          )
            throw new Error(
              "删除证据须包含实际路径、expected_text 和可选 expected_formula。",
            );
          return {
            path: v.path,
            expected_text: v.expected_text,
            ...(v.expected_formula !== undefined
              ? { expected_formula: v.expected_formula }
              : {}),
          };
        })
        .sort((a, b) => a.path.localeCompare(b.path)),
    );
  if (stable(deleted) !== stable(p.expected_cells))
    throw new Error("删除前的原始单元格证据不匹配，请重新读取。");
}
