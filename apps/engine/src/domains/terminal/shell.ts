import type { RunConfiguration } from "./types";

export type RunShellSpec = {
  file: string;
  args: string[];
  windowsVerbatimArguments: boolean;
};

function isCmd(program: string): boolean {
  return /^(?:.*[\\/])?cmd(?:\.exe)?$/i.test(program);
}

type EnvLike = Readonly<Record<string, string | undefined>>;

export function resolveShell(config: Pick<RunConfiguration, "command" | "shell">, platform: NodeJS.Platform, env: EnvLike = {}): RunShellSpec {
  const pinned = config.shell;
  if (pinned) {
    return { file: pinned.program, args: [...(pinned.args ?? []), config.command], windowsVerbatimArguments: false };
  }
  if (platform === "win32") {
    const comspec = env.ComSpec || env.COMSPEC || "cmd.exe";
    return isCmd(comspec)
      ?
        { file: comspec, args: ["/d", "/s", "/c", `"${config.command}"`], windowsVerbatimArguments: true }
      : { file: comspec, args: ["-c", config.command], windowsVerbatimArguments: false };
  }
  return { file: "/bin/sh", args: ["-c", config.command], windowsVerbatimArguments: false };
}
