import { spawn } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export const ENGINE_SHA256 = '864e0580c8e8c91a6aa4a4c1e8900551c8d4aa648ff10136ceed3a6ba5310888';
// Two bounded close attempts plus directory removal must fit the host's deadline.
export const CLEANUP_RESERVE_MS = 14000;
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const checked = new Map();

export async function engine(context) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('首版仅支持 Windows x64。');
  const binary = await realpath(join(context.plugin.root, 'bin/officecli-win-x64.exe')).catch(() => { throw new Error('插件缺少 OfficeCLI；请重新导入包含引擎的完整 ZIP。'); });
  if (!checked.has(binary)) {
    if (hash(await readFile(binary)) !== ENGINE_SHA256) throw new Error('OfficeCLI 校验失败，请重新安装插件。');
    checked.set(binary, true);
  }
  return createRunner(binary,context);
}

export function createRunner(binary,context) {
  return async (args, operations, closing = false) => {
    const timeout = closing
      ? Math.min(4000,context.deadline-Date.now()-500)
      : Math.min(20000,context.deadline-Date.now()-CLEANUP_RESERVE_MS);
    if (timeout <= 0 || (!closing && context.signal.aborted)) throw new Error('操作已取消或超时。');
    return new Promise((resolve, reject) => {
      const child = spawn(binary, args, { cwd: context.cwd, windowsHide: true, shell: false,
        env: { ...process.env, OFFICECLI_SKIP_UPDATE: '1' }, stdio: ['pipe','pipe','pipe'] });
      let output = '', errors = '', bytes = 0, failure, killing=false;
      const kill = () => {
        if (killing) return;
        killing=true;
        if (child.pid) {
          // Kill this command's tree only; never other sessions' OfficeCLI processes.
          const killer = spawn(join(process.env.SystemRoot || 'C:\\Windows', 'System32/taskkill.exe'), ['/PID',String(child.pid),'/T','/F'], {windowsHide:true,stdio:'ignore'});
          const fallback=setTimeout(()=>child.kill(),1500);
          const finish=()=>{clearTimeout(fallback);child.kill();};
          killer.once('error',finish);killer.once('close',finish);
          return;
        }
        child.kill();
      };
      const abort = () => { failure = new Error('OfficeCLI 操作取消。'); kill(); };
      const timer = setTimeout(() => {
        failure = Object.assign(new Error(closing?'OfficeCLI 关闭工作副本超时。':'OfficeCLI 操作超时。'),{code:closing?'office_close_timeout':'office_command_timeout'});
        kill();
      }, timeout);
      const cleanup = () => { clearTimeout(timer); context.signal.removeEventListener('abort',abort); };
      if (!closing) context.signal.addEventListener('abort',abort,{once:true});
      if (!closing&&context.signal.aborted) abort();
      const collect = (chunk, stderr) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 512000) { failure = new Error('OfficeCLI 返回过大；请按单页或元素读取。'); kill(); return; }
        if (stderr) errors += chunk.toString('utf8'); else output += chunk.toString('utf8');
      };
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data',c=>collect(c,false)); child.stderr.on('data',c=>collect(c,true));
      child.on('error',e=>{ cleanup(); reject(e); });
      child.stdin.on('error',e=>{ failure=e; kill(); });
      child.on('close',code=>{ cleanup(); if (failure || code !== 0) reject(failure || new Error((errors || output || `OfficeCLI exit ${code}`).slice(0,4000))); else resolve(output); });
      // ASCII JSON avoids Windows hidden-process UTF-8 stdin corruption.
      child.stdin.end(operations ? JSON.stringify(operations).replace(/[\u007f-\uffff]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')) : undefined);
    });
  };
}
