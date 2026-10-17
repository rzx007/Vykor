// Adapted from Orkas buildXlsxWorkbookBatch: data first, native charts second,
// and a post-add axis set for OfficeCLI 1.0.139. See licenses/ORKAS-LICENSE.
import { only, excelTarget, sheetName } from "./excel-content.mjs";
import { numberOfColumn, letterOfColumn } from "./excel-structure.mjs";
import {
  parseXml,
  children,
  textOf,
  walkXml,
  chartFiles,
  chartAnchors,
} from "./excel-xml.mjs";
export function chartRange(raw) {
  if (typeof raw !== "string" || raw.length > 150)
    throw new Error("图表须绑定工作表单元格区域。");
  const m = raw.match(
    /^(?:'((?:[^']|'')+)'|([^'!]+))!([A-Z]+)([1-9]\d*):([A-Z]+)([1-9]\d*)$/,
  );
  if (!m)
    throw new Error("图表数据须为 工作表!A1:B10，不能使用外部数据或静态数组。");
  const sheet = (m[1] ?? m[2]).replace(/''/g, "'");
  sheetName(sheet);
  excelTarget(`/${sheet}/${m[3]}${m[4]}:${m[5]}${m[6]}`);
  return {
    sheet,
    firstColumn: numberOfColumn(m[3]),
    lastColumn: numberOfColumn(m[5]),
    firstRow: Number(m[4]),
    lastRow: Number(m[6]),
  };
}
const propsKeys = [
  "type",
  "title",
  "dataRange",
  "categories",
  "anchor",
  "category_title",
  "value_title",
  "axismin",
  "axismax",
];
export function chartSpec(input) {
  only(input, propsKeys);
  if (
    !["column", "line"].includes(input.type) ||
    typeof input.title !== "string" ||
    !input.title.trim() ||
    input.title.length > 100
  )
    throw new Error("首版图表须为 column 或 line，并提供非空标题。");
  const d = chartRange(input.dataRange);
  if (d.lastRow <= d.firstRow || d.lastColumn - d.firstColumn > 7)
    throw new Error("图表须包含表头与数据，最多8个数据列。");
  if (input.categories) {
    const c = chartRange(input.categories);
    if (
      c.firstColumn !== c.lastColumn ||
      c.lastRow - c.firstRow !== d.lastRow - d.firstRow - 1
    )
      throw new Error("分类范围须为单列，且与去掉表头后的数据行数一致。");
  } else if (d.lastColumn === d.firstColumn)
    throw new Error("单列数据须显式提供 categories 分类范围。");
  const anchor = input.anchor ?? "D2:L18";
  excelTarget("/Chart/" + anchor);
  const a = anchor.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
  if (
    !a ||
    numberOfColumn(a[3]) - numberOfColumn(a[1]) < 3 ||
    numberOfColumn(a[3]) - numberOfColumn(a[1]) > 11 ||
    Number(a[4]) - Number(a[2]) < 3 ||
    Number(a[4]) - Number(a[2]) > 39
  )
    throw new Error("图表锚点须为4–12列、4–40行的矩形。");
  for (const k of ["category_title", "value_title"])
    if (
      input[k] !== undefined &&
      (typeof input[k] !== "string" || input[k].length > 80)
    )
      throw new Error("坐标轴标题过长。");
  for (const k of ["axismin", "axismax"])
    if (input[k] !== undefined && !Number.isFinite(input[k]))
      throw new Error("坐标轴边界须为有限数字。");
  const min = input.axismin ?? (input.type === "column" ? 0 : undefined);
  if (input.axismax !== undefined && min !== undefined && input.axismax <= min)
    throw new Error("坐标轴最大值须大于最小值。");
  return { ...input, anchor, ...(min === undefined ? {} : { axismin: min }) };
}
export function chartCommands(sheet, spec, index) {
  sheetName(sheet);
  const p = {
    chartType: spec.type,
    dataRange: spec.dataRange,
    title: spec.title,
    anchor: spec.anchor,
    ...(spec.categories ? { categories: spec.categories } : {}),
    ...(spec.category_title ? { catTitle: spec.category_title } : {}),
    ...(spec.value_title ? { axistitle: spec.value_title } : {}),
  };
  const post = {};
  for (const key of ["axismin", "axismax"])
    if (spec[key] !== undefined) post[key] = String(spec[key]);
  return [
    { command: "add", parent: `/${sheet}`, type: "chart", props: p },
    ...(Object.keys(post).length
      ? [{ command: "set", path: `/${sheet}/chart[${index}]`, props: post }]
      : []),
  ];
}
export function chartUpdate(input) {
  only(input, [
    "title",
    "anchor",
    "category_title",
    "value_title",
    "axismin",
    "axismax",
  ]);
  if (!Object.keys(input).length) throw new Error("图表修改不能为空。");
  const props = {};
  for (const [k, v] of Object.entries(input)) {
    if (["axismin", "axismax"].includes(k)) {
      if (!Number.isFinite(v)) throw new Error("坐标轴边界无效。");
    } else if (typeof v !== "string" || !v.trim() || v.length > 100)
      throw new Error("图表文字无效。");
    props[{ category_title: "catTitle", value_title: "axistitle" }[k] ?? k] =
      String(v);
  }
  if (input.anchor) {
    chartSpec({
      type: "column",
      title: "bounds",
      dataRange: "S!A1:B2",
      anchor: input.anchor,
    });
  }
  return props;
}
const normalized = (ref) =>
  ref
    .replaceAll("$", "")
    .replace(/'((?:[^']|'')+)'!/g, (_, s) => s.replace(/''/g, "'") + "!")
    .toLowerCase()
    .replace(/!([a-z]+\d+):\1$/, "!$1");
export function verifyChart(
  parts,
  sheet,
  index,
  spec,
  { update = false } = {},
) {
  const path = chartFiles(parts, sheet)[index - 1];
  if (!path) throw new Error("未找到写入的原生图表。");
  const root = parseXml(parts.get(path));
  let chart;
  walkXml(root, (n) => {
    if (n.name === "chart") chart = n;
  });
  if (!chart) throw new Error("图表文件结构无效。");
  if (
    spec.title !== undefined &&
    textOf(children(chart, "title")[0]) !== spec.title
  )
    throw new Error("图表标题回读失败。");
  const nodes = [];
  walkXml(root, (n) => nodes.push(n));
  if (!update) {
    const tag = spec.type === "column" ? "barChart" : "lineChart";
    if (!nodes.some((n) => n.name === tag))
      throw new Error("图表类型核对失败。");
    if (
      spec.type === "column" &&
      !nodes.some((n) => n.name === "barDir" && n.attrs.val === "col")
    )
      throw new Error("柱状图方向核对失败。");
    const refs = new Set(
        nodes.filter((n) => n.name === "f").map((n) => normalized(textOf(n))),
      ),
      d = chartRange(spec.dataRange),
      required = [];
    for (
      let c = d.firstColumn + (spec.categories ? 0 : 1);
      c <= d.lastColumn;
      c++
    )
      required.push(
        `${d.sheet}!${letterOfColumn(c)}${d.firstRow + 1}:${letterOfColumn(c)}${d.lastRow}`,
      );
    if (nodes.filter((n) => n.name === "ser").length !== required.length)
      throw new Error("图表数据系列数量不匹配。");
    const category =
      spec.categories ??
      `${d.sheet}!${letterOfColumn(d.firstColumn)}${d.firstRow + 1}:${letterOfColumn(d.firstColumn)}${d.lastRow}`;
    required.push(category);
    for (const ref of required)
      if (!refs.has(normalized(ref)))
        throw new Error(`图表未保留数据区域绑定：${ref}`);
  }
  for (const key of ["axismin", "axismax"])
    if (spec[key] !== undefined) {
      const tag = key === "axismin" ? "min" : "max",
        axes = nodes.filter((n) => n.name === "valAx");
      if (
        !axes.some((axis) => {
          let found = false;
          walkXml(axis, (n) => {
            if (n.name === tag && Number(n.attrs.val) === spec[key])
              found = true;
          });
          return found;
        })
      )
        throw new Error("图表坐标轴边界未保存。");
    }
  for (const [key, axisName] of [
    ["category_title", "catAx"],
    ["value_title", "valAx"],
  ])
    if (
      spec[key] !== undefined &&
      !nodes.some(
        (n) =>
          n.name === axisName && textOf(children(n, "title")[0]) === spec[key],
      )
    )
      throw new Error("坐标轴标题未保存。");
  if (spec.anchor) {
    const item = chartAnchors(parts, sheet).find((a) => a.path === path),
      m = spec.anchor.match(/^([A-Z]+)([1-9]\d*):([A-Z]+)([1-9]\d*)$/);
    const from = children(item?.anchor, "from")[0],
      to = children(item?.anchor, "to")[0];
    if (
      !m ||
      !from ||
      !to ||
      Number(textOf(children(from, "col")[0])) !== numberOfColumn(m[1]) - 1 ||
      Number(textOf(children(from, "row")[0])) !== Number(m[2]) - 1 ||
      Number(textOf(children(to, "col")[0])) !== numberOfColumn(m[3]) - 1 ||
      Number(textOf(children(to, "row")[0])) !== Number(m[4]) - 1
    )
      throw new Error("图表位置回读失败。");
  }
  return {
    sheet,
    index,
    path,
    type: spec.type,
    title: spec.title,
    dataRange: spec.dataRange,
    categories: spec.categories,
    native_editable: true,
    data_binding_checked: !update,
  };
}
