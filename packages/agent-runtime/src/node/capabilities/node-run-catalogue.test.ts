import { expect,it } from "vitest";
import { readonlyMap } from "@vykor/agent-contracts";
import { NodeRunCatalogue } from "./node-run-catalogue.js";
function view(){return {tools:readonlyMap<never>([]),skills:readonlyMap<never>([]),agents:readonlyMap<never>([]),mcpServers:readonlyMap<never>([])};}
it("keeps independent Node roots isolated even for empty captured tool sets",()=>{
 const left=new NodeRunCatalogue(),right=new NodeRunCatalogue(),captured=view();
 const candidates=[{pluginId:"P",displayName:"P",description:"P",version:"1",behaviorDigest:"original"}];
 left.register(captured,candidates);
 expect(left.resolveView(readonlyMap(captured.tools))).toBe(captured);
 expect(left.resolveCandidates(captured.tools)).toBe(candidates);
 expect(right.resolveView(captured.tools)).toBeUndefined();
 expect(right.resolveCandidates(captured.tools)).toBeUndefined();
 expect(left.resolveView(readonlyMap([]))).toBeUndefined();
});
