import { patchSessionRuntimeMetadata } from "@vykor/protocol";
import type { SessionCommandHost, SlashLine } from "./session-commands.js";

type ReadPresentation = (key: string, title: string, load: () => Promise<string>) => Promise<void>;

export async function handleSettingsCommand(
  slash: SlashLine,
  host: Pick<SessionCommandHost, "client" | "cwd" | "sessionId" | "patchStatus">,
  emit: (text: string) => void,
  readPresentation: ReadPresentation,
): Promise<"handled"> {
  const { client, cwd, sessionId } = host;
  const patchStatus = (patch: Record<string, unknown>) => host.patchStatus?.(patch);

  if (slash?.name === "/plan") {
    const next =
      slash.args === "on" ? "plan"
        : slash.args === "off" ? "default"
          : undefined;
    if (!next) {
      emit("Usage: /plan [on|off]");
      return "handled";
    }
    patchStatus({ permission_mode: next });
    if (sessionId) {
      await client.sessions.update(sessionId, {
        metadata: patchSessionRuntimeMetadata({}, { permissionMode: next }),
      });
    }
    emit(`Permission mode: ${next}`);
    return "handled";
  }

  if (slash?.name === "/config") {
    const args = slash.args.trim();
    if (!args || args === "show") {
      await readPresentation(`config:${cwd}`, "Config", async () => {
        const settings = await client.system.getSettings();
        return JSON.stringify(settings, null, 2);
      });
      return "handled";
    }
    const setMatch = args.match(/^set\s+(\S+)\s+([\s\S]+)$/);
    if (!setMatch?.[1] || setMatch[2] === undefined) {
      emit("Usage: /config [show | set KEY VALUE]");
      return "handled";
    }
    await client.system.patchSettings({ path: setMatch[1], value: setMatch[2].trim() });
    emit(`Set ${setMatch[1]} = ${setMatch[2].trim()}`);
    return "handled";
  }

  if (slash?.name === "/provider") {
    if (!slash.args) {
      await readPresentation("providers", "Provider", async () => {
        const providers = await client.providers.listProviders();
        const lines = ["Available providers:", ""];
        for (const provider of providers) {
          const marker = provider.active ? " (active)" : "";
          const keyStatus = provider.local ? "[local]" : provider.hasKey ? "[key]" : "[no key]";
          lines.push(`  ${provider.name.padEnd(14)} ${provider.displayName.padEnd(14)} ${keyStatus}${marker}`);
        }
        return lines.join("\n");
      });
      return "handled";
    }
    const settings = await client.system.patchSettings(
      slash.args === "auto"
        ? { provider: "auto" }
        : { provider: slash.args },
    );
    if (typeof settings.model === "string") {
      patchStatus({ model: settings.model });
    }
    emit(`Provider switched to: ${slash.args}`);
    return "handled";
  }

  if (slash?.name === "/auth") {
    const args = slash.args.trim();
    const [sub, provider, apiKey] = args.split(/\s+/).filter(Boolean);
    if (!sub || sub === "status") {
      await readPresentation("auth:status", "Auth", async () => {
        const auth = await client.auth.getStatus();
        const lines = ["Credential status:", "", "  Auth sources:"];
        lines.push(
          `    codex_subscription: ${auth.codex.configured ? "ready" : auth.codex.state} (${auth.codex.source})`,
        );
        if (auth.storedProviders.length > 0) {
          lines.push("", "  Stored credentials:");
          for (const name of auth.storedProviders) lines.push(`    ${name}: configured`);
        }
        if (auth.envProviders.length > 0) {
          lines.push("  Environment variables:");
          for (const env of auth.envProviders) lines.push(`    ${env.name}: ${env.envKey}`);
        }
        if (auth.storedProviders.length === 0 && auth.envProviders.length === 0) {
          lines.push("", "  No credentials configured.");
          lines.push("  Use /auth login <provider> <api-key> to store an API key.");
          lines.push("  Use /auth login codex to use a Codex subscription.");
        }
        return lines.join("\n");
      });
      return "handled";
    }
    if (sub === "login") {
      if (!provider) {
        emit("Usage: /auth login <provider> <api-key> or /auth login codex");
        return "handled";
      }
      const result = await client.auth.login({ provider, apiKey });
      emit(result.message);
      return "handled";
    }
    if (sub === "logout") {
      if (!provider) {
        emit("Usage: /auth logout <provider>");
        return "handled";
      }
      const result = await client.auth.logout({ provider });
      emit(result.message);
      return "handled";
    }
    emit("Unknown subcommand. Use login, logout, or status.");
    return "handled";
  }

  if (slash?.name === "/profile") {
    const action = slash.args.trim().split(/\s+/).filter(Boolean)[0] ?? "status";
    if (action === "status" || action === "show") {
      emit(await client.system.getProfileStatus());
      return "handled";
    }
    if (action === "init") {
      emit(await client.system.initProfile());
      return "handled";
    }
    emit("Usage: /profile [status|init]");
    return "handled";
  }

  if (slash?.name === "/effort") {
    const level = slash.args.trim().split(/\s+/).filter(Boolean)[0];
    if (!level) {
      const settings = await client.system.getSettings();
      emit(`Current effort: ${String(settings.effort ?? "medium")}`);
      return "handled";
    }
    if (!level.trim()) {
      emit("Invalid effort. Provide a non-empty reasoning effort value");
      return "handled";
    }
    await client.system.patchSettings({ effort: level });
    emit(`Effort set to: ${level}`);
    return "handled";
  }

  if (slash?.name === "/fast") {
    const arg = slash.args.trim().split(/\s+/).filter(Boolean)[0];
    const settings = await client.system.getSettings();
    const current = settings.fastMode === true;
    let next: boolean;
    if (arg === "on") next = true;
    else if (arg === "off") next = false;
    else next = !current;
    await client.system.patchSettings({ fastMode: next });
    emit(`Fast mode: ${next ? "ON" : "OFF"}`);
    return "handled";
  }

  if (slash?.name === "/reasoning") {
    const arg = slash.args.trim().split(/\s+/).filter(Boolean)[0];
    const settings = await client.system.getSettings();
    const current = settings.showReasoning !== false;
    let next: boolean;
    if (arg === "on") next = true;
    else if (arg === "off") next = false;
    else next = !current;
    await client.system.patchSettings({ showReasoning: next });
    emit(`Reasoning: ${next ? "ON" : "OFF"}`);
    return "handled";
  }

  if (slash?.name === "/turns") {
    const value = slash.args.trim().split(/\s+/).filter(Boolean)[0];
    if (!value) {
      const settings = await client.system.getSettings();
      emit(`Current max turns: ${String(settings.maxTurns ?? "(default)")}`);
      return "handled";
    }
    const n = Number.parseInt(value, 10);
    if (!Number.isFinite(n) || n < 1 || n > 512) {
      emit("Value must be between 1 and 512");
      return "handled";
    }
    await client.system.patchSettings({ maxTurns: n });
    emit(`Max turns set to: ${n}`);
    return "handled";
  }

  if (slash?.name === "/output-style") {
    const args = slash.args.trim();
    const styles = await client.system.listOutputStyles();
    const settings = await client.system.getSettings();
    const current = typeof settings.outputStyle === "string" ? settings.outputStyle : "default";
    const firstSpace = args.search(/\s/);
    const first = firstSpace === -1 ? args : args.slice(0, firstSpace);
    const rest = firstSpace === -1 ? "" : args.slice(firstSpace + 1).trim();

    if (!first || first === "show") {
      emit(`Output style: ${current}`);
      return "handled";
    }
    if (first === "list") {
      emit(
        styles
          .map((style) => `${style.name === current ? "* " : "  "}${style.name} [${style.source}]`)
          .join("\n"),
      );
      return "handled";
    }

    const styleName = first === "set" && rest ? rest : rest === "" ? first : undefined;
    if (!styleName) {
      emit("Usage: /output-style [show|list|NAME]");
      return "handled";
    }
    if (!styles.some((style) => style.name === styleName)) {
      emit(`Unknown output style: ${styleName}`);
      return "handled";
    }
    await client.system.patchSettings({ outputStyle: styleName });
    emit(`Output style set to ${styleName}`);
    return "handled";
  }

  return "handled";
}
