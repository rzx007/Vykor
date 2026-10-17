import {
  parseXml,
  canonicalXml,
  cloneXml,
  children,
  textOf,
  walkXml,
  sheetInfo,
  chartFiles,
  relationships,
} from "./excel-xml.mjs";
import {
  mapAddress,
  rewriteFormula,
  bandRange,
  letterOfColumn,
  numberOfColumn,
} from "./excel-structure.mjs";
const failure = (part) => {
  throw new Error(
    `工作簿保留核对失败，检测到修改范围外变化：${part}，未保存。`,
  );
};
const equal = (a, b, name) => {
  if (canonicalXml(a) !== canonicalXml(b)) failure(name);
};
export function workbookSupport(
  parts,
  { structural = false, cells = [] } = {},
) {
  const features = new Set();
  for (const [name, xml] of parts) {
    if (
      /xl\/(?:vba|externalLinks|connections|pivot|richData|slicer|embeddings|queryTables)|_xmlsignatures/i.test(
        name,
      )
    )
      throw new Error("宏、外部连接、透视表、富数据或签名工作簿暂不编辑。");
    if (
      /\.xml$/.test(name) &&
      /<(?:\w+:)?(?:sheetProtection|workbookProtection)\b/.test(xml)
    )
      throw new Error("受保护工作簿暂不编辑。");
    for (const [tag, label] of [
      ["mergeCells", "merges"],
      ["conditionalFormatting", "conditional_formatting"],
      ["dataValidations", "validation"],
      ["definedName", "named_ranges"],
      ["table", "tables"],
      ["drawing", "drawings"],
      ["comments", "comments"],
    ])
      if (new RegExp(`<(?:\\w+:)?${tag}\\b`).test(xml)) features.add(label);
    if (/\/charts\//.test(name)) features.add("charts");
  }
  const sheets = sheetInfo(parts);
  for (const s of sheets) {
    walkXml(s.node, (n) => {
      if (n.name !== "c") return;
      const f = children(n, "f")[0],
        rich = children(children(n, "is")[0], "r").length;
      if (
        (f?.attrs.t || rich) &&
        (structural || cells.includes(`/${s.name}/${n.attrs.r}`))
      )
        throw new Error("本次不能修改共享／数组公式或富文字单元格。");
    });
    for (const m of children(children(s.node, "mergeCells")[0], "mergeCell")) {
      const [a, b] = m.attrs.ref.split(":"),
        start = a.match(/^([A-Z]+)(\d+)$/),
        end = (b ?? a).match(/^([A-Z]+)(\d+)$/);
      for (const target of cells.filter((p) =>
        p.startsWith("/" + s.name + "/"),
      )) {
        const r = target
          .split("/")
          .at(-1)
          .match(/^([A-Z]+)(\d+)$/);
        if (
          r &&
          start &&
          end &&
          numberOfColumn(r[1]) >= numberOfColumn(start[1]) &&
          numberOfColumn(r[1]) <= numberOfColumn(end[1]) &&
          Number(r[2]) >= Number(start[2]) &&
          Number(r[2]) <= Number(end[2]) &&
          r[0] !== a
        )
          throw new Error("合并区域只能修改左上角主单元格。");
      }
    }
  }
  if (structural && features.size)
    throw new Error(
      "整行整列增删当前限普通工作簿；合并、表对象、条件格式、验证、命名范围、图表等复杂结构仅支持保留结构的单元格编辑。",
    );
  return {
    features: [...features].sort(),
    mode: structural ? "plain_structure" : "preserve_existing_objects",
  };
}
function styleCheck(before, after) {
  if (!before.has("xl/styles.xml")) return;
  const a = parseXml(before.get("xl/styles.xml")),
    b = parseXml(after.get("xl/styles.xml"));
  for (const section of children(a)) {
    const next = children(b, section.name)[0];
    if (!next) failure("styles/" + section.name);
    for (const [i, item] of section.children.entries()) {
      if (typeof item === "string") continue;
      if (!next.children[i]) failure("styles/" + section.name);
      equal(item, next.children[i], "styles/" + section.name);
    }
  }
}
const styleCache = new WeakMap();
function styleOf(parts, index) {
  if (styleCache.has(parts))
    return styleCache.get(parts)[Number(index ?? 0)] ?? String(index ?? 0);
  if (!parts.has("xl/styles.xml")) return String(index ?? 0);
  const root = parseXml(parts.get("xl/styles.xml")),
    styles = children(children(root, "cellXfs")[0]).map(canonicalXml);
  styleCache.set(parts, styles);
  return styles[Number(index ?? 0)] ?? String(index ?? 0);
}
function cellStates(parts, sheet, plan) {
  const strings = parts.has("xl/sharedStrings.xml")
      ? children(parseXml(parts.get("xl/sharedStrings.xml")), "si")
      : [],
    out = new Map();
  for (const row of children(children(sheet.node, "sheetData")[0], "row"))
    for (const c of children(row, "c")) {
      const address =
        plan && sheet.name === plan.sheet
          ? mapAddress(c.attrs.r, plan)
          : c.attrs.r;
      if (!address) continue;
      const f = children(c, "f")[0],
        formula = f ? cloneXml(f) : undefined;
      if (formula && plan)
        formula.children = [rewriteFormula(textOf(formula), sheet.name, plan)];
      const raw = textOf(children(c, "v")[0]),
        str = c.attrs.t === "s" ? strings[Number(raw)] : children(c, "is")[0];
      const isText = ["s", "str", "inlineStr"].includes(c.attrs.t);
      let value = isText ? (str ? textOf(str) : raw) : raw;
      if (!isText && value !== "" && Number.isFinite(Number(value)))
        value = String(Number(value));
      const attrs = Object.fromEntries(
          Object.entries(c.attrs).filter(
            ([k]) => !["r", "s", "t"].includes(k) && !k.startsWith("xmlns"),
          ),
        ),
        rich = str && children(str, "r").length ? canonicalXml(str) : undefined;
      out.set(`/${sheet.name}/${address}`, {
        attrs,
        style: styleOf(parts, c.attrs.s),
        type: formula ? "formula" : isText ? "text" : (c.attrs.t ?? "number"),
        value: formula ? undefined : value,
        formula: formula ? canonicalXml(formula) : undefined,
        rich,
      });
    }
  return out;
}
const relationId = (n) =>
  Object.entries(n.attrs).find(([k]) => k.endsWith(":id"))?.[1];
function pruneRoot(parts, path, newParts, chartEdits, plan) {
  const root = parseXml(parts.get(path));
  const clean = (n) => {
    n.children = n.children.filter((c) => {
      if (typeof c === "string") return true;
      if (
        path === "docProps/core.xml" &&
        ["modified", "lastModifiedBy", "revision"].includes(c.name)
      )
        return false;
      if (
        path === "docProps/custom.xml" &&
        c.name === "property" &&
        c.attrs.name === "OfficeCLI.LastModified"
      )
        return false;
      if (path === "xl/workbook.xml" && c.name === "calcPr") return false;
      if (
        path === "[Content_Types].xml" &&
        c.name === "Override" &&
        (/(?:sharedStrings|calcChain)\.xml$/.test(c.attrs.PartName) ||
          newParts.has(c.attrs.PartName?.replace(/^\//, "")))
      )
        return false;
      if (path.endsWith(".rels") && c.name === "Relationship") {
        const rel = c.attrs.Target ?? "";
        if (/(?:sharedStrings|calcChain)\.xml$/.test(rel)) return false;
        const source = path.replace(/_rels\/([^/]+)\.rels$/, "$1");
        const target = relationships(parts, source).get(c.attrs.Id);
        if (newParts.has(target)) return false;
      }
      return true;
    });
    for (const c of children(n)) clean(c);
  };
  clean(root);
  return root;
}
function sheetMetadata(parts, sheet, plan, newParts) {
  const node = cloneXml(sheet.node),
    rels = relationships(parts, sheet.path);
  node.children = node.children.filter(
    (n) =>
      typeof n === "string" ||
      (!["sheetData", "dimension"].includes(n.name) &&
        !(n.name === "drawing" && newParts.has(rels.get(relationId(n))))),
  );
  if (plan && sheet.name === plan.sheet) {
    walkXml(node, (n) => {
      if (n.name === "autoFilter" && n.attrs.ref)
        n.attrs.ref = bandRange(n.attrs.ref, plan);
    });
    if (plan.axis === "column") {
      const cols = children(node, "cols")[0];
      if (cols)
        cols.children = children(cols).flatMap((c) => {
          const ref = bandRange(
            `${letterOfColumn(Number(c.attrs.min))}1:${letterOfColumn(Number(c.attrs.max))}1`,
            plan,
          );
          if (ref === "#REF!") return [];
          const [a, b] = ref.split(":");
          c.attrs.min = String(numberOfColumn(a.match(/[A-Z]+/)[0]));
          c.attrs.max = String(numberOfColumn(b.match(/[A-Z]+/)[0]));
          return [c];
        });
    }
  }
  return node;
}
function rowMetadata(sheet, plan) {
  return children(children(sheet.node, "sheetData")[0], "row").flatMap((r) => {
    const attrs = { ...r.attrs };
    if (plan && sheet.name === plan.sheet) {
      const next = mapAddress("A" + attrs.r, plan);
      if (!next) return [];
      attrs.r = next.match(/\d+/)[0];
    }
    return Object.keys(attrs).some((k) => k !== "r") ? [attrs] : [];
  });
}
function drawingPruned(parts, path, addedCharts, edits) {
  const root = parseXml(parts.get(path)),
    rels = relationships(parts, path);
  root.children = root.children.filter((anchor) => {
    if (typeof anchor === "string") return true;
    let chart;
    walkXml(anchor, (n) => {
      if (n.name === "chart") chart = rels.get(relationId(n));
    });
    if (addedCharts.has(chart)) return false;
    const edit = edits.find((e) => e.path === chart && e.props.anchor);
    if (edit)
      anchor.children = anchor.children.filter(
        (n) =>
          typeof n === "string" ||
          !["from", "to", "pos", "ext"].includes(n.name),
      );
    return true;
  });
  return root;
}
export function preserveWorkbook(
  before,
  after,
  { cells = [], structure, charts = [] } = {},
) {
  workbookSupport(before, { structural: !!structure, cells });
  const a = sheetInfo(before),
    b = sheetInfo(after);
  if (
    JSON.stringify(a.map((s) => [s.name, s.path])) !==
    JSON.stringify(b.map((s) => [s.name, s.path]))
  )
    failure("工作表顺序或关系");
  const newParts = new Set([...after.keys()].filter((p) => !before.has(p))),
    addedCharts = new Set(),
    edits = [];
  for (const s of a) {
    const old = chartFiles(before, s.name),
      next = chartFiles(after, s.name),
      requests = charts.filter((c) => c.sheet === s.name),
      added = requests.filter((c) => c.action === "add_chart");
    if (
      next.length !== old.length + added.length ||
      old.some((p, i) => next[i] !== p)
    )
      failure("图表数量或原图表身份");
    for (const p of next.slice(old.length)) addedCharts.add(p);
    for (const c of requests.filter((c) => c.action === "update_chart"))
      edits.push({ ...c, path: next[c.index - 1] });
  }
  for (const p of newParts)
    if (
      !["xl/sharedStrings.xml", "xl/calcChain.xml"].includes(p) &&
      !(
        charts.some((c) => c.action === "add_chart") &&
        (/^xl\/(?:drawings|charts)\//.test(p) ||
          /^xl\/worksheets\/_rels\//.test(p))
      )
    )
      failure("新增文件 " + p);
  styleCheck(before, after);
  const allowed = new Set(cells);
  for (const s of a) {
    const t = b.find((n) => n.name === s.name),
      old = cellStates(before, s, structure),
      next = cellStates(after, t);
    for (const [path, state] of old) {
      if (allowed.has(path)) {
        if (
          next.has(path) &&
          JSON.stringify(state.attrs) !== JSON.stringify(next.get(path).attrs)
        )
          failure(path + " 元数据");
        continue;
      }
      if (
        !next.has(path) ||
        JSON.stringify(state) !== JSON.stringify(next.get(path))
      )
        failure(path);
    }
    for (const [path, state] of next)
      if (
        !old.has(path) &&
        !allowed.has(path) &&
        (state.value || state.formula)
      )
        failure(path + " 额外内容");
    const actual = sheetMetadata(after, t, undefined, newParts),
      expected = sheetMetadata(before, s, structure, new Set());
    if (
      structure?.axis === "column" &&
      s.name === structure.sheet &&
      structure.insert
    ) {
      const cols = children(actual, "cols")[0];
      if (cols)
        cols.children = children(cols).filter(
          (c) =>
            !(
              Number(c.attrs.min) >= structure.index &&
              Number(c.attrs.max) < structure.index + structure.count
            ),
        );
    }
    for (const n of [expected, actual])
      n.children = n.children.filter(
        (c) => typeof c === "string" || c.name !== "cols" || children(c).length,
      );
    equal(expected, actual, s.path + " 排版和规则");
    let rows = rowMetadata(t);
    if (
      structure?.axis === "row" &&
      s.name === structure.sheet &&
      structure.insert
    )
      rows = rows.filter(
        (r) =>
          Number(r.r) < structure.index ||
          Number(r.r) >= structure.index + structure.count,
      );
    if (JSON.stringify(rowMetadata(s, structure)) !== JSON.stringify(rows))
      failure(s.path + " 行设置");
  }
  const sheetPaths = new Set(a.map((s) => s.path));
  for (const [path, value] of before) {
    if (
      sheetPaths.has(path) ||
      ["xl/styles.xml", "xl/sharedStrings.xml", "xl/calcChain.xml"].includes(
        path,
      )
    )
      continue;
    if (!after.has(path)) {
      if (path === "xl/calcChain.xml") continue;
      failure(path + " 丢失");
    }
    if (path.endsWith(".xml") || path.endsWith(".rels")) {
      if (/^xl\/(?:drawings\/)?charts\/chart\d+\.xml$/.test(path)) {
        const edit = edits.find((e) => e.path === path);
        {
          const x = parseXml(value),
            y = parseXml(after.get(path));
          const pruneCaches = (root) =>
            walkXml(root, (n) => {
              n.children = n.children.filter(
                (c) =>
                  typeof c === "string" ||
                  !["numCache", "strCache"].includes(c.name),
              );
            });
          pruneCaches(x);
          pruneCaches(y);
          if (!edit) {
            equal(x, y, path);
            continue;
          }
          const prune = (root) =>
            walkXml(root, (n) => {
              if (n.name === "chart" && edit.props.title !== undefined)
                n.children = n.children.filter(
                  (c) => typeof c === "string" || c.name !== "title",
                );
              if (n.name === "catAx" && edit.props.category_title !== undefined)
                n.children = n.children.filter(
                  (c) => typeof c === "string" || c.name !== "title",
                );
              if (n.name === "valAx") {
                if (edit.props.value_title !== undefined)
                  n.children = n.children.filter(
                    (c) => typeof c === "string" || c.name !== "title",
                  );
                for (const sc of children(n, "scaling"))
                  sc.children = sc.children.filter(
                    (c) =>
                      typeof c === "string" ||
                      !(
                        (c.name === "min" &&
                          edit.props.axismin !== undefined) ||
                        (c.name === "max" && edit.props.axismax !== undefined)
                      ),
                  );
              }
            });
          prune(x);
          prune(y);
          equal(x, y, path);
          continue;
        }
      }
      if (/^xl\/drawings\/drawing\d+\.xml$/.test(path)) {
        equal(
          drawingPruned(before, path, addedCharts, edits),
          drawingPruned(after, path, addedCharts, edits),
          path,
        );
        continue;
      }
      equal(
        pruneRoot(before, path, newParts, charts, structure),
        pruneRoot(after, path, newParts, charts),
        path,
      );
    } else if (
      before.rawHashes && after.rawHashes
        ? before.rawHashes.get(path) !== after.rawHashes.get(path)
        : value !== after.get(path)
    )
      failure(path);
  }
  return {
    preserved: true,
    scope: "cells_and_existing_package_objects",
    features: workbookSupport(before).features,
    protected_existing_parts: before.size,
  };
}
