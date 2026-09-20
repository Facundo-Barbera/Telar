/**
 * WHO EVALUATES A SAVED COMMAND, AND WHERE THE COMMAND SITS IN ITS ARGV —
 * written down, in one place, instead of decided privately by `shell: true`.
 *
 * THE RULE THIS SERVES, AND THE RULE IT DOES NOT. A recipe must not hand
 * anything downstream a concatenated command line and leave it to guess who
 * splits it. It does NOT follow that a recipe should store a literal argv:
 * splitting `a && b` into words destroys it, and `bun run dev` is what a human
 * wants to read back. So the recipe keeps the string the human typed AND says
 * explicitly which program is handed it and with what argv prefix. The spawn is
 * `spawn(file, args)` with `shell: false`: nothing splits, nothing guesses, and
 * `a && b` still works because a shell is still the thing evaluating it.
 *
 * ABSENT MEANS "THIS PLATFORM'S SHELL", AND THAT IS THE PORTABLE ANSWER RATHER
 * THAN THE LAZY ONE. Resolving a shell at SAVE time would write `/bin/sh` into
 * a document that has to open on another machine — a POSIX assumption baked
 * into the stored shape, which is the very thing the portability rule forbids.
 * So the document carries a shell only when a human or an agent pinned one, and
 * an unpinned recipe is resolved here, at launch, against the platform it is
 * launching on. Every recipe saved before this field existed reads as unpinned
 * and keeps working unchanged.
 *
 * THE DEFAULTS ARE NODE'S OWN, ON PURPOSE. `/bin/sh -c <command>` on POSIX;
 * `%ComSpec% /d /s /c "<command>"` with `windowsVerbatimArguments` on Windows,
 * because `cmd.exe` parses its own command line and node quoting the last
 * argument for it would change what the shell sees. Copying that behaviour
 * rather than inventing one means this change is a change of WHO KNOWS, not a
 * change of what runs.
 *
 * NOTHING HERE ASSUMES POSIX. No `$HOME`, no `:` as a path separator, no
 * assumption that a login shell exists: the only environment entry read is
 * `ComSpec`, and only on Windows, and it falls back to `cmd.exe`.
 */

import type { RunConfiguration } from "./types";

export type RunShellSpec = {
  /** The program actually spawned. */
  file: string;
  /** Its full argv. THE COMMAND IS THE LAST ENTRY, always. */
  args: string[];
  /** `cmd.exe` builds its own command line; node must not re-quote for it. */
  windowsVerbatimArguments: boolean;
};

/** `cmd.exe`, `CMD.EXE`, `C:\Windows\System32\cmd.exe` — node's own test. */
function isCmd(program: string): boolean {
  return /^(?:.*[\\/])?cmd(?:\.exe)?$/i.test(program);
}

/**
 * What to spawn for this recipe on this platform.
 *
 * A PINNED SHELL IS TAKEN LITERALLY. If the document names a program, that
 * program is spawned with exactly `[...shell.args, command]` and no quoting is
 * added: pinning a shell is claiming the argv, and a second opinion applied on
 * top of it would be this module guessing again.
 */
/**
 * A plain record rather than `NodeJS.ProcessEnv`: this file is compiled by the
 * engine AND by the cockpit, and Next augments `ProcessEnv` with keys it
 * requires — so the narrower type is the one both agree on.
 */
type EnvLike = Readonly<Record<string, string | undefined>>;

export function resolveShell(config: Pick<RunConfiguration, "command" | "shell">, platform: NodeJS.Platform, env: EnvLike = {}): RunShellSpec {
  const pinned = config.shell;
  if (pinned) {
    return { file: pinned.program, args: [...(pinned.args ?? []), config.command], windowsVerbatimArguments: false };
  }
  if (platform === "win32") {
    const comspec = env.ComSpec || env.COMSPEC || "cmd.exe";
    return isCmd(comspec)
      ? // The quotes are part of what `cmd /c` expects, and verbatim is what
        // stops node adding a second pair around them.
        { file: comspec, args: ["/d", "/s", "/c", `"${config.command}"`], windowsVerbatimArguments: true }
      : { file: comspec, args: ["-c", config.command], windowsVerbatimArguments: false };
  }
  return { file: "/bin/sh", args: ["-c", config.command], windowsVerbatimArguments: false };
}
