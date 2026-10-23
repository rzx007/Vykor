import { NodeRunCatalogue } from "../../capabilities/node-run-catalogue.js";
import { createCapturedSkillCatalog } from "@vykor/tools";
import { QueryEngine, ToolRegistry, createAgentSession } from "@vykor/core";
import { createAssembledAgent } from "../agent.js";
import { NodeRuntimeResources } from "../../runtime/node-runtime-resources.js";
import { NodeChildManager } from "../../children/node-child-manager.js";
import { AgentChildRegistry } from "../../../kernel/children/child-registry.js";
import { AgentEventBus } from "../../../kernel/event-source.js";
export function createFixtureRuntime(options:any):any {
 const registry=new ToolRegistry();for(const tool of options.tools??[])registry.register(tool,["Skill","ListSkills"].includes(tool.name)?{kind:"builtin"}:{kind:"runtime"});
 const checker={checkTool:async()=>({action:"ask" as const,reason:"Kernel host approval is required"})};
 const hooks={register(){},getAll:()=>[],execute:async()=>({blocked:false})};
 const engine=new QueryEngine(options.client,registry,checker,hooks,{...options,settings:undefined,model:options.model??options.settings?.model,maxTurns:options.maxTurns??options.settings?.maxTurns});
 const runtime=new NodeRuntimeResources(options.settings,options.client,registry,checker,hooks,engine);runtime.toolFactoryOptions={skills:createCapturedSkillCatalog([]),childEnvironment:false,backgroundShell:false,agentDefinitions:[]};return {runtime,model:options.model??options.settings?.model};
}
export async function createFixtureNodeAgent(options:any,tree:any={eventBus:new AgentEventBus(options.onEvent),directory:new AgentChildRegistry(),runCatalogue:new NodeRunCatalogue()}):Promise<any>{
 const configuration=options.configuration??{};
 const prepared=await options.createRuntime({cwd:options.cwd,sessionId:options.sessionId,settings:options.settings,configuration,capabilities:options.capabilities,identity:tree.identity});
 const runtime=prepared.runtime;
 runtime.runCatalogue=tree.runCatalogue;
 try{
 const childManager=new NodeChildManager({runCatalogue:tree.runCatalogue,settings:options.settings,configuration,cwd:options.cwd,idleTtlMs:options.childIdleTtlMs,eventBus:tree.eventBus,directory:tree.directory,environment:options.capabilities.childEnvironment.status==="available"?options.capabilities.childEnvironment.value:{async acquire(){throw new Error("Child environment capability is not available");}},createAgent:(child,identity)=>createFixtureNodeAgent({...options,cwd:child.cwd,sessionId:child.sessionId,configuration:child},{...tree,identity})});
 return createAssembledAgent({runtime,session:createAgentSession({queryEngine:runtime.queryEngine,sessionId:options.sessionId}),eventBus:tree.eventBus,effects:options.effects,identity:tree.identity,childManager,childDirectory:tree.directory,capabilities:options.capabilities,mcpConnections:()=>[],memory:options.capabilities.memory.status==="available"?options.capabilities.memory.value:undefined,model:prepared.model??configuration.model??options.settings.model,pluginSelection:prepared.pluginSelection,onRunCapabilities:configuration.onRunCapabilities});
 }catch(error){await runtime.close();throw error;}
}
