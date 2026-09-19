/**
 * THE ADOPT STEP — where `/resume` (#616) stops being two modules and becomes a
 * feature.
 *
 * `claude-fork.ts` copies a conversation; `claude-transcript.ts` reads one into
 * journal rows. Neither knows about the other, and neither knows which store on
 * this machine it is supposed to be working in. This file is the seam: it runs
 * both against the SAME Claude config directory the session's turns will run
 * against, asserts that the copy did not disturb the original, and returns one
 * object a store can write.
 *
 * ── THE CONFIG DIRECTORY IS THE TRAP, AND IT IS NOT A TEST-ONLY ONE ──────────
 *
 * `listSessions` and `forkSession` take no config-directory option. They read
 * `process.env.CLAUDE_CONFIG_DIR` at call time — inside the ENGINE's process,
 * which is not the environment a turn runs in. A Telar session routed to a
 * configured login runs its CLI with that login's `CLAUDE_CONFIG_DIR`
 * (`providerProcessEnv`), so a fork made without it would be cut from the wrong
 * person's history and land in a store the resumed turn will never look in.
 *
 * So the env var is SET AROUND THE CALL and restored after. Two facts make that
 * safe rather than a hack, and both were read off the pinned SDK (0.3.270):
 *
 *   - The resolved directory is memoised with lodash `memoize`, but its
 *     RESOLVER IS THE ENV VAR ITSELF (`() => process.env.CLAUDE_CONFIG_DIR`).
 *     The cache is therefore keyed on the value, so changing the variable in a
 *     long-lived process yields a fresh answer rather than the first one — which
 *     is what makes this work in the engine at all, where the process outlives
 *     every session.
 *   - `process.env` is process-wide, so two adoptions at once would race. Every
 *     call goes through one promise chain below; adoptions are rare and a fork
 *     is milliseconds, so serialising them costs nothing worth measuring.
 *
 * ── THE ASSERTION IS THE WHOLE POINT ────────────────────────────────────────
 *
 * Telar forks so that it never writes into somebody's own Claude Code history.
 * `forkClaudeConversation` returns the source's size and mtime AFTER the fork
 * precisely so a caller can check that rather than believe it, and a returned
 * value every caller ignores is not a guarantee, it is a comment. So this file
 * stats the source BEFORE, compares both numbers after, and refuses the
 * adoption if either moved. A person is better off with no adopted session than
 * with a silently-edited transcript of their own work.
 */
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
} from "./claude-fork";
import { readClaudeTranscriptFile, type ImportedRow, type TranscriptImport } from "./claude-transcript";

/**
 * WHERE ADOPTED CONVERSATIONS LIVE — one directory, not the session's own
 * working directory, and the difference is the promise.
 *
 * A native fork lands beside its parent, so the relocation is what keeps it out
 * of the person's `claude --resume` list. The obvious destination is the Telar
 * session's cwd, and for a WORKTREE session that is already under Telar's home
 * and works by accident. A `local` session's cwd is the PROJECT'S OWN CHECKOUT
 * — the very directory the person runs Claude Code in — so relocating there
 * would put the adopted copy straight back into their picker, next to the
 * conversation it was copied from, under a title they did not choose.
 *
 * One Telar-owned directory for every adoption removes the distinction. Lookup
 * by session id is global, so the fork stays resumable from any cwd, and new
 * turns append to it here rather than in whatever directory the CLI was run
 * from (measured, #616).
 */
export function adoptedForkHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.TELAR_HOME?.trim() || path.join(env.HOME ?? "", "Library", "Application Support", "Telar");
  return path.join(home, "adopted");
}

/**
 * Run something with a specific Claude config directory in effect.
 *
 * SERIALISED, because `process.env` belongs to the process rather than to the
 * caller — see the module header. An empty or absent `configDir` means the
 * provider's own default location, which for Claude is not the same thing as
 * pointing the variable AT that location: a set `CLAUDE_CONFIG_DIR` selects a
 * different, per-directory Keychain entry (`provider-instances.ts` carries the
 * scar). So absent is spelled by DELETING the variable, never by writing
 * `~/.claude` into it.
 */
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
  // The gate must not be poisoned by a failure: a refused adoption cannot leave
  // every later one rejected with somebody else's error.
  configGate = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * The conversations this login could adopt.
 *
 * A thin wrapper, and it exists for one reason: `listClaudeConversations`
 * reaches the SDK, and the SDK reads the config directory off `process.env`.
 * Callers that went straight to the fork module would list the engine's own
 * store while forking into the session's.
 */
export function listAdoptableConversations(
  options: ListOptions & { configDir?: string } = {},
): Promise<ClaudeConversation[]> {
  const { configDir, ...rest } = options;
  return withClaudeConfigDir(configDir, () =>
    listClaudeConversations({ ...rest, env: withConfigDir(rest.env ?? process.env, configDir) }),
  );
}

/** The env a helper reading `CLAUDE_CONFIG_DIR` itself should see — the same
 *  directory `withClaudeConfigDir` put on the process, so the two cannot
 *  disagree about which store is being read. */
function withConfigDir(env: NodeJS.ProcessEnv, configDir: string | undefined): NodeJS.ProcessEnv {
  if (!configDir?.trim()) {
    const { CLAUDE_CONFIG_DIR: _dropped, ...rest } = env;
    return rest;
  }
  return { ...env, CLAUDE_CONFIG_DIR: configDir };
}

export type AdoptOptions = {
  /** The conversation being adopted, by its id in the person's own store. */
  sourceSessionId: string;
  /** What the adopted copy is called. A fork that inherits its parent's
   *  auto-title cannot be told apart from it in any picker. */
  title: string;
  cut?: ForkCut;
  /** Restrict the search for the source to one project. Omit to search all. */
  sourceCwd?: string;
  /**
   * The login's config directory — `undefined` for the built-in slot, which
   * uses Claude's own default location. MUST be the one the session's turns
   * will run with, or the fork is cut from a store the resume will not find.
   */
  configDir?: string;
  /** Rows to import at most. The reader's own default when omitted. */
  maxRows?: number;
  env?: NodeJS.ProcessEnv;
  /**
   * THE SEAM THE ASSERTION NEEDS, and the only reason it exists.
   *
   * The refusal below fires when a fork disturbs the original — the one thing
   * this design promises cannot happen. A real fork cannot be ASKED to
   * misbehave, so without this the refusal path is unreachable from a test and
   * the guarantee rests on a branch nobody has ever executed. Production never
   * passes it; the test passes a real fork that also touches the source, which
   * is exactly the failure being guarded against.
   */
  fork?: typeof forkClaudeConversation;
};

export type Adoption = {
  fork: ForkOutcome;
  /** The imported history, oldest first, every row marked `imported`. */
  rows: ImportedRow[];
  /** The stamp — everything a reader in six weeks needs, in one object. */
  provenance: ConversationImportDetail;
  /** The reader's own account of what it kept, for the sentence on the row. */
  read: TranscriptImport;
};

/**
 * Adopt a conversation: fork it, prove the original survived, and read the fork
 * back as journal rows.
 *
 * WRITES NOTHING TO THE STORE. Everything here is about Claude's files and the
 * shapes Telar's journal wants; which session receives them, and which run the
 * rows belong to, is `EngineStore.adoptClaudeConversation`'s decision. Keeping
 * the seam there is what lets this be tested against a real Claude store with
 * no engine running.
 */
export async function adoptClaudeConversation(options: AdoptOptions): Promise<Adoption> {
  const env = withConfigDir(options.env ?? process.env, options.configDir);
  const projects = claudeProjectsRoot(env);

  /**
   * THE BEFORE HALF OF THE ASSERTION, read before anything is forked. The
   * source is located twice — here and inside the fork — which is two `stat`s
   * on a path, and buys the comparison an independent left-hand side rather
   * than one the fork reported to itself.
   */
  const sourcePath = findTranscript(projects, options.sourceSessionId);
  if (!sourcePath) throw new Error(`No conversation found with session ID: ${options.sourceSessionId}`);
  const before = fs.statSync(sourcePath);

  const cutFork = options.fork ?? forkClaudeConversation;
  const fork = await withClaudeConfigDir(options.configDir, () =>
    cutFork({
      sourceSessionId: options.sourceSessionId,
      // NOT the session's working directory — see `adoptedForkHome`.
      cwd: adoptedForkHome(env),
      title: options.title,
      ...(options.cut ? { cut: options.cut } : {}),
      ...(options.sourceCwd ? { sourceCwd: options.sourceCwd } : {}),
      env,
    }),
  );

  /**
   * THE ASSERTION ITSELF. Size and mtime, both, and both compared rather than
   * logged: a fork that touched the original has broken the one promise the
   * whole design was chosen for, and the honest response is to refuse the
   * adoption and say which number moved.
   *
   * The forked copy is removed first. Leaving it behind would put a file in
   * Telar's own directory that no session will ever resume, and the person
   * would have both a failure and litter.
   */
  if (fork.source.bytes !== before.size || fork.source.mtimeMs !== before.mtimeMs) {
    try {
      fs.rmSync(fork.transcriptPath, { force: true });
    } catch {
      // Best effort. The refusal below is the thing that matters.
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

/**
 * The conversation's own opening words, for the one field that actually
 * distinguishes two conversations.
 *
 * TAKEN FROM THE IMPORTED ROWS rather than from `listSessions`, because the two
 * can legitimately disagree: the reader cuts at a compaction boundary, so the
 * first row it kept may be long after the conversation began, and quoting the
 * original opening on a row that shows none of it would misdescribe what was
 * imported. Absent when the import kept no message of the person's at all.
 */
function openingPrompt(read: TranscriptImport): string | undefined {
  for (const row of read.rows) {
    if (row.detail.type !== "user_message") continue;
    const text = row.detail.text.replace(/\s+/g, " ").trim();
    if (text) return text.length > 500 ? `${text.slice(0, 499)}…` : text;
  }
  return undefined;
}

/**
 * The sentence the adopted turn carries — what `sessions_read`'s fold and every
 * list view show for this turn without opening its rows.
 *
 * NAMES THE SOURCE ID. It is the only handle on "which of my conversations was
 * this", and a title is not one: the CLI's own titles do not distinguish
 * conversations, which is the finding the whole picker was designed around.
 */
export function describeAdoption(provenance: ConversationImportDetail): string {
  const where = provenance.sourceCwd ? ` from ${provenance.sourceCwd}` : "";
  return `Imported a Claude Code conversation${where} (${provenance.sourceSessionId}) — ${provenance.rows} ${
    provenance.rows === 1 ? "row" : "rows"
  } of history, resumed as ${provenance.sessionId}.`;
}
