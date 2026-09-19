/**
 * ADOPTING somebody else's Claude Code conversation — the half of #616 that
 * `claude-transcript.ts` deliberately left alone. The reader turns a transcript
 * into rows the cockpit can draw; this file is what makes the session CONTINUE,
 * and it exists because of one decision: Telar FORKS rather than resuming in
 * place.
 *
 * WHY FORK AT ALL. Resuming a foreign session id works — it was measured, on a
 * real terminal transcript, context intact — but at CLI 2.1.275 resume APPENDS
 * TO THE SAME FILE AND KEEPS THE SAME ID. So a Telar turn on an adopted
 * conversation writes into the person's own Claude Code history, in their own
 * project directory, where their own `claude --resume` will show it. That is
 * their tool, not ours, and we do not get to write in it. Forking is the
 * harder option and it is the one taken.
 *
 * THERE ARE TWO FORK MECHANISMS AND THEY ARE NOT THE SAME OPERATION. Both were
 * measured against the pinned SDK (0.3.270) and CLI 2.1.275:
 *
 *   `query({ options: { resume, forkSession: true } })` — what `--fork-session`
 *   does. Preserves every record `uuid` (19 of 19 on a measured fork), lands in
 *   the slug directory of the cwd PASSED rather than the source's, and stamps
 *   NO provenance at all: the forked file mentions the source id zero times.
 *   It also only happens when a turn runs, so a session adopted but not yet
 *   spoken to has no fork.
 *
 *   `forkSession(id, { title })` — the SDK's own helper, and what this file
 *   uses. A pure file operation: no model call, no CLI process, milliseconds.
 *   It REMAPS every record uuid, and in exchange stamps
 *   `forkedFrom: { sessionId, messageUuid }` on every copied record — which
 *   both records where the fork came from AND maps each new record back to the
 *   source record it copies, so the remap costs no traceability. It takes a
 *   `title`, which matters because a fork that inherits its parent's
 *   auto-title is indistinguishable from it in a picker (measured: six
 *   identically-titled sessions the CLI itself refused to disambiguate).
 *
 * WHAT THE HELPER WILL NOT DO IS CHOOSE WHERE THE FORK LANDS. Its `dir` option
 * scopes the search for the SOURCE, not the destination; the fork is written
 * beside its parent. So the relocation below is ours, and it is the step that
 * keeps the promise: lookup by session id searches every project directory,
 * while the picker and title lookup are scoped to one, so a fork MOVED out of
 * the person's project directory stays resumable by Telar and stays invisible
 * in their own `claude --resume`. Measured both ways, including that new turns
 * append to the fork in its new home.
 *
 * THE ORIGINAL IS NEVER WRITTEN TO. Measured rather than assumed: after a fork
 * and three subsequent turns, the source transcript was byte-identical — same
 * size, same mtime, same sha256. That is the guarantee the whole decision was
 * made for, and `forkClaudeConversation` returns the source's size and mtime so
 * a caller can assert it rather than trust this comment.
 */
import fs from "node:fs";
import path from "node:path";
import { forkSession, listSessions } from "@anthropic-ai/claude-agent-sdk";

/**
 * Claude's own encoding of a working directory into a project-directory name:
 * every character that is not a letter or a digit becomes a dash. Derived by
 * probing `listSessions({ dir })` with candidate spellings of a path carrying
 * a space, a dot and an underscore — `/Users/x/My Project/a.b_c` resolves to
 * `-Users-x-My-Project-a-b-c`, so it is not just the path separator.
 */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/** `~/.claude/projects`, honouring `CLAUDE_CONFIG_DIR` the way `usage.ts` does. */
export function claudeProjectsRoot(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.CLAUDE_CONFIG_DIR?.trim() || path.join(env.HOME ?? "", ".claude");
  return path.join(home, "projects");
}

/**
 * One conversation as the picker needs to show it. #616 asks for "enough to
 * recognise one", and the failure to design against is the one the CLI itself
 * falls into: rows that are all the same sentence. So `title` is never the
 * only distinguishing field a caller has — `firstPrompt`, `lastActivityAt`,
 * `cwd` and `bytes` are carried precisely so two conversations that share a
 * title are still tellable apart.
 */
export type ClaudeConversation = {
  sessionId: string;
  /** Custom title, else the CLI's auto-title, else the first prompt. */
  title: string;
  /** The first real user prompt, when the CLI extracted one. */
  firstPrompt?: string;
  /** Set only when the person renamed it themselves, via `/rename`. */
  customTitle?: string;
  lastActivityAt: number;
  createdAt?: number;
  cwd?: string;
  gitBranch?: string;
  /** Transcript size on disk. Local JSONL storage only. */
  bytes?: number;
};

export type ListOptions = {
  /** Restrict to one project's conversations. Omit for every project. */
  cwd?: string;
  limit?: number;
  /**
   * Conversations Telar already adopted, hidden by default. A fork of a
   * conversation is not itself something to adopt, and offering it would let
   * a person fork a fork without ever being told that is what they did.
   */
  includeAdopted?: boolean;
  env?: NodeJS.ProcessEnv;
};

/**
 * The conversations a person could adopt, newest first.
 *
 * This is `listSessions` with Telar's own forks filtered out, and it is
 * deliberately thin: the SDK already extracts the title, the first prompt and
 * the timestamps from each transcript's head and tail without reading the
 * whole file, which is the same reason `claude-transcript.ts` reads backward
 * from EOF. Re-deriving any of it here would be a second implementation of
 * somebody else's format.
 */
export async function listClaudeConversations(options: ListOptions = {}): Promise<ClaudeConversation[]> {
  const env = options.env ?? process.env;
  const adopted = options.includeAdopted ? new Set<string>() : adoptedSessionIds(env);
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

/**
 * WHERE A FORK IS CUT, and the knob this file exists to keep as a knob rather
 * than a branch.
 *
 * `whole` copies the conversation entire. `since_compact_boundary` keeps only
 * what follows Claude's own last compaction — the same edge
 * `claude-transcript.ts` cuts the IMPORT at, which is what makes the pair
 * coherent: a boundary is where the CLI threw its own history away, so cutting
 * a fork there too makes what the cockpit shows and what the model remembers
 * the SAME SET, rather than leaving the model a past the cockpit never draws.
 *
 * THE DEFAULT IS `whole`, AND IT IS THE DEFAULT ONLY BECAUSE ONE QUESTION IS
 * OPEN: whether the CLI, on resume, re-derives context from records BEFORE a
 * compaction boundary rather than honouring the compaction it recorded.
 * Settling it needs a genuinely compacted transcript, which means filling 200k
 * of context, and that spend was judged not worth it while the knob makes it
 * cheap to settle later. The asymmetry is why `whole` wins for now:
 *
 *   - ship `since_compact_boundary` and the CLI DOES re-derive → the model
 *     silently gets less than it could have had, which fails quietly and late
 *   - ship `whole` and the CLI honours the compaction → bytes were copied for
 *     nothing and no behaviour was lost
 *
 * SO: point a resume at a real compacted transcript and compare what it can
 * recall from before the boundary. If it recalls nothing, the CLI honours its
 * compaction, `since_compact_boundary` costs no context, and flipping this
 * default buys a bounded fork — a 212 MB transcript copied as a few hundred
 * KB instead of 212 MB — for free.
 */
export type ForkCut = "whole" | "since_compact_boundary";

export type ForkOptions = {
  /** The conversation being adopted. */
  sourceSessionId: string;
  /**
   * The Telar session's working directory. The fork is relocated into THIS
   * project's directory, which is what keeps it out of the person's own picker
   * while leaving it resumable by id.
   */
  cwd: string;
  /** What the fork is called. A fork that inherits its parent's title cannot
   *  be told apart from it, so this is not optional. */
  title: string;
  cut?: ForkCut;
  /** Restrict the search for the source. Omit to search every project. */
  sourceCwd?: string;
  env?: NodeJS.ProcessEnv;
};

export type ForkOutcome = {
  /** The new session id. Hand this to the driver's `resume`. */
  sessionId: string;
  /** Where the fork now lives, after relocation. */
  transcriptPath: string;
  sourceSessionId: string;
  cut: ForkCut;
  /** Records carried into the fork. */
  records: number;
  bytes: number;
  /**
   * The SOURCE's size and mtime, read AFTER the fork. The promise this whole
   * file is built on is that adopting a conversation does not touch it, and a
   * caller that wants to assert that rather than trust it needs these.
   */
  source: { bytes: number; mtimeMs: number; path: string };
};

/**
 * Fork a conversation into a Telar-owned copy, and return the id to resume.
 *
 * Three steps, and the middle one is the one that is ours: the SDK forks
 * (stamping `forkedFrom` and the title), we relocate the result out of the
 * person's project directory, and — when the cut asks for it — we rewrite the
 * file down to the tail the cockpit will actually show.
 */
export async function forkClaudeConversation(options: ForkOptions): Promise<ForkOutcome> {
  const env = options.env ?? process.env;
  const cut = options.cut ?? "whole";
  const projects = claudeProjectsRoot(env);

  const sourcePath = findTranscript(projects, options.sourceSessionId);
  if (!sourcePath) {
    // The same shape the CLI already fails in, and #616 asks for a sentence
    // rather than a stack trace.
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
  // RELOCATION, not a copy: leaving the original fork behind would put the
  // very row in their picker that moving it exists to avoid.
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

/**
 * Cut the fork down to the records at and after Claude's last compaction
 * boundary, in place.
 *
 * THIS IS A FILE-ORDER SLICE, not a re-walk of the conversation tree, and that
 * is deliberate. What remains is literally what the transcript contained from
 * the boundary onward — including any abandoned branch — which is exactly the
 * shape the CLI already reads every day: it walks `parentUuid` itself and
 * ignores what is off the path. Re-deriving the live path here would be a
 * second implementation of `claude-transcript.ts`'s walk with no reader to
 * keep it honest.
 *
 * The head record's `parentUuid` is left dangling on purpose — measured, the
 * CLI resumes such a file with context intact and does not complain, and
 * nulling it would misrepresent a record that genuinely had a parent.
 *
 * Returns the records kept. A transcript with no boundary in it is left whole,
 * because there is no principled place to cut one.
 */
function trimToLastBoundary(transcriptPath: string): number {
  const lines = fs.readFileSync(transcriptPath, "utf8").split("\n");
  let boundary = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line?.trim()) continue;
    // Cheap enough to test before parsing: a boundary record is rare and the
    // marker is unambiguous.
    if (!line.includes('"compact_boundary"')) continue;
    try {
      const record = JSON.parse(line) as { subtype?: string };
      if (record.subtype === "compact_boundary") {
        boundary = i;
        break;
      }
    } catch {
      // A half-written line is not a boundary.
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

/**
 * A transcript by id, across every project directory — the same search the
 * CLI does, and the reason a relocated fork stays resumable. Stats rather than
 * reads: a 212 MB transcript must not be opened to be located.
 */
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

/**
 * Where Telar keeps the conversations it has adopted. Not a constant path:
 * every Telar session has its own working directory, so this is the ROOT those
 * directories sit under.
 */
function forkHomeRoot(env: NodeJS.ProcessEnv): string {
  return env.TELAR_HOME?.trim() || path.join(env.HOME ?? "", "Library", "Application Support", "Telar");
}

/**
 * The ids of conversations Telar already adopted, recognised BY WHICH
 * DIRECTORY THEY LIVE IN rather than by anything inside them.
 *
 * The obvious test — does the transcript's `cwd` sit under Telar's home —
 * does not work, and the reason is worth keeping: a fork's copied records
 * still carry the SOURCE's cwd, because that is where those turns actually
 * happened. `listSessions` reads `cwd` out of the records, so a fork reports
 * the cwd of the conversation it came from. Its LOCATION is what makes it
 * ours, so location is what is checked.
 *
 * The prefix match inherits the slug encoding's ambiguity — `/x/telar/a` and
 * `/x/telar-a` encode identically — which is the CLI's own and not worth
 * out-thinking here.
 */
function adoptedSessionIds(env: NodeJS.ProcessEnv): Set<string> {
  const projects = claudeProjectsRoot(env);
  const prefix = claudeProjectSlug(forkHomeRoot(env));
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

/**
 * What the cockpit should say about an adoption. One sentence, in the same
 * spirit as `describeImport`: a person who adopted a conversation should be
 * told it was copied, not left to discover it.
 */
export function describeFork(outcome: ForkOutcome): string {
  const where = outcome.cut === "since_compact_boundary" ? " since its last context compaction" : "";
  return `Forked this conversation into a Telar copy — ${outcome.records} records${where}. Your own Claude Code history is untouched.`;
}
