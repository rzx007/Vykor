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
export function bandRange(range, p) {
  if (!/^[A-Z]+\d+(?::[A-Z]+\d+)?$/.test(range))
    throw new Error("不支持此结构范围。");
  return shiftedRange(...[range.split(":")[0], range.split(":")[1], p]);
}
