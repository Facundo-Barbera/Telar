/**
 * The Providers pane's reasoning, with no React in it.
 *
 * Ported from t3 code's `src/components/settings/providerStatus.ts` and
 * `src/providerInstances.ts`. The reason it is a module rather than inline JSX
 * is the reason it was one there too: what a status dot MEANS, and what a row
 * calls itself when its login has no name, are decisions — and a decision made
 * inside a render function is one nothing can test and two surfaces can spell
 * differently.
 *
 * WHAT THIS APP DOES NOT SAY. t3's card can print "Authenticated as
 * <email> · Claude Max" because its server holds an identity for each instance.
 * Telar's engine reads no credential and asks no auth subcommand (see
 * apps/engine/src/provider-instances.ts for why), so there is no email and no
 * plan here. The auth line says what was actually measured — installed, which
 * version, and whether a login artefact is where the config folder says it
 * should be — and says "cannot be confirmed from disk" when that is the honest
 * answer, rather than a green tick nothing backs.
 */
import type { ProviderDriverKind, ProviderInstance, ProviderProbe } from "@telar/engine-client";

/** The brand names, which are NOT the driver slugs: the driver kind is an
 *  implementation selector and `claude` is a product. */
export const DRIVER_LABEL: Record<ProviderDriverKind, string> = {
  claude: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
};

/**
 * THE PANE'S OWN LIST, AND `telar` IS NOT ON IT. This drives "add a login",
 * and there is nothing to add: the engine's loop has one slot, no config
 * folder and no second account. Its row is reached from the Main pane, where
 * the setting that turns it on lives. `DRIVER_LABEL` still carries it, because
 * a row that EXISTS has to be drawable.
 */
export const DRIVERS: readonly ProviderDriverKind[] = ["claude", "codex", "opencode"];

/**
 * The whole status language, one colour per state.
 *
 * On the five-token vocabulary (app/globals.css) rather than a raw Tailwind
 * ramp, so a dot here and a badge elsewhere cannot disagree about what amber
 * means. t3 reaches for `bg-amber-400` on `disabled`; here `disabled` is muted
 * instead — a switched-off instance is not a warning, it is a decision, and
 * colouring it like a problem sends people to fix something they chose.
 */
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

/** The id of the built-in slot for a driver. Mirrors the engine's own
 *  `defaultInstanceIdForDriver`; kept here so the cockpit does not import a
 *  function to answer a one-line question in a render path. */
export function isDefaultInstance(instance: Pick<ProviderInstance, "id" | "driver">): boolean {
  return instance.id === instance.driver;
}

/**
 * ONE WORD FOR AN INSTANCE'S STATE, or `null` when the card already says it.
 *
 * ORDERED BY WHAT THE READER SHOULD DO FIRST. A missing CLI outranks everything
 * because no amount of config-folder correctness helps until it is installed;
 * a disabled instance outranks even that, because its owner already decided.
 *
 * IT USED TO BE A SENTENCE, AND THE SENTENCE WAS THE PROBLEM (#357). Each state
 * carried a headline plus the engine's own `message` — "Installed — Tested
 * against 2.1.257; you have 2.1.267", "Base login — sign-in state cannot be
 * verified from disk" — printed under every row of a pane whose rows are mostly
 * healthy. The version comparison is the update advisory's job and has its own
 * marker with its own tooltip; the sign-in caveat belongs to the expanded body,
 * beside the command that fixes it.
 *
 * `null` FOR "INSTALLED" IS THE POINT. A working login is the common row, and
 * the common row should be name, version and a switch. The states that need a
 * reader to do something keep a word, because a card that says nothing when
 * nothing works is not restraint, it is a bug.
 */
export function providerSummary(probe: ProviderProbe | undefined): string | null {
  if (!probe) return "Checking";
  if (probe.status === "disabled") return "Off";
  if (!probe.installed) return "Not installed";
  switch (probe.signIn) {
    case "signed-out":
      return "Not signed in";
    case "missing-config-dir":
      return "Config folder missing";
    // Both are a login that works. "Installed" is the common case for Claude —
    // the token is in the Keychain, so installed is all that was proven — and a
    // badge nobody can act on reading it is what this pane had too much of.
    case "signed-in":
    default:
      return null;
  }
}

/**
 * The version number out of whatever line the CLI printed.
 *
 * `--version` DOES NOT RETURN A VERSION, it returns a sentence, and the two
 * installed harnesses do not agree on its shape: Claude answers
 * `2.1.229 (Claude Code)` and Codex answers `codex-cli 0.145.0`. A rule that
 * merely prefixed `v` when the string did not start with one produced
 * `vcodex-cli 0.145.0`, which is how this was found — by looking at the row,
 * not by a test.
 *
 * So the number is EXTRACTED rather than the line decorated: the first
 * dotted-numeric run becomes `v1.2.3`, and the product name beside it is
 * dropped because the row already says which provider this is. A line with no
 * number in it is passed through untouched — a build id like `nightly-20260813`
 * is still the most useful thing that could be shown.
 */
export function versionLabel(version: string | undefined): string | null {
  if (!version) return null;
  const trimmed = version.trim();
  if (!trimmed) return null;
  const number = /\d+(?:\.\d+)+/.exec(trimmed);
  return number ? `v${number[0]}` : trimmed;
}

/**
 * WHAT THE ROW SAYS ABOUT A NEWER CLI, AND WHETHER IT OFFERS TO GET IT.
 *
 * Ported from t3 code's `getProviderVersionAdvisoryPresentation`, which returns
 * `null` for "current" and "unknown" for the same reason this does: an advisory
 * that renders when there is nothing to say is a permanent mark on a healthy
 * row, and people stop reading marks that are always there.
 *
 * `pinned` IS THE STATE THE DONOR HAS NO NAME FOR, and it is the one that has to
 * read carefully. Something newer exists, the installed version is exactly the
 * one this build of Telar pairs with, and Telar therefore declines to update it
 * — while still saying the newer version is out, because the choice belongs to
 * the person and not to the app. The engine withholds the command in that state
 * (apps/engine/src/cli-updates.ts) and this surface does not invent one.
 *
 * A `behind` WITH NO COMMAND is the honest gap: the CLI is old and Telar could
 * not tell how it was installed. Saying so beats offering a guessed installer
 * that would silently replace, say, a self-built binary with a published one.
 */
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

/**
 * `codex_personal` → "Codex Personal". Splits on `_`/`-` and camelCase and
 * title-cases each token.
 *
 * Only ever a FALLBACK: an instance with a display name uses it. This exists so
 * two logins of one provider are still distinguishable in a picker when the
 * second was added without being named.
 */
export function humanizeInstanceId(id: string): string {
  return id
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(" ")
    .filter(Boolean)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join(" ");
}

/** What a row calls itself: the name the user gave it, else the humanized id
 *  for a custom instance, else the brand. */
export function displayNameOf(instance: Pick<ProviderInstance, "id" | "driver" | "displayName">): string {
  const named = instance.displayName?.trim();
  if (named) return named;
  if (!isDefaultInstance(instance)) {
    const humanized = humanizeInstanceId(instance.id);
    if (humanized) return humanized;
  }
  return DRIVER_LABEL[instance.driver];
}

/**
 * Default first within each driver; drivers keep the order the engine sent.
 *
 * Stable rather than alphabetical on purpose — the built-in slot is the one
 * people look for, and a custom login sorting above it because it starts with
 * "A" would move the row that matters.
 */
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

/**
 * Turn what somebody typed into an id that will be accepted.
 *
 * The id is PERMANENT — it is the routing key every session stores — so the add
 * dialog derives one from the name rather than making a permanent decision a
 * required second field. Collisions get a numeric suffix instead of an error,
 * because "Work" twice is a reasonable thing for a person to do.
 */
export function suggestInstanceId(driver: ProviderDriverKind, name: string, taken: readonly string[]): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  // Prefixed with the driver so `work` on Claude and `work` on Codex can both
  // exist, and so an id reads as what it is at a glance in a session record.
  const base = slug ? `${driver}_${slug}` : `${driver}_instance`;
  if (!taken.includes(base)) return base;
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const candidate = `${base}_${suffix}`;
    if (!taken.includes(candidate)) return candidate;
  }
  return `${base}_${taken.length}`;
}

/** The rule the engine enforces, mirrored so the dialog can refuse before it
 *  asks. Kept beside `suggestInstanceId` so the two cannot drift. */
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

/**
 * The exact command that signs THIS login in, for the user to run in their own
 * terminal. Telar hands it over; nothing in this repo runs it.
 *
 * THE CONFIG-DIR PREFIX IS WHAT MAKES IT ACCOUNT-SPECIFIC. Without it the CLI
 * signs the BASE login in, which on a machine with several config folders is
 * the one account the user was not trying to fix. The built-in slot has no
 * folder and therefore no prefix, which is correct: it IS the base login.
 *
 * Lives in the cockpit rather than the engine because it is a sentence shown to
 * a person and never executed — one copy, in the layer that renders it.
 */
export function signInCommand(instance: Pick<ProviderInstance, "driver" | "configDir">): string {
  const command = LOGIN_COMMAND[instance.driver];
  if (instance.driver === "opencode") return command; // configDir does not isolate native OpenCode credentials.
  return instance.configDir ? `${CONFIG_DIR_ENV[instance.driver]}="${instance.configDir}" ${command}` : command;
}
