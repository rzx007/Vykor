import {createRequire} from "node:module";
import {spawn} from "node:child_process";
import {dirname,resolve} from "node:path";
import {fileURLToPath} from "node:url";
const here=dirname(fileURLToPath(import.meta.url));
const repo=resolve(here,"../../..");
const req=createRequire(resolve(repo,"apps/desktop/package.json"));
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(req("electron"),[resolve(here,"capture-product.cjs")],{env,windowsHide:true,stdio:["ignore","pipe","inherit"]});
let completed=false;
let output="";
child.stdout.on("data",data=>{
  process.stdout.write(data);
  output+=data.toString();
  if(!completed && output.includes('"captureComplete":true')) {
    completed=true;
    // Some Windows software-rendering processes linger after app.exit().
    // Terminate only this isolated helper once all output files are written.
    setTimeout(()=>child.kill(),5000).unref();
  }
  output=output.slice(-2000);
});
const watchdog=setTimeout(()=>child.kill(),170000);
watchdog.unref();
child.on("error",error=>{console.error(error);process.exitCode=1});
child.on("exit",code=>{clearTimeout(watchdog);process.exitCode=completed?0:(code??1)});

