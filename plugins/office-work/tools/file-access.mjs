import { open, rm, access } from 'node:fs/promises';
import { join, dirname, basename, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CLEANUP_RESERVE_MS } from './engine.mjs';
import {newLockOwner,trackLock,releaseLock,recoverAbandonedLock,recoverWorkingCopies} from './lock-recovery.mjs';

export async function assertFileAvailable(file) {
  const owner=join(dirname(file),'~$'+basename(file));
  try { await access(owner); }
  catch (error) { if (error.code==='ENOENT') return; throw error; }
  throw Object.assign(new Error('检测到 Office 占用标记。请关闭 Word/Excel/PowerPoint/WPS 中的此文件后重试；若已关闭，请先确认标记是否残留，不要反复自动重试或删除占用标记。'),{code:'office_file_in_use'});
}

// Sidecar locks coordinate both parallel calls and separate plugin hosts.
// Only confirmed dead, registered owners are eligible for restart recovery.
export async function withFiles(files, context, operation, recover=recoverAbandonedLock) {
  const paths=[...new Set(files.map(file=>process.platform==='win32'?resolve(file).toLowerCase():resolve(file)))].sort();
  const held=[];
  try {
    for (const file of paths) {
      let recoveryError;
      while (true) {
        if (context.signal.aborted) throw new Error('等待办公操作时已取消。');
        if (Date.now()>=context.deadline-CLEANUP_RESERVE_MS) throw recoveryError??Object.assign(new Error('同文件操作仍然繁忙，等待已到期限。请等待前一操作结束；若曾异常退出，先确认进程状态，不要自动删除锁。'),{code:'office_file_busy'});
        try {
          const path=file+'.office-work.lock',handle=await open(path,'wx'),owner=newLockOwner(file);
          try {await handle.writeFile(JSON.stringify(owner));}
          catch(error){await handle.close();await rm(path,{force:true});throw error;}
          held.push({file,path,handle,owner});trackLock(file,owner);break;
        }
        catch (error) { if (error.code!=='EEXIST') throw error; }
        recoveryError=undefined;
        try {if(await recover(file,context))continue;}
        catch(error){if(error.code!=='office_recovery_required'||error.temporary_directory)throw error;recoveryError=error;}
        try { await delay(Math.min(100,Math.max(1,context.deadline-Date.now()-CLEANUP_RESERVE_MS)),undefined,{signal:context.signal}); }
        catch { throw new Error('等待办公操作时已取消。'); }
      }
    }
    for(const lock of held)await recoverWorkingCopies(lock.file,context);
    return await operation();
  } finally {
    for (const lock of held.reverse()) {
      trackLock(lock.file,null);
      try { await lock.handle.close(); } finally { await releaseLock(lock.path,lock.owner); }
    }
  }
}

export function operationError(error) {
  if (error.code==='office_recovery_required') return {code:error.code,error:error.message,requires_user_action:true,...(error.temporary_directory?{temporary_directory:error.temporary_directory}:{} )};
  if (error.code==='office_cleanup_failed') return {code:error.code,error:error.message,cleanup_complete:false,temporary_directory:error.temporary_directory,requires_user_action:true};
  if (error.code==='office_file_in_use'||error.code==='office_file_busy') return {code:error.code,error:error.message,requires_user_action:true};
  if (['EBUSY','EPERM','EACCES'].includes(error.code)||/being used by another process|used by another process|sharing violation|另一进程|另一个进程/i.test(error.message)) {
    return {code:'office_file_unavailable',error:'文件可能被 Word/Excel/PowerPoint/WPS 或其他程序占用，或目录没有访问权限。请关闭此文件并确认目录权限后重试；源文件未被强制覆盖。',requires_user_action:true};
  }
  return {error:error.message};
}
