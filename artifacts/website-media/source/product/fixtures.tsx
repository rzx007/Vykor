/** Real Vykor renderer + disclosed sample data. No provider or user profile is accessed. */
import { createRoot } from "react-dom/client"
import { sampleData } from "./sample-data"
import "./capture.css"

const current = new URLSearchParams(location.search).get("scene") || "workspace"
const scenario = sampleData.scenarios.find(s => s.id === current) || sampleData.scenarios[0]
const timestamp = 1792540800000
const project = sampleData.project
const records = sampleData.scenarios.map((s, i) => ({
  id: "media-" + s.id, projectId: project.id, cwd: project.path, workspaceMode: "project",
  title: s.title, model: "demo-model", status: "idle",
  metadata: { example: true }, createdAt: timestamp - i * 60000, updatedAt: timestamp - i * 60000
}))
const record = records.find(s => s.id === "media-" + scenario.id)!
const view = {
  cursor: 4, syncStatus: "connected", session: record, inputs: [], runs: [], tasks: [], permissions: [],
  messages: [
    {id:"demo-user", sessionId:record.id, seq:1, role:"user", metadata:{example:true}, createdAt:timestamp, updatedAt:timestamp},
    {id:"demo-assistant", sessionId:record.id, seq:2, role:"assistant", metadata:{example:true}, createdAt:timestamp+1000, updatedAt:timestamp+1000}
  ],
  parts: [
    {id:"demo-prompt",sessionId:record.id,messageId:"demo-user",seq:1,type:"text",status:"completed",text:scenario.prompt,metadata:{example:true},createdAt:timestamp,updatedAt:timestamp},
    {id:"demo-answer",sessionId:record.id,messageId:"demo-assistant",seq:2,type:"text",status:"completed",text:scenario.text,metadata:{example:true},createdAt:timestamp+1000,updatedAt:timestamp+1000}
  ]
}
const model = {id:"demo-model",label:"示例模型",provider:"演示",providerName:"demo"}
const daemon = {phase:"ready",message:"素材演示环境",updatedAt:timestamp}
const bootstrap = {connected:true,projects:[project],sessions:records,archivedSessions:[],models:[model],defaultModel:model.id,defaultProvider:"demo",defaultPermissionMode:"ask",outsideProjectWorkspaceRoot:project.path,attachments:{daemonSupported:false,interactionEnabled:false,uploadModes:[],limits:null}}
const diagnostics: string[] = []
const noop = () => {}
const preview = (path:string) => ({
  path,name:path.split("/").pop(),relativePath:path,rootLabel:project.name,language:path.endsWith(".tsx")?"tsx":"markdown",size:0,binary:false,
  content:sampleData.fileContents[path as keyof typeof sampleData.fileContents] || "",scope:"project",previewBytes:null,mediaType:null,imagePreviewError:null
})
const results: Record<string, (...args:any[]) => any> = {
  "app.getPlatform":()=>"win32", "app.getInfo":()=>({name:"Vykor",version:"1.2.20",platform:"win32"}),
  "window.isMaximized":()=>false,"window.getZoomLevel":()=>0,
  "window.getMaterial":()=>null,
  "window.getMaterialState":()=>null,"window.getMaterialSnapshot":()=>null,
  "sessions.bootstrap":()=>bootstrap,"sessions.daemonStatus":()=>daemon,
  "sessions.open":()=>view,"sessions.inspectProject":()=>({project,git:false,branch:null,branches:[]}),
  "sessions.getContextUsage":()=>null,"sessions.getGoal":()=>null,
  "sessions.getRuntimeConfig":()=>({model:"demo-model",provider:"demo",permissionMode:"ask",workMode:"build"}),
  "sessions.listCommands":()=>[],"sessions.listContextPlugins":()=>[],
  "activity.open":()=>({cursor:0,delivery:"baseline",sessions:[],scheduled:[]}),
  "updates.getState":()=>({phase:"idle",status:"idle"}),
  "workspace.readFile":(input:any)=>preview(input.path),
  "workspace.listDirectory":()=>({root:project.path,path:".",entries:[]}),
  "workspace.listFiles":()=>({rootPath:project.path,entries:[]}),
  "settings.snapshot":()=>({notificationMode:"off"}),
  "daemonAutoStart.snapshot":()=>({onboardingRequired:false,enabled:false}),
  "workspace.isGitRepository":()=>false,"git.probe":()=>({isGitRepository:false}),
  "plugins.list":()=>[],"pluginApps.catalog":()=>[],
  "daemonAutostart.getStatus":()=>({enabled:false,available:false,identity:"existing"}),
}
function bridge(path:string[]=[]):any {
  return new Proxy(()=>{}, {
    get(_target,key) {
      if(key === "then") return undefined
      if(typeof key === "symbol") return undefined
      if(path.join(".") === "window" && key === "material") return null
      return bridge([...path,String(key)])
    },
    apply(_target,_this,args) {
      const name = path.join(".")
      if(/^on[A-Z]/.test(path[path.length-1])) return noop
      if(name === "window.getMaterialSnapshot" || name === "window.getMaterialState") return null
      if(name === "platform") return "win32"
      if(results[name]) return Promise.resolve(results[name](...args))
      diagnostics.push(name)
      if(/list|commands|catalog|branches|fonts/i.test(name)) return Promise.resolve([])
      return Promise.resolve(null)
    }
  })
}
Object.defineProperty(window,"desktop",{value:bridge(),configurable:true})
localStorage.clear()
localStorage.setItem("vykor-desktop-appearance-v1",JSON.stringify({
  version:1,theme:"dark",accent:{kind:"preset",id:"neutral"},
  colors:{light:{background:null,foreground:null},dark:{background:null,foreground:null}},
  uiFont:"system",codeFont:"geist-mono",uiFontSize:14,codeFontSize:14,reducedMotion:"on",glassStrength:0
}))
const { useDesktopSessionStore } = await import("@renderer/stores/desktop-session")
const { writeUtilityPanelViewStates, writeUtilityPanelRuntimeState } = await import("@renderer/components/desktop/layout/main-layout/utility-panel/utility-panel-repository")
const scope = "session:" + record.id
if(scenario.file) {
  const file = preview(scenario.file)
  writeUtilityPanelViewStates({[scope]:{open:true,maximized:false,layout:{conversation:49,utility:51}}})
  writeUtilityPanelRuntimeState(scope,{
    tabs:[{id:"demo-file",tool:"files",title:file.name,filePath:scenario.file,fileType:scenario.file.endsWith(".tsx")?"code":"markdown",projectPath:project.path}],
    browserTabs:[],fileTabs:[{preview:file,type:scenario.file.endsWith(".tsx")?"code":"markdown",projectPath:project.path}],
    fileProjectPath:project.path,activeFilePath:scenario.file,loadingFilePath:null,activeTabId:"demo-file",terminalMounted:false,
    handledFileRequestId:null,handledToolRequestId:null,handledImageRequestId:null,handledTerminalRequestId:null
  } as any)
}
useDesktopSessionStore.setState({
  loadStatus:"ready",daemonStatus:daemon,projects:[project],sessions:records,archivedSessions:[],models:[model],
  activeSessionId:record.id,sessionView:view,selectedProject:project,selectedProjectGit:false,selectedProjectGitCheckedAt:Date.now(),
  selectedModel:model.id,selectedProvider:"demo",defaultModel:model.id,defaultProvider:"demo",selectedPermissionMode:"ask",
  workspaceMode:"project",outsideProjectWorkspaceRoot:project.path,branches:[],initialize:async()=>{},
} as any)
location.hash = "/conversation/" + record.id
const [{default:App},{AppearanceProvider},{TooltipProvider}] = await Promise.all([
  import("@renderer/App"),
  import("@renderer/components/appearance/appearance-provider"),
  import("@renderer/components/ui/tooltip")
])
createRoot(document.getElementById("root")!).render(<AppearanceProvider><TooltipProvider><App/></TooltipProvider></AppearanceProvider>)
document.documentElement.dataset.mediaExample = "true"
window.addEventListener("error",e => diagnostics.push("ERROR: "+e.message))
window.addEventListener("unhandledrejection",e => diagnostics.push("ERROR: "+String(e.reason)))
setTimeout(()=>{
  ;(window as any).__VYKOR_MEDIA__={ready:true,scenario:scenario.id,diagnostics,text:document.body.innerText}
},1500)

