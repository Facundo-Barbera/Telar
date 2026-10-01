const OFF = ["core.fsmonitor=false", "core.untrackedCache=false"];

// Not GIT_CONFIG_KEY_n: Codex drops env names matching *KEY*, orphaning GIT_CONFIG_COUNT.
export function withoutFsmonitor<T extends Record<string, string | undefined>>(env: T): T & { GIT_CONFIG_PARAMETERS: string } {
  const ours = OFF.map((entry) => `'${entry}'`).join(" ");
  const existing = env.GIT_CONFIG_PARAMETERS;
  return { ...env, GIT_CONFIG_PARAMETERS: existing ? `${existing} ${ours}` : ours };
}

export const engineGitEnv = (extra?: Record<string, string>): NodeJS.ProcessEnv =>
  withoutFsmonitor({ ...process.env, GIT_OPTIONAL_LOCKS: "0", ...extra });
