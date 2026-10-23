import { randomUUID } from 'node:crypto';
import { realpathSync, lstatSync, openSync, writeFileSync, closeSync, fsyncSync, linkSync, unlinkSync, renameSync } from 'node:fs';
import { resolve, relative, isAbsolute, dirname, basename, join } from 'node:path';
import { bounded, fail } from './validation.mjs';

const inside = (root, path) => { const part = relative(root, path); return part !== '' && !isAbsolute(part) && part !== '..' && !part.startsWith('..\\') && !part.startsWith('../'); };
function targetPath(workspaceRoot, path, overwrite) {
  const root = realpathSync(workspaceRoot), target = resolve(root, path);
  if (path.includes('\0') || !inside(root, target) || /(^|[\\/])\.\.([\\/]|$)/u.test(path) || /[:*?"<>|]/u.test(isAbsolute(path) ? path.slice(parseDriveLength(path)) : path)) fail('unsafe_path', 'Export must stay within the workspace');
  const part = relative(root, target).split(/[\\/]/u);
  let current = root;
  for (let index = 0; index < part.length; index++) {
    current = join(current, part[index]);
    try {
      const info = lstatSync(current);
      if (info.isSymbolicLink() || (index < part.length - 1 && !info.isDirectory())) fail('unsafe_path', 'Export cannot traverse symbolic links or non-directories');
      if (index === part.length - 1 && (!overwrite || !info.isFile())) fail('file_exists', 'The export file already exists');
    } catch (error) { if (error.code !== 'ENOENT') throw error; if (index !== part.length - 1) fail('unsafe_path', 'Export parent directory must already exist'); }
  }
  if (realpathSync(dirname(target)) !== dirname(target)) fail('unsafe_path', 'Export parent must be a real workspace directory');
  return target;
}
const parseDriveLength = path => /^[A-Za-z]:/u.test(path) ? 2 : 0;
const markdownText = text => text.replace(/[\\`*_{}\[\]<>#]/gu, '\\$&').replace(/\r?\n/gu, ' ');
export function exportDocument(document, input, workspaceRoot) {
  const target = targetPath(workspaceRoot, input.path, input.overwrite === true);
  const text = input.format === 'json' ? JSON.stringify(document, null, 2) + '\n' : '# ' + markdownText(document.title) + '\n\n' + document.entries.map(entry => `## ${entry.date} — ${markdownText(entry.title)}\n\n${entry.notes}\n${entry.place ? `\nPlace: ${markdownText(entry.place.name)}, ${markdownText(entry.place.country)} (${entry.place.timezone})\n` : ''}`).join('\n');
  bounded({ text });
  const temporary = join(dirname(target), '.' + basename(target) + '.' + randomUUID() + '.tmp');
  let fd, published = false;
  try {
    fd = openSync(temporary, 'wx', 0o600); writeFileSync(fd, text, 'utf8'); fsyncSync(fd); closeSync(fd); fd = undefined;
    // A hard link publishes the complete file atomically and refuses an existing target.
    // Unlike rename, this cannot replace a file created after our checks.
    // Recheck every path component immediately before publication as well.
    targetPath(workspaceRoot, input.path, input.overwrite === true);
    if (input.overwrite === true) renameSync(temporary, target); else linkSync(temporary, target);
    published = true;
  } catch (error) { if (error.code === 'EEXIST') fail('file_exists', 'The export file already exists'); throw error; }
  finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); }
    catch (error) {
      if (error.code !== 'ENOENT') {
        if (published) fail('operation_outcome_unknown', 'The file was published, but export cleanup failed. Query the original operation ID; do not replay the export.');
        throw error;
      }
    }
  }
  return { kind: 'export', operationId: input.operationId, saved: true, path: target, revision: document.revision };
}
