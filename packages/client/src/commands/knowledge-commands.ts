import type { SessionCommandHost, SlashLine } from "./session-commands.js";

type ReadPresentation = (key: string, title: string, load: () => Promise<string>) => Promise<void>;

export async function handleKnowledgeCommand(
  slash: SlashLine,
  host: Pick<SessionCommandHost, "client" | "cwd" | "sessionId">,
  emit: (text: string) => void,
  readPresentation: ReadPresentation,
): Promise<"handled"> {
  const { client, cwd, sessionId } = host;
  const args = slash.args.trim();
  if (slash.name === "/memory") {
    const [sub, ...rest] = args.split(/\s+/).filter(Boolean);
    if (!sub || sub === "list") {
      await readPresentation(`memory:${cwd}:list`, "Memory", async () => {
        const listed = await client.system.listMemory({ cwd });
        if (listed.entries.length === 0) return `Memory directory: ${listed.directory}\nNo entries found.`;
        return [
          `Memory entries (${listed.entries.length}):`,
          "",
          ...listed.entries.map((entry) => {
            const tags = entry.tags?.length ? ` [${entry.tags.join(", ")}]` : "";
            const preview = entry.content.length > 80
              ? `${entry.content.slice(0, 80)}...`
              : entry.content;
            return `  ${entry.id}${tags}: ${preview}`;
          }),
        ].join("\n");
      });
      return "handled";
    }
    if (sub === "show" && rest[0]) {
      const memoryId = rest[0];
      await readPresentation(`memory:${cwd}:show:${memoryId}`, "Memory", async () => {
        const entry = await client.system.getMemory(memoryId, { cwd });
        return [
          `ID:       ${entry.id}`,
          `Created:  ${new Date(entry.createdAt).toISOString()}`,
          `Updated:  ${new Date(entry.updatedAt).toISOString()}`,
          `Tags:     ${entry.tags?.join(", ") ?? "(none)"}`,
          `Source:   ${entry.source?.type ?? "(unknown)"}`,
          ...(entry.source?.sessionId ? [`Session:  ${entry.source.sessionId}`] : []),
          ...(entry.source?.messageSha256 ? [`Message:  ${entry.source.messageSha256}`] : []),
          "",
          entry.content,
        ].join("\n");
      });
      return "handled";
    }
    if (sub === "add") {
      const content = rest.join(" ").trim();
      if (!content) {
        emit("Usage: /memory add <content>");
        return "handled";
      }
      const entry = await client.system.addMemory({ cwd, content });
      emit(`Memory added: ${entry.id}`);
      return "handled";
    }
    if (sub === "remove" && rest[0]) {
      await client.system.removeMemory(rest[0], { cwd });
      emit(`Memory removed: ${rest[0]}`);
      return "handled";
    }
    emit("Usage: /memory [list | show ID | add CONTENT | remove ID]");
    return "handled";
  }

  const sub = args.split(/\s+/).filter(Boolean)[0];
  if (!sub || sub === "list") {
    await readPresentation(`facts:${cwd}:list`, "Environment facts", async () => {
      const { facts } = await client.system.listFacts({ cwd });
      if (!facts.length) return "No project environment facts found.";
      return ["Project environment facts:", "", ...facts.map((fact) => {
        const status = fact.status === "superseded"
          ? `superseded by ${fact.replacement?.byKey ?? "(unknown)"} (operation ${fact.replacement?.operationId ?? "unknown"})`
          : "active";
        const source = fact.manualSource
          ? `manual replacement ${fact.manualSource.operationId} of ${fact.manualSource.oldKey}` +
            ` at ${fact.manualSource.at}` +
            (fact.manualSource.sessionId ? ` in session ${fact.manualSource.sessionId}` : "")
          : `${fact.sourceSessionId ?? "?"}/${fact.sourceMessageId ?? "?"}`;
        return `  ${fact.key} [${status}] observed ${fact.observedAt?.slice(0, 10) ?? "unknown"}; source ${source}`;
      })].join("\n");
    });
    return "handled";
  }
  if (sub === "replace") {
    const body = args.slice("replace".length).trim();
    const separator = body.indexOf("=>");
    const oldKey = separator < 0 ? "" : body.slice(0, separator).trim();
    const newValue = separator < 0 ? "" : body.slice(separator + 2).trim();
    if (!oldKey || !newValue) {
      emit("Usage: /facts replace <old-key> => <new-value>");
      return "handled";
    }
    const result = await client.system.replaceFact({ cwd, oldKey, newValue, ...(sessionId ? { sessionId } : {}) });
    emit([
      `Environment fact replaced: ${result.oldKey} -> ${result.newKey} (operation ${result.operationId}).`,
      ...(result.relatedActiveKeys.length
        ? [`Other active facts still mention the old address: ${result.relatedActiveKeys.join(", ")}`] : []),
      ...(result.cacheWarning ? [`Warning: ${result.cacheWarning}`] : []),
    ].join("\n"));
    return "handled";
  }
  emit("Usage: /facts [list | replace <old-key> => <new-value>]");
  return "handled";
}
