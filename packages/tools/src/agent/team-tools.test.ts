import { describe, expect, it } from "vitest";
import { createTeamRegistry, narrowTeamPort } from "@vykor/coordinator/teams";
import { createTeamTools } from "./team.js";

const context = { cwd: "/work" };

describe("team tools", () => {
  it("uses the supplied root registry for creation, membership and deletion", async () => {
    const first = createTeamRegistry();
    const second = createTeamRegistry();
    const [createFirst, deleteFirst] = createTeamTools(narrowTeamPort(first));
    const [createSecond] = createTeamTools(narrowTeamPort(second));
    expect((await createFirst!.execute({ name: "dev", description: "first root" }, context)).isError).not.toBe(true);
    expect((await createSecond!.execute({ name: "dev", description: "second root" }, context)).isError).not.toBe(true);
    first.addAgent("dev", "child-a");
    second.addAgent("dev", "child-b");
    expect(first.listTeams()[0]!.agents).toEqual(["child-a"]);
    expect(second.listTeams()[0]!.agents).toEqual(["child-b"]);
    expect((await createFirst!.execute({ name: "dev" }, context)).isError).toBe(true);
    await deleteFirst!.execute({ name: "dev" }, context);
    expect(first.listTeams()).toEqual([]);
    expect(second.listTeams()[0]).toMatchObject({ name: "dev", agents: ["child-b"] });
    expect((await deleteFirst!.execute({ name: "dev" }, context)).isError).toBe(true);
  });
});
