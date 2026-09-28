import fs from "node:fs";
import path from "node:path";
import { forkSession, listSessions } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeConversation } from "@telar/engine-client";

export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

export function claudeProjectsRoot(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.CLAUDE_CONFIG_DIR?.trim() || path.join(env.HOME ?? "", ".claude");
  return path.join(home, "projects");
}

export type { ClaudeConversation };

export type ListOptions = {
  cwd?: string;
  limit?: number;
  includeAdopted?: boolean;
  adoptedRoot?: string;
  env?: NodeJS.ProcessEnv;
};

export async function listClaudeConversations(options: ListOptions = {}): Promise<ClaudeConversation[]> {
  const env = options.env ?? process.env;
  const adopted = options.includeAdopted ? new Set<string>() : adoptedSessionIds(env, options.adoptedRoot);
  const sessions = await listSessions({
    ...(options.cwd ? { dir: options.cwd } : {}),
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
  });
  const rows: ClaudeConversation[] = [];
  for (const session of sessions) {
    if (adopted.has(session.sessionId)) continue;
    rows.push({
      sessionId: session.sessionId,
      title: session.summary,
      ...(session.firstPrompt ? { firstPrompt: session.firstPrompt } : {}),
      ...(session.customTitle ? { customTitle: session.customTitle } : {}),
      lastActivityAt: session.lastModified,
      ...(session.createdAt !== undefined ? { createdAt: session.createdAt } : {}),
      ...(session.cwd ? { cwd: session.cwd } : {}),
      ...(session.gitBranch ? { gitBranch: session.gitBranch } : {}),
      ...(session.fileSize !== undefined ? { bytes: session.fileSize } : {}),
    });
  }
  rows.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  return rows;
}

export type ForkCut = "whole" | "since_compact_boundary";

type ForkOptions = {
  sourceSessionId: string;
  cwd: string;
  title: string;
  cut?: ForkCut;
  sourceCwd?: string;
  env?: NodeJS.ProcessEnv;
};

export type ForkOutcome = {
  sessionId: string;
  transcriptPath: string;
  sourceSessionId: string;
  cut: ForkCut;
  records: number;
  bytes: number;
  source: { bytes: number; mtimeMs: number; path: string };
};

export async function forkClaudeConversation(options: ForkOptions): Promise<ForkOutcome> {
  const env = options.env ?? process.env;
  const cut = options.cut ?? "whole";
  const projects = claudeProjectsRoot(env);

  const sourcePath = findTranscript(projects, options.sourceSessionId);
  if (!sourcePath) {
    throw new Error(`No conversation found with session ID: ${options.sourceSessionId}`);
  }

  const forked = await forkSession(options.sourceSessionId, {
    ...(options.sourceCwd ? { dir: options.sourceCwd } : {}),
    title: options.title,
  });

  const landed = findTranscript(projects, forked.sessionId);
  if (!landed) throw new Error(`The fork of ${options.sourceSessionId} was not written where it could be found.`);

  const home = path.join(projects, claudeProjectSlug(options.cwd));
  fs.mkdirSync(home, { recursive: true });
  const destination = path.join(home, `${forked.sessionId}.jsonl`);
  if (path.resolve(landed) !== path.resolve(destination)) fs.renameSync(landed, destination);

  const records = cut === "since_compact_boundary" ? trimToLastBoundary(destination) : countRecords(destination);

  const source = fs.statSync(sourcePath);
  return {
    sessionId: forked.sessionId,
    transcriptPath: destination,
    sourceSessionId: options.sourceSessionId,
    cut,
    records,
    bytes: fs.statSync(destination).size,
    source: { bytes: source.size, mtimeMs: source.mtimeMs, path: sourcePath },
  };
}

function trimToLastBoundary(transcriptPath: string): number {
  const lines = fs.readFileSync(transcriptPath, "utf8").split("\n");
  let boundary = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line?.trim()) continue;
    if (!line.includes('"compact_boundary"')) continue;
    try {
      const record = JSON.parse(line) as { subtype?: string };
      if (record.subtype === "compact_boundary") {
        boundary = i;
        break;
      }
    } catch {
    }
  }
  if (boundary < 0) return countRecords(transcriptPath);
  const kept = lines.slice(boundary).filter((line) => line.trim());
  fs.writeFileSync(transcriptPath, `${kept.join("\n")}\n`);
  return kept.length;
}

function countRecords(transcriptPath: string): number {
  return fs
    .readFileSync(transcriptPath, "utf8")
    .split("\n")
    .filter((line) => line.trim()).length;
}

export function findTranscript(projectsRoot: string, sessionId: string): string | undefined {
  let entries: string[];
  try {
    entries = fs.readdirSync(projectsRoot);
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    const candidate = path.join(projectsRoot, entry, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

function forkHomeRoot(env: NodeJS.ProcessEnv): string {
  return env.TELAR_HOME?.trim() || path.join(env.HOME ?? "", "Library", "Application Support", "Telar");
}

function adoptedSessionIds(env: NodeJS.ProcessEnv, adoptedRoot?: string): Set<string> {
  const projects = claudeProjectsRoot(env);
  const prefix = claudeProjectSlug(adoptedRoot?.trim() || forkHomeRoot(env));
  const ids = new Set<string>();
  let entries: string[];
  try {
    entries = fs.readdirSync(projects);
  } catch {
    return ids;
  }
  for (const entry of entries) {
    if (entry !== prefix && !entry.startsWith(`${prefix}-`)) continue;
    let files: string[];
    try {
      files = fs.readdirSync(path.join(projects, entry));
    } catch {
      continue;
    }
    for (const file of files) if (file.endsWith(".jsonl")) ids.add(file.slice(0, -".jsonl".length));
  }
  return ids;
}
