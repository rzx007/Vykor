import {mkdtemp,rm,access} from 'node:fs/promises';
import {dirname,join,extname} from 'node:path';
import {markWorkingFile} from './lock-recovery.mjs';

async function exists(file) {try{await access(file);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}

export async function withWorkingFile(file,run,context,operation,remove=rm) {
  const temp=await mkdtemp(join(dirname(file),'.office-work-')), work=join(temp,'working'+extname(file).toLowerCase());
  let closed=false, closeAttempts=0, closeError, result, failure;
  const close=async()=>{
    if (closed) return;
    if (!await exists(work)) {closed=true;return;}
    while(closeAttempts<2 && Date.now()<context.deadline-500) {
      closeAttempts++;
      try {await run(['close',work],undefined,true);closed=true;return;}
      catch(error) {closeError=error;}
    }
    throw closeError||new Error('关闭工作副本的剩余时间不足。');
  };
  try {await markWorkingFile(file,temp);result=await operation(work,close);}catch(error){failure=error;}
  try {await close();}
  catch(error) {
    const primary=failure?`${failure.message} `:'';
    throw Object.assign(new Error(`${primary}工作副本关闭失败：${error.message} 临时目录保留在：${temp}`),{
      code:'office_cleanup_failed',temporary_directory:temp,cleanup_complete:false,
    });
  }
  try {await remove(temp,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
  catch(error) {
    if (failure) throw Object.assign(new Error(`${failure.message} 临时目录清理失败：${error.message}；保留在：${temp}`),{code:'office_cleanup_failed',temporary_directory:temp,cleanup_complete:false});
    // A file may already have been published. Never turn that success into a
    // retryable write error merely because deleting its private copy failed.
    return {...result,cleanup_complete:false,temporary_directory:temp,cleanup_warning:`操作已完成，但临时目录清理失败：${error.message}；保留在：${temp}`};
  }
  if (failure) throw failure;
  return {...result,cleanup_complete:true};
}
