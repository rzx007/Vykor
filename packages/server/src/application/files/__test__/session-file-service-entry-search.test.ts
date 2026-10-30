import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Settings } from "@vykor/host-config";
import type { SessionRecord } from "@vykor/domain-contracts/sessions";
import { createSessionEnvironmentAcquirer } from "../../../runtime/session-execution-environment.js";
import { SessionFileService, type SessionFileServiceContext } from "../session-file-service.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, {recursive:true,force:true}))); });

async function fixture(unrepresentableEntry = false) {
  const root = await mkdtemp(join(tmpdir(), "session-file-entry-search-"));
  roots.push(root);
  if (unrepresentableEntry && process.platform !== "win32") await writeFile(join(root,"a\\b.txt"),"needle hidden");
  const session: SessionRecord = {id:"a",cwd:root,title:"",model:"test",metadata:{runtime:{model:"test"}},status:"idle",createdAt:1,updatedAt:1};
  const settings: Settings = {
    model:"test",apiFormat:"openai",maxTurns:1,agentEnvironment:{kind:"native"},sandbox:{enabled:false},
    permission:{mode:"full_access",pathRules:[{pattern:"blocked.txt",allow:false}]},
  };
  const context: SessionFileServiceContext = {
    getSession: id => id === session.id ? session : undefined,
    getSettings: () => settings,
    readiness: () => ({phase:"ready",accepting:true}),
    enter: () => ({release() {}}),
    acquireEnvironment: async (record, config) => {
      const environment = await createSessionEnvironmentAcquirer()(record, config);
      if (unrepresentableEntry && process.platform === "win32") {
        const scanDirectory = environment.files.scanDirectory!.bind(environment.files);
        // A POSIX directory may contain this name; Windows cannot create it, so supply it at the I/O boundary.
        environment.files.scanDirectory = async (path, options) => {
          const result = await scanDirectory(path,options);
          return {...result,entries:[{name:"a\\b.txt",isDirectory:false},...result.entries]};
        };
      }
      return environment;
    },
  };
  return {root,service:new SessionFileService(context)};
}

describe("session file enumeration and literal content search", () => {
  it.each(["list", "find", "search"] as const)("%s skips unrepresentable enumerated names while retaining path permissions", async operation => {
    const {root,service} = await fixture(true);
    await writeFile(join(root,"public.txt"),"needle visible");
    await writeFile(join(root,"blocked.txt"),"needle private");

    if (operation === "list") {
      const result = await service.list("a");
      expect(result.entries.map(entry => entry.path)).toEqual(["public.txt"]);
      await expect(service.list("a",{path:"a\\b.txt"})).rejects.toMatchObject({code:"file_invalid_request"});
    } else if (operation === "find") {
      expect((await service.find("a",{pattern:"*.txt"})).files).toEqual(["public.txt"]);
      await expect(service.find("a",{path:"a\\b.txt",pattern:"*.txt"})).rejects.toMatchObject({code:"file_invalid_request"});
    } else {
      expect((await service.search("a",{query:"needle"})).matches).toEqual([{path:"public.txt",line:1,text:"needle visible"}]);
      await expect(service.search("a",{path:"a\\b.txt",query:"needle"})).rejects.toMatchObject({code:"file_invalid_request"});
    }
    await expect(service.readText("a","a\\b.txt")).rejects.toMatchObject({code:"file_invalid_request"});
    await expect(service.readText("a","../outside.txt")).rejects.toMatchObject({code:"file_invalid_request"});
    await expect(service.readText("a","blocked.txt")).rejects.toMatchObject({code:"file_forbidden"});
  });

  it("keeps the matched literal in a long Unicode line when lowercasing changes its length", async () => {
    const {root,service} = await fixture();
    await writeFile(join(root,"unicode.txt"),`${"İ".repeat(5000)}a.*B tail\nAXXB\n`);

    expect(await service.search("a",{query:"a.*b"})).toEqual({
      path:".",matches:[{path:"unicode.txt",line:1,text:`${"İ".repeat(160)}a.*B tail`}],truncated:true,
    });
  });
});
