import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProviderDriverKind, ProviderSkill, ProviderSkillSource, ProviderSkills } from "@telar/engine-client";
import { refuseCliSpawnUnderTest, requireCli } from "./cli";

const SUPPORTED_COMMANDS_TIMEOUT_MS = 5_000;

const MAX_ENTRIES_PER_SOURCE = 250;

const MAX_COMMAND_DEPTH = 3;

const MAX_NESTED_DEPTH = 4;

const MAX_NESTED_ROOTS = 32;

const NEVER_DESCEND = new Set(["node_modules", "dist", "build", "out", "target", "vendor", "coverage", "tmp"]);

function claudeHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), ".claude");
}

export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
}

export function openCodeHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.OPENCODE_CONFIG?.trim();
  if (configured) return path.dirname(configured);
  const xdg = env.XDG_CONFIG_HOME?.trim();
  return path.join(xdg || path.join(os.homedir(), ".config"), "opencode");
}

export function providerSkillRoot(driver: ProviderDriverKind, env: NodeJS.ProcessEnv = process.env): string {
  if (driver === "codex") return path.join(codexHome(env), "skills");
  if (driver === "opencode") return path.join(openCodeHome(env), "skill");
  return path.join(claudeHome(env), "skills");
}

export function providerSkillRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  return [...new Set((["claude", "codex", "opencode"] as const).map((driver) => providerSkillRoot(driver, env)))];
}

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

export function fallbackDescription(text: string): string {
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  let fenced = false;
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      fenced = !fenced;
      continue;
    }
    if (fenced || !trimmed) continue;
    const heading = /^#{1,6}\s+(.*)$/.exec(trimmed);
    if (heading) return (heading[1] ?? "").trim();
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

export async function findScopedClaudeRoots(checkout: string, maxDepth = MAX_NESTED_DEPTH): Promise<{ scope: string; root: string }[]> {
  const found: { scope: string; root: string }[] = [];

  const walk = async (directory: string, segments: string[]): Promise<void> => {
    if (segments.length >= maxDepth || found.length >= MAX_NESTED_ROOTS) return;
    for (const entry of await entriesOf(directory)) {
      if (found.length >= MAX_NESTED_ROOTS) return;
      const full = path.join(directory, entry);
      if (entry === ".claude") {
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
    const plugin = key.split("@")[0] ?? key;
    if (!plugin || !Array.isArray(value)) continue;
    for (const install of value) {
      const root = (install as { installPath?: unknown } | null)?.installPath;
      if (typeof root === "string" && root) roots.push({ plugin, root });
    }
  }
  return roots;
}

type ClaudeCommandQuery = { supportedCommands(): Promise<unknown> };
type ClaudeCommandSdk = {
  query(input: { prompt: AsyncIterable<never>; options: Record<string, unknown> }): ClaudeCommandQuery;
};

export type LoadProviderCommands = (input: { driver: ProviderDriverKind; cwd: string }) => Promise<ProviderSkill[]>;

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
      executable = undefined;
    }
    const session = sdk.query({
      prompt: silent(),
      options: {
        cwd,
        permissionMode: "default",
        abortController: controller,
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
    return [];
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  }
}

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

type ProviderSkillsInput = {
  driver: ProviderDriverKind;
  checkout: string;
  env?: NodeJS.ProcessEnv;
  loadProviderCommands?: LoadProviderCommands;
};

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

async function readProviderSkillsWithRoots(input: ProviderSkillsInput): Promise<{ value: ProviderSkills; watched: string[] }> {
  if (input.driver !== "claude") {
    const root = providerSkillRoot(input.driver, input.env);
    return { value: { skills: await readSkillDirectory(root, "user"), commands: [] }, watched: [root] };
  }

  const home = claudeHome(input.env);
  const project = path.join(input.checkout, ".claude");
  const [pluginRoots, scopedRoots] = await Promise.all([installedPluginRoots(home), findScopedClaudeRoots(input.checkout)]);

  const [userSkills, projectSkills, scopedSkills, userCommands, projectCommands, scopedCommands, pluginSkills, pluginCommands, providerCommands] =
    await Promise.all([
      readSkillDirectory(path.join(home, "skills"), "user"),
      readSkillDirectory(path.join(project, "skills"), "project"),
      Promise.all(scopedRoots.map((entry) => readSkillDirectory(path.join(entry.root, "skills"), "project", entry.scope))).then((all) => all.flat()),
      readCommandDirectory(path.join(home, "commands"), "user"),
      readCommandDirectory(path.join(project, "commands"), "project"),
      Promise.all(scopedRoots.map((entry) => readCommandDirectory(path.join(entry.root, "commands"), "project", entry.scope))).then((all) => all.flat()),
      Promise.all(pluginRoots.map((entry) => readSkillDirectory(path.join(entry.root, "skills"), "plugin", entry.plugin))).then((all) => all.flat()),
      Promise.all(pluginRoots.map((entry) => readCommandDirectory(path.join(entry.root, "commands"), "plugin", entry.plugin))).then((all) => all.flat()),
      (input.loadProviderCommands ?? loadClaudeCommands)({ driver: input.driver, cwd: input.checkout }),
    ]);

  const skills = dedupe([projectSkills, scopedSkills, userSkills, pluginSkills]);
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

const CACHE_TTL_MS = 60_000;

type CacheEntry = { stamp: string; at: number; value: ProviderSkills; watched: string[] };
const cache = new Map<string, CacheEntry>();

async function directoryStamp(directories: readonly string[]): Promise<string> {
  const parts = await Promise.all(
    directories.map(async (directory) => {
      try {
        return `${directory}:${(await fs.stat(directory)).mtimeMs}`;
      } catch {
        return `${directory}:-`;
      }
    }),
  );
  return parts.join("|");
}

type CachedProviderSkillsInput = ProviderSkillsInput & {
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
  cache.set(input.cacheKey, { stamp: await directoryStamp([...fixed, ...watched]), at: now, value, watched });
  return value;
}

export function clearProviderSkillsCache(cacheKey?: string): void {
  if (cacheKey === undefined) cache.clear();
  else cache.delete(cacheKey);
}
