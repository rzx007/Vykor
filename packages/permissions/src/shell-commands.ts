export type PermissionShellDialect = "posix" | "powershell" | "cmd";

interface ShellCommandAnalysis {
  commands: { source: string; denyCandidate: string }[];
  complete: boolean;
}

// These change how following text or relative paths are interpreted. Their
// semantics require more than literal command boundaries, so ask the user.
const INDIRECT_COMMANDS = new Set([
  "cd", "chdir", "pushd", "popd", "set-location", "sl", "push-location", "pop-location",
  ".", "source", "eval", "exec", "invoke-expression", "iex", "invoke-command", "icm",
  "command", "builtin", "nohup",
  "sh", "bash", "zsh", "dash", "ksh", "fish", "pwsh", "powershell", "cmd", "env", "sudo", "xargs",
]);
const STRUCTURAL_WORDS = new Set([
  "if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac", "function", "select", "time", "!",
]);

function isIndirectCommand(firstWord: string): boolean {
  const name = firstWord.split(/[\\/]/).pop()!.replace(/\.exe$/i, "").toLowerCase();
  return INDIRECT_COMMANDS.has(name) || STRUCTURAL_WORDS.has(name) || firstWord.includes("=");
}

/**
 * Recognize only literal commands, never execute or expand shell input.
 * Unsupported syntax can still expose literal deny candidates, but never allow.
 * This deliberately is not a general shell parser.
 */
export function analyzeShellCommands(source: string, dialect?: PermissionShellDialect): ShellCommandAnalysis {
  const ordinaryCharacters = !/[^\S \t\r\n]|\p{Cf}|\p{Cs}|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/u.test(source)
    && (dialect === "powershell" || !source.includes("\r"));
  if (!dialect || dialect === "cmd") {
    // Only the shared, unquoted subset is safe without a supported interpreter.
    const complete = ordinaryCharacters && /^[\w./:\\ -]+$/.test(source.trim()) && !isIndirectCommand(source.trim().split(/ +/)[0]!);
    return { commands: complete ? [{ source: source.trim(), denyCandidate: source.trim().replace(/ +/g, " ") }] : [], complete };
  }

  const commands: ShellCommandAnalysis["commands"] = [];
  let commandStart = 0;
  let complete = ordinaryCharacters;
  let quote: "'" | '"' | undefined;
  let word = "";
  let wordStarted = false;
  let words: string[] = [];
  const finishWord = () => {
    if (wordStarted) words.push(word);
    word = "";
    wordStarted = false;
  };
  const finishCommand = (end: number) => {
    finishWord();
    if (!words.length) return;
    if (isIndirectCommand(words[0]!)) complete = false;
    if (dialect === "powershell" && words.includes("--%")) complete = false;
    // Joining words loses executable/argument boundaries. Only deny matching
    // may use that approximation; permission to run uses the original spelling.
    commands.push({ source: source.slice(commandStart, end).trim(), denyCandidate: words.join(" ") });
    words = [];
  };

  for (let index = 0; index < source.length; index++) {
    const char = source[index]!;
    if (quote) {
      if (char === quote) {
        if (dialect === "powershell" && quote === "'" && source[index + 1] === "'") {
          word += "'";
          index++;
        } else quote = undefined;
      } else {
        // Double quotes can run substitutions. Escaping rules also differ by
        // dialect, so do not grant permission after approximating their value.
        if (quote === '"' && (char === "$" || char === "`" || (dialect === "posix" && char === "\\"))) complete = false;
        word += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      wordStarted = true;
    } else if (char === ";" || char === "\n" || (dialect === "powershell" && char === "\r") || char === "|" || char === "&") {
      finishCommand(index);
      if (char === "\r" && source[index + 1] === "\n") index++;
      if (char === "&" && source[index + 1] !== "&") complete = false;
      if ((char === "|" || char === "&") && source[index + 1] === char) index++;
      commandStart = index + 1;
    } else if (/\s/.test(char)) {
      finishWord();
    } else {
      // Expansions, redirects, comments, blocks, escapes and wildcards need
      // interpreter-specific analysis. Preserve text only for conservative deny.
      if (/[\x00-\x1f$`<>(){}\[\]*?#!@]/.test(char) || (dialect === "posix" && char === "\\")) complete = false;
      word += char;
      wordStarted = true;
    }
  }
  if (quote) complete = false;
  finishCommand(source.length);
  return { commands, complete: complete && commands.length > 0 };
}
