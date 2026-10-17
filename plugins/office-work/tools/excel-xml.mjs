// Small read-only XML helpers for bounded OOXML preservation checks.
export const decodeXml = (s) =>
  s.replace(/&#(x[0-9a-f]+|\d+);|&(amp|lt|gt|quot|apos);/gi, (_, n, k) =>
    n
      ? String.fromCodePoint(
          n[0].toLowerCase() === "x" ? parseInt(n.slice(1), 16) : Number(n),
        )
      : { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[k],
  );
const local = (s) => s.split(":").at(-1);
export function parseXml(xml) {
  if (typeof xml !== "string" || /<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new Error("不支持此 XML 文件结构。");
  const root = { name: "#root", children: [], ns: {} },
    stack = [root];
  let count = 0;
  for (const token of xml.match(
    /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<(?:[^<>"']|"[^"]*"|'[^']*')+>|[^<]+/g,
  ) ?? []) {
    if (++count > 250000 || stack.length > 64)
      throw new Error("工作簿结构过大或过深。");
    if (token.startsWith("<!--") || token.startsWith("<?")) continue;
    const parent = stack.at(-1);
    if (token.startsWith("</")) {
      if (
        stack.length === 1 ||
        stack.at(-1).qname !== token.slice(2, -1).trim()
      )
        throw new Error("XML 节点不完整。");
      stack.pop();
      continue;
    }
    if (token.startsWith("<") && !token.startsWith("<![")) {
      const q = token.match(/^<([\w:.-]+)/)?.[1];
      if (!q) throw new Error("XML 节点无效。");
      const attrs = Object.fromEntries(
        [
          ...token
            .slice(q.length + 1)
            .matchAll(/([\w:.-]+)\s*=\s*(["'])(.*?)\2/gs),
        ].map((m) => [m[1], decodeXml(m[3])]),
      );
      const ns = { ...parent.ns };
      for (const [k, v] of Object.entries(attrs))
        if (k === "xmlns") ns[""] = v;
        else if (k.startsWith("xmlns:")) ns[k.slice(6)] = v;
      const expand = (name, attr = false) => {
        const prefix = name.includes(":") ? name.split(":")[0] : "";
        return !prefix && attr
          ? name
          : ns[prefix]
            ? `{${ns[prefix]}}${local(name)}`
            : name;
      };
      const node = {
        name: local(q),
        qname: q,
        full: expand(q),
        attrs,
        attrNames: Object.fromEntries(
          Object.keys(attrs).map((k) => [k, expand(k, true)]),
        ),
        ns,
        children: [],
      };
      parent.children.push(node);
      if (!token.endsWith("/>")) stack.push(node);
    } else {
      const value = token.startsWith("<![CDATA[")
        ? token.slice(9, -3)
        : decodeXml(token);
      if (value.trim() || parent.name === "t") {
        if (typeof parent.children.at(-1) === "string")
          parent.children[parent.children.length - 1] += value;
        else parent.children.push(value);
      }
    }
  }
  if (
    stack.length !== 1 ||
    root.children.filter((n) => typeof n !== "string").length !== 1
  )
    throw new Error("XML 文件不完整。");
  return root.children.find((n) => typeof n !== "string");
}
export const children = (node, name) =>
  node?.children?.filter(
    (n) => typeof n !== "string" && (!name || n.name === name),
  ) ?? [];
export const textOf = (node) =>
  typeof node === "string" ? node : (node?.children ?? []).map(textOf).join("");
export function cloneXml(node) {
  return structuredClone(node);
}
export function canonicalXml(node) {
  const pack = (n) =>
    typeof n === "string"
      ? n
      : [
          n.full,
          Object.entries(n.attrs)
            .filter(([k]) => k !== "xmlns" && !k.startsWith("xmlns:"))
            .map(([k, v]) => [n.attrNames[k] ?? k, v])
            .sort(([a], [b]) => a.localeCompare(b)),
          n.children.map(pack),
        ];
  return JSON.stringify(pack(node));
}
export function walkXml(node, visit) {
  if (typeof node === "string") return;
  visit(node);
  for (const n of node.children) walkXml(n, visit);
}
import { posix } from "node:path";
export function relationships(parts, source) {
  const name = posix.join(
      posix.dirname(source),
      "_rels",
      posix.basename(source) + ".rels",
    ),
    out = new Map();
  if (!parts.has(name)) return out;
  for (const r of children(parseXml(parts.get(name)), "Relationship")) {
    if (r.attrs.TargetMode === "External") continue;
    const target = r.attrs.Target?.startsWith("/")
      ? r.attrs.Target.slice(1)
      : posix.normalize(
          posix.join(posix.dirname(source), r.attrs.Target ?? ""),
        );
    if (!target || target.startsWith("../") || !parts.has(target))
      throw new Error("工作簿关系指向缺失的文件。");
    out.set(r.attrs.Id, target);
  }
  return out;
}
export function sheetInfo(parts) {
  const root = parseXml(parts.get("xl/workbook.xml")),
    rels = relationships(parts, "xl/workbook.xml");
  return children(children(root, "sheets")[0], "sheet").map((n) => {
    const id = Object.entries(n.attrs).find(([k]) => k.endsWith(":id"))?.[1],
      path = rels.get(id);
    if (!path) throw new Error("工作表关系不完整。");
    return { name: n.attrs.name, path, node: parseXml(parts.get(path)) };
  });
}
export function chartFiles(parts, sheet) {
  const root = sheetInfo(parts).find((s) => s.name === sheet);
  if (!root) throw new Error("图表工作表不存在。");
  const rels = relationships(parts, root.path),
    out = [];
  for (const d of children(root.node, "drawing")) {
    const path = rels.get(
      Object.entries(d.attrs).find(([k]) => k.endsWith(":id"))?.[1],
    );
    if (!path) throw new Error("图表绘图关系不完整。");
    const drawing = parseXml(parts.get(path)),
      links = relationships(parts, path);
    walkXml(drawing, (n) => {
      if (n.name === "chart") {
        const target = links.get(
          Object.entries(n.attrs).find(([k]) => k.endsWith(":id"))?.[1],
        );
        if (!target) throw new Error("图表文件关系不完整。");
        out.push(target);
      }
    });
  }
  return out;
}
export function chartAnchors(parts, sheet) {
  const s = sheetInfo(parts).find((s) => s.name === sheet);
  if (!s) throw new Error("工作表不存在。");
  const links = relationships(parts, s.path),
    out = [];
  for (const d of children(s.node, "drawing")) {
    const path = links.get(
        Object.entries(d.attrs).find(([k]) => k.endsWith(":id"))?.[1],
      ),
      rels = relationships(parts, path);
    for (const anchor of children(parseXml(parts.get(path)))) {
      let chart;
      walkXml(anchor, (n) => {
        if (n.name === "chart")
          chart = rels.get(
            Object.entries(n.attrs).find(([k]) => k.endsWith(":id"))?.[1],
          );
      });
      if (chart) out.push({ path: chart, anchor });
    }
  }
  return out;
}
