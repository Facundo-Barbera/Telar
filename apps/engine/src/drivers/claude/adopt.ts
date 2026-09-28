import fs from "node:fs";
import path from "node:path";
import type { ConversationImportDetail } from "@telar/engine-client";
import {
  claudeProjectsRoot,
  findTranscript,
  forkClaudeConversation,
  listClaudeConversations,
  type ClaudeConversation,
  type ForkCut,
  type ForkOutcome,
  type ListOptions,
} from ".";
import { readClaudeTranscriptFile, type ImportedRow, type TranscriptImport } from ".";

export function adoptedForkHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.TELAR_HOME?.trim() || path.join(env.HOME ?? "", "Library", "Application Support", "Telar");
  return path.join(home, "adopted");
}

let configGate: Promise<unknown> = Promise.resolve();
export function withClaudeConfigDir<T>(configDir: string | undefined, work: () => Promise<T>): Promise<T> {
  const run = configGate.then(async () => {
    const had = Object.hasOwn(process.env, "CLAUDE_CONFIG_DIR");
    const previous = process.env.CLAUDE_CONFIG_DIR;
    if (configDir?.trim()) process.env.CLAUDE_CONFIG_DIR = configDir;
    else delete process.env.CLAUDE_CONFIG_DIR;
    try {
      return await work();
    } finally {
      if (had && previous !== undefined) process.env.CLAUDE_CONFIG_DIR = previous;
      else delete process.env.CLAUDE_CONFIG_DIR;
    }
  });
  configGate = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function listAdoptableConversations(
  options: ListOptions & { configDir?: string; forkHome?: string } = {},
): Promise<ClaudeConversation[]> {
  const { configDir, forkHome, ...rest } = options;
  const env = withConfigDir(rest.env ?? process.env, configDir);
  return withClaudeConfigDir(configDir, () =>
    listClaudeConversations({ ...rest, env, adoptedRoot: forkHome ?? adoptedForkHome(env) }),
  );
}

function withConfigDir(env: NodeJS.ProcessEnv, configDir: string | undefined): NodeJS.ProcessEnv {
  if (!configDir?.trim()) {
    const { CLAUDE_CONFIG_DIR: _dropped, ...rest } = env;
    return rest;
  }
  return { ...env, CLAUDE_CONFIG_DIR: configDir };
}

export type AdoptOptions = {
  sourceSessionId: string;
  title: string;
  cut?: ForkCut;
  sourceCwd?: string;
  configDir?: string;
  maxRows?: number;
  forkHome?: string;
  env?: NodeJS.ProcessEnv;
  fork?: typeof forkClaudeConversation;
};

export type Adoption = {
  fork: ForkOutcome;
  rows: ImportedRow[];
  provenance: ConversationImportDetail;
  read: TranscriptImport;
};

export async function adoptClaudeConversation(options: AdoptOptions): Promise<Adoption> {
  const env = withConfigDir(options.env ?? process.env, options.configDir);
  const projects = claudeProjectsRoot(env);

  const sourcePath = findTranscript(projects, options.sourceSessionId);
  if (!sourcePath) throw new Error(`No conversation found with session ID: ${options.sourceSessionId}`);
  const before = fs.statSync(sourcePath);

  const cutFork = options.fork ?? forkClaudeConversation;
  const fork = await withClaudeConfigDir(options.configDir, () =>
    cutFork({
      sourceSessionId: options.sourceSessionId,
      cwd: options.forkHome ?? adoptedForkHome(env),
      title: options.title,
      ...(options.cut ? { cut: options.cut } : {}),
      ...(options.sourceCwd ? { sourceCwd: options.sourceCwd } : {}),
      env,
    }),
  );

  if (fork.source.bytes !== before.size || fork.source.mtimeMs !== before.mtimeMs) {
    try {
      fs.rmSync(fork.transcriptPath, { force: true });
    } catch {
    }
    const what = fork.source.bytes !== before.size ? "size" : "modification time";
    throw new Error(
      `Adopting ${options.sourceSessionId} changed the original transcript's ${what}, which must never happen. ` +
        `Nothing was adopted and the copy was removed; your Claude Code history is as it was.`,
    );
  }

  const read = readClaudeTranscriptFile(fork.transcriptPath, options.maxRows ? { maxRows: options.maxRows } : {});

  const firstPrompt = openingPrompt(read);
  const provenance: ConversationImportDetail = {
    provider: "claude",
    sourceSessionId: options.sourceSessionId,
    sessionId: fork.sessionId,
    ...(read.cwd ? { sourceCwd: read.cwd } : {}),
    ...(firstPrompt ? { firstPrompt } : {}),
    records: fork.records,
    cut: fork.cut,
    rows: read.rows.length,
    rowCut: read.cut.kind,
    sourceBytes: fork.source.bytes,
  };

  return { fork, rows: read.rows, provenance, read };
}

function openingPrompt(read: TranscriptImport): string | undefined {
  for (const row of read.rows) {
    if (row.detail.type !== "user_message") continue;
    const text = row.detail.text.replace(/\s+/g, " ").trim();
    if (text) return text.length > 500 ? `${text.slice(0, 499)}…` : text;
  }
  return undefined;
}

export function describeAdoption(provenance: ConversationImportDetail): string {
  const where = provenance.sourceCwd ? ` from ${provenance.sourceCwd}` : "";
  return `Imported a Claude Code conversation${where} (${provenance.sourceSessionId}) — ${provenance.rows} ${
    provenance.rows === 1 ? "row" : "rows"
  } of history, resumed as ${provenance.sessionId}.`;
}
