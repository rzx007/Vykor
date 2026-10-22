const {app,BrowserWindow,session}=require("electron");
const fs=require("node:fs");
const path=require("node:path");
const os=require("node:os");
const source=__dirname;
const target=path.resolve(source,"../product");
fs.mkdirSync(target,{recursive:true});
const profile=fs.mkdtempSync(path.join(os.tmpdir(),"vykor-media-capture-"));
app.setPath("userData",profile);
app.setPath("sessionData",profile);
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("force-device-scale-factor","1.5");
app.commandLine.appendSwitch("autoplay-policy","no-user-gesture-required");
let deadline=setTimeout(()=>app.exit(2),150000);
const delay=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 await app.whenReady();
 session.defaultSession.webRequest.onBeforeRequest({urls:["http://*/*","https://*/*"]},(_details,done)=>done({cancel:true}));
 const win=new BrowserWindow({show:false,width:1920,height:1080,useContentSize:true,backgroundColor:"#161816",webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});
 win.webContents.setFrameRate(30);
 const logs=[];
 win.webContents.on("console-message",(_event,level,message)=>{if(level>=2)logs.push(message)});
 const manifest={kind:"actual Vykor desktop components rendered with disclosed example data",notEndToEndRecording:true,privateUserDataAccessed:false,providerRequests:false,viewport:[1920,1080],scaleFactor:1.5,scenarios:[]};
 for(const scene of ["workspace","coding","research","document"]){
   await win.loadFile(path.resolve(source,"../product-renderer/index.html"),{query:{scene}});
   let state=null;
   for(let i=0;i<40;i++){
     await delay(250);
     state=await win.webContents.executeJavaScript("window.__VYKOR_MEDIA__ || null");
     if(state?.ready) break;
   }
   await delay(scene==="coding"?5000:700);
   if(!state?.ready || state.diagnostics.some(item=>item.startsWith("ERROR:")) || state.text.trim().length<80) {
     fs.writeFileSync(path.join(target,"capture-errors.json"),JSON.stringify({logs,state},null,2));
     throw new Error("Product renderer did not become ready: "+scene+" "+logs.slice(-3).join(" | "));
   }
   const image=await win.webContents.capturePage();
   const filename="vykor-"+scene+".png";
   fs.writeFileSync(path.join(target,filename),image.toPNG());
   manifest.scenarios.push({scene,file:filename,size:image.getSize(),diagnostics:state.diagnostics,text:state.text});
   console.log(JSON.stringify({captured:filename,size:image.getSize(),diagnostics:state.diagnostics}));
 }
 manifest.consoleErrors=logs;
 fs.writeFileSync(path.join(target,"product-manifest.json"),JSON.stringify(manifest,null,2));
 console.log(JSON.stringify({captureComplete:true,scenarios:manifest.scenarios.length}));
 win.destroy();clearTimeout(deadline);app.exit(0);
})().catch(error=>{console.error(error);clearTimeout(deadline);app.exit(1)});

