import { FrameworkAgentRun as KernelRun } from "../../../kernel/framework-agent-run.js";
import { createRunCapabilityView } from "../../plugins/run-capability-view.js";
import { readonlyMap } from "@vykor/agent-contracts";
export class FrameworkAgentRun extends KernelRun {
 constructor(options:any){
  const preparation=options.preparation??{async prepare(scope:any){
   const prepared=await options.prepareCapabilities?.(scope.signal);
   const registry=options.runtime?.queryEngine?.toolRegistry;
   const view=prepared?.capabilityView??options.capabilityView??(registry?createRunCapabilityView({toolRegistry:registry}):undefined);
   return {run:{tools:readonlyMap(view?.tools??[]),contribution:(prepared?.pluginGuidance??options.pluginGuidance)?{systemGuidance:prepared?.pluginGuidance??options.pluginGuidance}:undefined},release(){}};
  }};
  super({...options,engine:options.engine??options.runtime?.queryEngine,preparation});
 }
}

export { streamEventToAgentEvent } from "../../../kernel/framework-agent-run.js";
