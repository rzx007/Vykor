import { expect,it } from "vitest";
import { readonlyMap } from "../collections.js";
it("snapshots caller Maps and preserves only internally created immutable view identity",()=>{
 const mutable=new Map([["A",1]]),captured=readonlyMap(mutable);
 mutable.set("B",2);
 expect([...captured]).toEqual([["A",1]]);
 expect((captured as Map<string,number>).set).toBeUndefined();
 expect(readonlyMap(captured)).toBe(captured);
 const copied={...captured};
 expect(readonlyMap(copied)).not.toBe(copied);
});
