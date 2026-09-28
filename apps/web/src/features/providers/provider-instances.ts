import type { ProviderDriverKind, ProviderInstance, ProviderProbe } from "@telar/engine-client";

export const DRIVER_LABEL: Record<ProviderDriverKind, string> = {
  claude: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
};

export const DRIVERS: readonly ProviderDriverKind[] = ["claude", "codex", "opencode"];

export const STATUS_DOT: Record<ProviderProbe["status"], string> = {
  ready: "bg-success",
  warning: "bg-warning",
  error: "bg-destructive",
  disabled: "bg-muted-foreground/40",
};

export const STATUS_LABEL: Record<ProviderProbe["status"], string> = {
  ready: "Ready",
  warning: "Needs attention",
  error: "Unavailable",
  disabled: "Off",
};

export function isDefaultInstance(instance: Pick<ProviderInstance, "id" | "driver">): boolean {
  return instance.id === instance.driver;
}

export function providerSummary(probe: ProviderProbe | undefined): string | null {
  if (!probe) return "Checking";
  if (probe.status === "disabled") return "Off";
  if (!probe.installed) return "Not installed";
  switch (probe.signIn) {
    case "signed-out":
      return "Not signed in";
    case "missing-config-dir":
      return "Config folder missing";
    case "signed-in":
    default:
      return null;
  }
}

export function versionLabel(version: string | undefined): string | null {
  if (!version) return null;
  const trimmed = version.trim();
  if (!trimmed) return null;
  const number = /\d+(?:\.\d+)+/.exec(trimmed);
  return number ? `v${number[0]}` : trimmed;
}

export function updateAdvisory(
  probe: Pick<ProviderProbe, "update"> | undefined,
  label: string,
): { headline: string; detail: string; command?: string } | null {
  const update = probe?.update;
  if (!update || update.status === "current" || update.status === "unknown") return null;
  const latest = update.latest ? (versionLabel(update.latest) ?? update.latest) : null;

  if (update.status === "pinned") {
    return {
      headline: "Newer, but not for this build",
      detail:
        `${label} ${latest} is out. What you have is exactly the version this build of Telar was tested against — ` +
        "updating would move off that pairing, which is the first thing to suspect when tool calls are cancelled " +
        "nobody cancelled. So there is no button here; update it yourself if you want to.",
    };
  }
  return {
    headline: "Update available",
    detail: update.command
      ? `${label} ${latest ?? "a newer version"} is out.`
      : `${label} ${latest ?? "a newer version"} is out. Telar could not tell how this one was installed, so update it the way you installed it.`,
    ...(update.command ? { command: update.command } : {}),
  };
}

export function humanizeInstanceId(id: string): string {
  return id
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(" ")
    .filter(Boolean)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join(" ");
}

export function displayNameOf(instance: Pick<ProviderInstance, "id" | "driver" | "displayName">): string {
  const named = instance.displayName?.trim();
  if (named) return named;
  if (!isDefaultInstance(instance)) {
    const humanized = humanizeInstanceId(instance.id);
    if (humanized) return humanized;
  }
  return DRIVER_LABEL[instance.driver];
}

export function sortInstances(instances: readonly ProviderInstance[]): ProviderInstance[] {
  const byDriver = new Map<ProviderDriverKind, ProviderInstance[]>();
  for (const instance of instances) {
    const bucket = byDriver.get(instance.driver);
    if (bucket) bucket.push(instance);
    else byDriver.set(instance.driver, [instance]);
  }
  const out: ProviderInstance[] = [];
  for (const bucket of byDriver.values()) {
    out.push(...bucket.filter(isDefaultInstance), ...bucket.filter((instance) => !isDefaultInstance(instance)));
  }
  return out;
}

export function suggestInstanceId(driver: ProviderDriverKind, name: string, taken: readonly string[]): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const base = slug ? `${driver}_${slug}` : `${driver}_instance`;
  if (!taken.includes(base)) return base;
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const candidate = `${base}_${suffix}`;
    if (!taken.includes(candidate)) return candidate;
  }
  return `${base}_${taken.length}`;
}

export function isValidInstanceId(id: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id);
}

const CONFIG_DIR_ENV: Record<ProviderDriverKind, string> = {
  claude: "CLAUDE_CONFIG_DIR",
  codex: "CODEX_HOME",
  opencode: "OPENCODE_CONFIG_DIR",
};

const LOGIN_COMMAND: Record<ProviderDriverKind, string> = {
  claude: "claude auth login",
  codex: "codex login",
  opencode: "opencode auth login",
};

export function signInCommand(instance: Pick<ProviderInstance, "driver" | "configDir">): string {
  const command = LOGIN_COMMAND[instance.driver];
  if (instance.driver === "opencode") return command; // configDir does not isolate native OpenCode credentials.
  return instance.configDir ? `${CONFIG_DIR_ENV[instance.driver]}="${instance.configDir}" ${command}` : command;
}
