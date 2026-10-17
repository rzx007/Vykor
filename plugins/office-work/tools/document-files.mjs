import {
  access,
  mkdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  resolve,
  relative,
  dirname,
  basename,
  join,
  extname,
  isAbsolute,
} from "node:path";
import { hash } from "./engine.mjs";

export const exists = async (path) => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};
export function under(root, path) {
  const rel = relative(root, path);
  return !rel.startsWith("..") && !isAbsolute(rel);
}
export async function filePath(
  context,
  raw,
  output = false,
  extension = ".pptx",
) {
  if (
    typeof raw !== "string" ||
    !raw ||
    raw.length > 1000 ||
    extname(raw).toLowerCase() !== extension
  )
    throw new Error(`仅支持工作区内的 ${extension} 路径。`);
  const cwd = await realpath(context.cwd),
    requested = resolve(cwd, raw);
  if (!under(cwd, requested)) throw new Error("文件须位于当前工作区。");
  if (await exists(requested)) {
    const actual = await realpath(requested);
    if (!under(cwd, actual)) throw new Error("文件链接指向工作区之外。");
    const info = await stat(actual);
    if (!info.isFile() || info.size > 64 * 1024 * 1024)
      throw new Error("仅支持不超过 64 MB 的 Office 文件。");
    return actual;
  }
  if (!output) throw new Error("文件不存在。");
  let ancestor = dirname(requested);
  while (!(await exists(ancestor))) ancestor = dirname(ancestor);
  if (!under(cwd, await realpath(ancestor)))
    throw new Error("输出目录链接指向工作区之外。");
  await mkdir(dirname(requested), { recursive: true });
  return join(await realpath(dirname(requested)), basename(requested));
}
const recordPath = (context, file) =>
  join(
    context.plugin.dataDir,
    extname(file).toLowerCase() === ".docx" ? "documents" : extname(file).toLowerCase() === ".xlsx" ? "spreadsheets" : "presentations",
    `${hash(file.toLowerCase())}.json`,
  );
export async function currentReceipt(context, file, sha256) {
  try {
    const record = JSON.parse(
      await readFile(recordPath(context, file), "utf8"),
    );
    return record.path === file &&
      record.cwd === (await realpath(context.cwd)) &&
      record.sha256 === sha256
      ? record
      : undefined;
  } catch {
    return undefined;
  }
}
export async function known(context, file) {
  try {
    const record = JSON.parse(
      await readFile(recordPath(context, file), "utf8"),
    );
    return record.path === file && record.cwd === (await realpath(context.cwd));
  } catch {
    return false;
  }
}
export async function receipt(context, file, sha256, checks = {}) {
  const result = {
    path: file,
    sha256,
    structure_checked: true,
    visual_checked: false,
    ...checks,
  };
  try {
    const path = recordPath(context, file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        ...result,
        cwd: await realpath(context.cwd),
        updated_at: new Date().toISOString(),
      }),
    );
  } catch {
    result.warning = "文件已保存，但当前成果记录保存失败；后续编辑会另存副本。";
  }
  return result;
}
