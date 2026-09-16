/**
 * WHAT THE PROVIDER CAN BE ASKED TO DO — its skills and its slash commands.
 *
 * The composer's `/` menu offered Telar's own verbs and nothing else, and its
 * header said why: "the ENGINE does not ask and the contract has nowhere to put
 * the answer". This module is the asking. It is deliberately NOT a hand-written
 * list — every name here comes from a file on disk or from the provider's own
 * mouth, for the same reason `models.ts` stopped shipping a catalogue: a menu
 * of plausible-looking commands fails at the provider, discovered by a person
 * mid-sentence.
 *
 * FOUR SOURCES, AND THE `source` FIELD IS THE HONEST LABEL FOR EACH:
 *
 *   - `user`     — a `SKILL.md` under `~/.claude/skills/<name>/`, and any `.md`
 *                  under `~/.claude/commands/`. This machine's own, available
 *                  in every project.
 *   - `project`  — the same two directories under the session's CHECKOUT, which
 *                  is its worktree when it cut one. A worktree session must see
 *                  what its own copy of the repository holds, not the project
 *                  root's. This includes the DIRECTORY-SCOPED ones: a monorepo
 *                  keeps `apps/web/.claude/skills/deploy` beside the code it is
 *                  about, and Claude Code addresses it `apps/web:deploy`.
 *   - `plugin`   — every installed plugin's `skills/` and `commands/`, read from
 *                  `~/.claude/plugins/installed_plugins.json`. Namespaced
 *                  `<plugin>:<name>`, which is how Claude Code itself addresses
 *                  them and therefore the only name that works when typed.
 *   - `provider` — whatever `supportedCommands()` reports and the three above
 *                  did not already find. This is the provider's own statement
 *                  about itself, so it is passed through UNCURATED: Telar does
 *                  not get to decide that one of Claude's commands is not real.
 *
 * SKILLS AND COMMANDS ARE SPLIT BY WHERE THEY CAME FROM, not by a flag in the
 * data — a `SKILL.md` under `skills/` is a skill, an `.md` under `commands/` is
 * a command, and the SDK's list is called `supportedCommands`. There is no
 * field on the SDK's row that would let us claim more than that.
 *
 * CODEX AND OPENCODE REPORT NOTHING, and that is an answer rather than a gap:
 * neither exposes a skill or command inventory a daemon can read, so the route
 * says so with two empty lists instead of guessing at a layout.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProviderDriverKind, ProviderSkill, ProviderSkillSource, ProviderSkills } from "@telar/engine-client";
import { refuseCliSpawnUnderTest, requireCli } from "./cli-resolution";

/**
 * How long to wait for the provider to list its own commands.
 *
 * Same shape and the same reason as `models.ts`: a subprocess handshake reached
 * from a menu keystroke. Shorter than the model list's ten seconds because this
 * one has a complete answer to fall back on — the three filesystem sources
 * above — so a slow CLI costs the provider's own rows rather than the menu.
 */
const SUPPORTED_COMMANDS_TIMEOUT_MS = 5_000;

/** A pathological `skills/` tree must not turn a keystroke into a directory
 *  walk. Far above any real inventory; a cap that is never reached is still the
 *  difference between a bounded read and an unbounded one. */
const MAX_ENTRIES_PER_SOURCE = 250;

/** How deep a `commands/` tree is followed. Claude namespaces a subdirectory's
 *  command as `<dir>:<name>`, so depth is a real feature — but three levels of
 *  colons is nobody's menu. */
const MAX_COMMAND_DEPTH = 3;

/** How far below the checkout a nested `.claude` is looked for. `apps/web` is
 *  two, `packages/ui/src` is three; four is past where anybody puts one and is
 *  what stops this from becoming a walk of the whole repository. */
const MAX_NESTED_DEPTH = 4;

/** A cap on how many directory-scoped `.claude` roots are read. A monorepo has
 *  a handful; a tree with fifty is a tree this should stop walking. */
const MAX_NESTED_ROOTS = 32;

/**
 * Directories the nested walk never descends into.
 *
 * `node_modules` is the one that matters — a walk that entered it would read
 * every dependency's tree on a keystroke, and a package that ships a `.claude`
 * is not this project's skill. The rest are build output, which is the same
 * argument. Dot-directories are skipped wholesale below, `.claude` excepted.
 */
const NEVER_DESCEND = new Set(["node_modules", "dist", "build", "out", "target", "vendor", "coverage", "tmp"]);

/** Where this machine keeps Claude's own configuration, honouring the same
 *  variable the CLI reads. Mirrors `defaultScanRoots` in usage.ts. */
export function claudeHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), ".claude");
}

/** Codex's own configuration directory, honouring the variable its CLI reads —
 *  the same resolution `computer-use.ts` and `usage.ts` already make. */
export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
}

/**
 * OpenCode's own configuration directory.
 *
 * XDG, unlike the two above: OpenCode is the one of the three that follows it,
 * scanning `<config>/{skill,skills}/**\/SKILL.md` for the machine's own skills.
 * `OPENCODE_CONFIG` names a config FILE when it is set, so the directory is its
 * parent.
 */
export function openCodeHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.OPENCODE_CONFIG?.trim();
  if (configured) return path.dirname(configured);
  const xdg = env.XDG_CONFIG_HOME?.trim();
  return path.join(xdg || path.join(os.homedir(), ".config"), "opencode");
}

/**
 * WHERE A PROVIDER READS MACHINE-WIDE SKILLS FROM — the directory an engine-
 * authored `SKILL.md` is installed into (see `orientation.ts`).
 *
 * ONE PER DRIVER, AND EACH IS THAT PROVIDER'S OWN CONVENTION rather than a
 * guess: Claude reads `<claude>/skills/<name>/SKILL.md`, Codex
 * `<codex>/skills/...`, and OpenCode `<config>/skill/...` (singular — its
 * scanner accepts `{skill,skills}`, and the singular is the directory its own
 * docs name beside `agent/` and `command/`).
 *
 * SEPARATE FROM THE READING SIDE ABOVE, which lists what a person may TYPE and
 * deliberately reports nothing for Codex and OpenCode — neither exposes an
 * inventory a daemon can read. Not being able to enumerate a provider's skills
 * is a different fact from not knowing where to put one.
 */
export function providerSkillRoot(driver: ProviderDriverKind, env: NodeJS.ProcessEnv = process.env): string {
  if (driver === "codex") return path.join(codexHome(env), "skills");
  if (driver === "opencode") return path.join(openCodeHome(env), "skill");
  return path.join(claudeHome(env), "skills");
}

/** Every provider's install location, deduplicated — what the engine syncs the
 *  `telar` skill across on start. */
export function providerSkillRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  return [...new Set((["claude", "codex", "opencode"] as const).map((driver) => providerSkillRoot(driver, env)))];
}

/* ------------------------------------------------------------------ *
 * Reading one file's front matter.
 * ------------------------------------------------------------------ */

/**
 * `name` and `description` out of a `---` block, and nothing else.
 *
 * NOT A YAML PARSER, and it must not become one: the two fields this needs are
 * scalars on one line in every skill anybody writes, and a dependency that can
 * evaluate anchors and tags to read them would be a parser running over files
 * from a plugin marketplace. A value it cannot read is simply absent, and the
 * fallbacks below cover that.
 */
export function parseFrontMatter(text: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return {};
  const fields: Record<string, string> = {};
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const pair = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!pair) continue;
    const value = (pair[2] ?? "").trim().replace(/^["']|["']$/g, "").trim();
    if (value) fields[pair[1]!.toLowerCase()] = value;
  }
  return fields;
}

/**
 * What a file says it is FOR, when its front matter did not say.
 *
 * The first heading, or the first line of prose. `~/.claude/skills` on a real
 * machine is full of hand-written `SKILL.md` files that open with `# Commit
 * Message Generator` and no front matter at all — and that heading is exactly
 * what Claude Code itself shows for them, so falling back to it is matching the
 * provider rather than inventing a description.
 */
export function fallbackDescription(text: string): string {
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  let fenced = false;
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    // A FENCED BLOCK IS SKIPPED WHOLE, not just at its opening tick: a skill
    // that leads with an example would otherwise be described by its first line
    // of code.
    if (trimmed.startsWith("```")) {
      fenced = !fenced;
      continue;
    }
    if (fenced || !trimmed) continue;
    const heading = /^#{1,6}\s+(.*)$/.exec(trimmed);
    if (heading) return (heading[1] ?? "").trim();
    // A bullet is layout, not a sentence about the skill.
    if (trimmed.startsWith("-") || trimmed.startsWith("*")) continue;
    return trimmed;
  }
  return "";
}

async function readTextOrUndefined(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return undefined;
  }
}

/** `stat`, not `lstat`: a skill installed as a SYMLINK into a dotfiles
 *  repository is an ordinary skill, and the one on this author's machine is
 *  exactly that. Following is the whole point. */
async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function entriesOf(directory: string): Promise<string[]> {
  try {
    return (await fs.readdir(directory)).sort();
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ *
 * The two directory shapes.
 * ------------------------------------------------------------------ */

/**
 * `<root>/<name>/SKILL.md` — one skill per directory.
 *
 * `prefix` is what namespaces a plugin's skills (`vercel:ai-sdk`). A skill's
 * front-matter `name` wins over its directory when they disagree, because the
 * front matter is what the provider itself reads.
 */
export async function readSkillDirectory(root: string, source: ProviderSkillSource, prefix = ""): Promise<ProviderSkill[]> {
  const skills: ProviderSkill[] = [];
  for (const entry of await entriesOf(root)) {
    if (entry.startsWith(".")) continue;
    if (skills.length >= MAX_ENTRIES_PER_SOURCE) break;
    const directory = path.join(root, entry);
    if (!(await isDirectory(directory))) continue;
    const text = await readTextOrUndefined(path.join(directory, "SKILL.md"));
    if (text === undefined) continue;
    const fields = parseFrontMatter(text);
    const name = fields.name || entry;
    skills.push({ name: prefix ? `${prefix}:${name}` : name, description: fields.description || fallbackDescription(text), source });
  }
  return skills;
}

/**
 * Every `.md` under `<root>`, at any depth — one command per file, with a
 * subdirectory becoming a `:`.
 *
 * The namespacing is Claude Code's own: `commands/review/pr.md` is `/review:pr`
 * there, so writing it any other way here would produce a row that does nothing
 * when it is typed.
 */
export async function readCommandDirectory(root: string, source: ProviderSkillSource, prefix = ""): Promise<ProviderSkill[]> {
  const commands: ProviderSkill[] = [];

  const walk = async (directory: string, segments: string[]): Promise<void> => {
    if (segments.length > MAX_COMMAND_DEPTH) return;
    for (const entry of await entriesOf(directory)) {
      if (entry.startsWith(".")) continue;
      if (commands.length >= MAX_ENTRIES_PER_SOURCE) return;
      const full = path.join(directory, entry);
      if (await isDirectory(full)) {
        await walk(full, [...segments, entry]);
        continue;
      }
      if (!entry.endsWith(".md")) continue;
      const text = (await readTextOrUndefined(full)) ?? "";
      const fields = parseFrontMatter(text);
      const name = [...segments, entry.slice(0, -3)].join(":");
      commands.push({
        name: prefix ? `${prefix}:${name}` : name,
        description: fields.description || fallbackDescription(text),
        source,
      });
    }
  };

  await walk(root, []);
  return commands;
}

/* ------------------------------------------------------------------ *
 * Directory-scoped `.claude` roots.
 * ------------------------------------------------------------------ */

/**
 * EVERY `.claude` BELOW THE CHECKOUT, and the path that namespaces what is in
 * it — `apps/web/.claude` becomes the scope `apps/web`.
 *
 * WHY THIS HAS TO EXIST RATHER THAN BE ASKED FOR. `supportedCommands()` is the
 * provider's own list and it was the obvious place to get these from, but the
 * CLI only surfaces a directory-scoped skill when its cwd is INSIDE that
 * directory: asked in a fixture checkout's root it answered 97 rows without
 * `apps/web`'s skill, and asked again from `apps/web` it answered 98 with it.
 * A session runs at its checkout root, so the row can never arrive that way —
 * which makes reading the directories the only honest route to them.
 *
 * BOUNDED IN FOUR WAYS, because this is reached from a keystroke: depth,
 * a count of roots, the skipped directories above, and dot-directories. The
 * root's own `.claude` is NOT returned — it is read unprefixed as `project`,
 * and a scope of `""` would namespace it `:name`.
 */
export async function findScopedClaudeRoots(checkout: string, maxDepth = MAX_NESTED_DEPTH): Promise<{ scope: string; root: string }[]> {
  const found: { scope: string; root: string }[] = [];

  const walk = async (directory: string, segments: string[]): Promise<void> => {
    if (segments.length >= maxDepth || found.length >= MAX_NESTED_ROOTS) return;
    for (const entry of await entriesOf(directory)) {
      if (found.length >= MAX_NESTED_ROOTS) return;
      const full = path.join(directory, entry);
      if (entry === ".claude") {
        // Depth zero is the checkout's own, already read as `project`.
        if (segments.length > 0 && (await isDirectory(full))) found.push({ scope: segments.join("/"), root: full });
        continue;
      }
      if (entry.startsWith(".") || NEVER_DESCEND.has(entry)) continue;
      if (!(await isDirectory(full))) continue;
      await walk(full, [...segments, entry]);
    }
  };

  await walk(checkout, []);
  return found;
}

/* ------------------------------------------------------------------ *
 * Installed plugins.
 * ------------------------------------------------------------------ */

/**
 * Every installed plugin's own directory, from Claude's own manifest.
 *
 * READ FROM `installed_plugins.json` RATHER THAN WALKED. The marketplaces
 * directory holds every plugin a marketplace OFFERS, installed or not, and a
 * menu built from that would list hundreds of commands the provider would not
 * answer to. The manifest names the ones that are actually on, and carries the
 * exact `installPath` each was unpacked to.
 */
export async function installedPluginRoots(home: string): Promise<{ plugin: string; root: string }[]> {
  const text = await readTextOrUndefined(path.join(home, "plugins", "installed_plugins.json"));
  if (text === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const plugins = (parsed as { plugins?: Record<string, unknown> } | null)?.plugins;
  if (!plugins || typeof plugins !== "object") return [];

  const roots: { plugin: string; root: string }[] = [];
  for (const [key, value] of Object.entries(plugins)) {
    // `<plugin>@<marketplace>` — the part before the `@` is what a person types.
    const plugin = key.split("@")[0] ?? key;
    if (!plugin || !Array.isArray(value)) continue;
    for (const install of value) {
      const root = (install as { installPath?: unknown } | null)?.installPath;
      if (typeof root === "string" && root) roots.push({ plugin, root });
    }
  }
  return roots;
}

/* ------------------------------------------------------------------ *
 * The provider's own list.
 * ------------------------------------------------------------------ */

type ClaudeCommandQuery = { supportedCommands(): Promise<unknown> };
export type ClaudeCommandSdk = {
  query(input: { prompt: AsyncIterable<never>; options: Record<string, unknown> }): ClaudeCommandQuery;
};

export type LoadProviderCommands = (input: { driver: ProviderDriverKind; cwd: string }) => Promise<ProviderSkill[]>;

/**
 * Ask the installed Claude what it answers to.
 *
 * THE SAME TRICK `readClaudeModels` USES, and it is worth restating because it
 * is the thing that makes this affordable: the prompt is an async generator
 * that parks until the abort fires, which puts the SDK in streaming-input mode.
 * The CLI starts, completes `initialize`, answers control requests — and no
 * user message is ever sent, so no turn begins and nothing is billed.
 *
 * RUN IN THE SESSION'S OWN CHECKOUT, because the answer depends on it: a
 * project's `.claude/commands` are only in the list when the CLI was started
 * where they are.
 */
/** The SDK, behind the test gate — issue #532, and the same reasoning as
 *  `loadClaudeModelSdk`: exported so a test can hold the gate directly rather
 *  than infer it from an empty list this function also returns when there is no
 *  install at all. */
export async function loadClaudeCommandSdk(): Promise<ClaudeCommandSdk> {
  refuseCliSpawnUnderTest("the Claude Agent SDK skills probe");
  return (await import("@anthropic-ai/claude-agent-sdk")) as unknown as ClaudeCommandSdk;
}

export async function readClaudeSupportedCommands(
  cwd: string,
  loadSdk: () => Promise<ClaudeCommandSdk> = loadClaudeCommandSdk,
  timeoutMs = SUPPORTED_COMMANDS_TIMEOUT_MS,
): Promise<ProviderSkill[]> {
  let sdk: ClaudeCommandSdk;
  try {
    sdk = await loadSdk();
  } catch {
    return [];
  }
  const controller = new AbortController();
  async function* silent(): AsyncGenerator<never> {
    await new Promise<void>((resolve) => controller.signal.addEventListener("abort", () => resolve(), { once: true }));
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    let executable: string | undefined;
    try {
      executable = requireCli("claude", {});
    } catch {
      // No install. The SDK's own lookup and its own failure stand; the three
      // filesystem sources are still a complete answer without this one.
      executable = undefined;
    }
    const session = sdk.query({
      prompt: silent(),
      options: {
        cwd,
        permissionMode: "default",
        abortController: controller,
        // NO TRANSCRIPT FOR A HANDSHAKE — issue #532, same as the model probe.
        // This one is worse for being per-checkout: it runs in the session's
        // own directory, so its leavings were spread across a projects folder
        // per worktree rather than one.
        persistSession: false,
        ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
      },
    });
    const answer = await Promise.race([
      session.supportedCommands(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("claude did not list its commands in time")), timeoutMs);
      }),
    ]);
    return parseSupportedCommands(answer);
  } catch {
    // A provider that could not be asked contributes nothing, and the rows read
    // off disk are unaffected. There is no error to report to a menu here.
    return [];
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  }
}

/** `SlashCommand[]`, narrowed. Defensive about every field for the reason
 *  `parseCodexModels` is: the installed CLI updates on its own schedule. */
export function parseSupportedCommands(payload: unknown): ProviderSkill[] {
  if (!Array.isArray(payload)) return [];
  return payload.flatMap((entry) => {
    const row = entry as { name?: unknown; description?: unknown; argumentHint?: unknown };
    const name = typeof row.name === "string" ? row.name.replace(/^\//, "").trim() : "";
    if (!name) return [];
    const hint = typeof row.argumentHint === "string" ? row.argumentHint.trim() : "";
    const description = typeof row.description === "string" ? row.description.trim() : "";
    return [{ name, description: hint && description ? `${description} ${hint}` : description || hint, source: "provider" as const }];
  });
}

const loadClaudeCommands: LoadProviderCommands = async ({ driver, cwd }) =>
  driver === "claude" ? readClaudeSupportedCommands(cwd) : [];

/* ------------------------------------------------------------------ *
 * The whole answer, and the cache in front of it.
 * ------------------------------------------------------------------ */

export type ProviderSkillsInput = {
  driver: ProviderDriverKind;
  /** The session's own checkout — its worktree when it cut one. */
  checkout: string;
  env?: NodeJS.ProcessEnv;
  /** Test seam, and the reason the suite never spawns a CLI. */
  loadProviderCommands?: LoadProviderCommands;
};

/**
 * EARLIER SOURCES WIN A NAME. A project's `review` shadows the machine's, which
 * shadows a plugin's, which shadows whatever the provider reported — the same
 * precedence Claude Code resolves by, so what this list says will run is what
 * runs. Losing rows are DROPPED rather than suffixed: two `/review` rows in a
 * menu is a choice nobody can make correctly.
 */
function dedupe(groups: readonly ProviderSkill[][]): ProviderSkill[] {
  const seen = new Set<string>();
  const kept: ProviderSkill[] = [];
  for (const group of groups) {
    for (const entry of group) {
      if (seen.has(entry.name)) continue;
      seen.add(entry.name);
      kept.push(entry);
    }
  }
  return kept;
}

/**
 * The answer, plus the directories it was read from.
 *
 * The second half is the cache's business rather than a caller's: a stamp can
 * only watch the directory-scoped roots once something has gone and found them.
 * `readProviderSkills` is the public shape and drops it.
 */
export async function readProviderSkillsWithRoots(input: ProviderSkillsInput): Promise<{ value: ProviderSkills; watched: string[] }> {
  if (input.driver !== "claude") {
    // Codex and OpenCode expose no inventory to read. Two empty lists is the
    // true answer, and the composer draws nothing rather than a wrong heading.
    return { value: { skills: [], commands: [] }, watched: [] };
  }

  const home = claudeHome(input.env);
  const project = path.join(input.checkout, ".claude");
  const [pluginRoots, scopedRoots] = await Promise.all([installedPluginRoots(home), findScopedClaudeRoots(input.checkout)]);

  const [userSkills, projectSkills, scopedSkills, userCommands, projectCommands, scopedCommands, pluginSkills, pluginCommands, providerCommands] =
    await Promise.all([
      readSkillDirectory(path.join(home, "skills"), "user"),
      readSkillDirectory(path.join(project, "skills"), "project"),
      // NAMESPACED BY THE DIRECTORY THAT SCOPES THEM — `apps/web:deploy`, which
      // is how Claude Code lists and addresses one, and therefore the only name
      // that does anything when it is typed.
      Promise.all(scopedRoots.map((entry) => readSkillDirectory(path.join(entry.root, "skills"), "project", entry.scope))).then((all) => all.flat()),
      readCommandDirectory(path.join(home, "commands"), "user"),
      readCommandDirectory(path.join(project, "commands"), "project"),
      Promise.all(scopedRoots.map((entry) => readCommandDirectory(path.join(entry.root, "commands"), "project", entry.scope))).then((all) => all.flat()),
      Promise.all(pluginRoots.map((entry) => readSkillDirectory(path.join(entry.root, "skills"), "plugin", entry.plugin))).then((all) => all.flat()),
      Promise.all(pluginRoots.map((entry) => readCommandDirectory(path.join(entry.root, "commands"), "plugin", entry.plugin))).then((all) => all.flat()),
      (input.loadProviderCommands ?? loadClaudeCommands)({ driver: input.driver, cwd: input.checkout }),
    ]);

  const skills = dedupe([projectSkills, scopedSkills, userSkills, pluginSkills]);
  // A name already claimed by a SKILL.md is not ALSO a command: Claude reports
  // its skills through `supportedCommands()` too, and listing one under both
  // headings would double every skill on the machine.
  const claimed = new Set(skills.map((skill) => skill.name));
  const commands = dedupe([projectCommands, scopedCommands, userCommands, pluginCommands, providerCommands]).filter(
    (command) => !claimed.has(command.name),
  );
  const watched = scopedRoots.flatMap((entry) => [entry.root, path.join(entry.root, "skills"), path.join(entry.root, "commands")]);
  return { value: { skills, commands }, watched };
}

export async function readProviderSkills(input: ProviderSkillsInput): Promise<ProviderSkills> {
  return (await readProviderSkillsWithRoots(input)).value;
}

/* ------------------------------------------------------------------ *
 * The cache the route answers from.
 * ------------------------------------------------------------------ */

/**
 * A READ IS A HANDFUL OF STATS AND, ONCE, A SUBPROCESS — so it is cached, and
 * the cache has two ways to go stale.
 *
 * KEYED BY WHOEVER ASKED, WHICH IS A SESSION OR A PROJECT. A session's key is
 * its id, because its checkout is its own worktree; a canvas with no session
 * yet asks about the PROJECT, whose key is its id and whose checkout is the
 * project root. Two keys rather than one because the two checkouts genuinely
 * differ, and one worktree's `.claude` is not the project's.
 *
 * THE STAMP is the modification time of the directories that hold the answer:
 * the checkout's `.claude`, its `skills` and `commands`, the machine's own, and
 * every directory-scoped `.claude` the LAST read found. Adding a skill,
 * removing one, or renaming a command file moves its parent's mtime, so the
 * very next `$` sees it — which is what "refreshed when the checkout's
 * `.claude` changes" has to mean in practice.
 *
 * THE CLOCK covers what a directory mtime cannot: editing a `SKILL.md`'s
 * description IN PLACE changes the file and not the directory around it, and —
 * because the stamp can only watch roots that have already been found — a
 * `.claude` created in a subdirectory for the FIRST time. A minute is short
 * enough that a person editing a skill and reopening the menu sees their words,
 * and long enough that holding `$` down is not a subprocess per keystroke.
 */
const CACHE_TTL_MS = 60_000;

type CacheEntry = { stamp: string; at: number; value: ProviderSkills; watched: string[] };
const cache = new Map<string, CacheEntry>();

async function directoryStamp(directories: readonly string[]): Promise<string> {
  const parts = await Promise.all(
    directories.map(async (directory) => {
      try {
        return `${directory}:${(await fs.stat(directory)).mtimeMs}`;
      } catch {
        // An absent directory is a real state and must be part of the stamp:
        // creating `.claude/skills` for the first time has to invalidate.
        return `${directory}:-`;
      }
    }),
  );
  return parts.join("|");
}

export type CachedProviderSkillsInput = ProviderSkillsInput & {
  /** Whose answer this is — a session id, or a project id for a canvas that
   *  has no session yet. */
  cacheKey: string;
  now?: () => number;
};

export async function readProviderSkillsCached(input: CachedProviderSkillsInput): Promise<ProviderSkills> {
  const now = (input.now ?? Date.now)();
  const home = claudeHome(input.env);
  const project = path.join(input.checkout, ".claude");
  const fixed = [
    project,
    path.join(project, "skills"),
    path.join(project, "commands"),
    path.join(home, "skills"),
    path.join(home, "commands"),
    path.join(home, "plugins", "installed_plugins.json"),
  ];

  const hit = cache.get(input.cacheKey);
  if (hit && now - hit.at < CACHE_TTL_MS && hit.stamp === (await directoryStamp([...fixed, ...hit.watched]))) return hit.value;

  const { value, watched } = await readProviderSkillsWithRoots(input);
  // STAMPED AFTER THE READ, over the roots the read actually found. Stamping
  // before it could only watch the previous answer's directories, so every
  // second call would compare a stamp of six paths against one of nine and
  // miss — a cache that never hits is worse than no cache at all.
  cache.set(input.cacheKey, { stamp: await directoryStamp([...fixed, ...watched]), at: now, value, watched });
  return value;
}

/** For tests, and for a daemon shutting down. Nothing in the cache outlives the
 *  process, so there is nothing here to persist. */
export function clearProviderSkillsCache(cacheKey?: string): void {
  if (cacheKey === undefined) cache.clear();
  else cache.delete(cacheKey);
}
