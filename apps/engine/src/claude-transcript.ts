/**
 * Claude Code's own transcript, read as Telar journal rows — the half of #616
 * that makes an adopted conversation READABLE. Adoption itself is cheap: the
 * CLI's `--resume` finds a foreign session id and replays the whole
 * conversation into context (measured on a real 222 KB terminal transcript:
 * 55,031 cache-creation tokens, and the model answered from the middle of the
 * thread). What adoption does NOT do is give the cockpit anything to draw, so a
 * session whose model remembers everything looks empty. This file is the fix.
 *
 * THE FILE IS `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl`, one JSON
 * record per line, append-only. `apps/engine/src/usage.ts` already reads these
 * for spend; it needs three record types and skips the rest by byte-scanning.
 * A transcript reader needs the shape, so this is a real parse — and everything
 * below is measured against the files on this machine (2,536 transcripts, the
 * largest 212 MB / 37,298 lines), not against documentation.
 *
 * FOUR THINGS ARE LOAD-BEARING.
 *
 * ORDER COMES FROM `parentUuid`, NOT FROM FILE ORDER. A transcript is a TREE,
 * not a list: editing a message or rewinding starts a new branch and the
 * abandoned one stays on disk forever. Reading the file top to bottom renders
 * both branches interleaved — the conversation as it never happened. Walking
 * back from the last record through `parentUuid` yields the one path that is
 * actually live. Measured: that walk drops 3, 4 and 8 records on three real
 * terminal transcripts, and 5,611 of 28,541 on a long one. File order would
 * have shown every one of them as real.
 *
 * THE WALK RUNS BACKWARD, and that is what bounds the cost. A 212 MB transcript
 * must not be parsed to show its last hundred rows, and it does not have to be:
 * the log is append-only, so a record's parent always precedes it, and a
 * reverse scan meets each parent just before it is needed. The scan stops at
 * the cut — everything earlier in the file is never parsed at all.
 *
 * THE CUT IS CLAUDE'S OWN COMPACTION BOUNDARY when there is one. A
 * `system`/`compact_boundary` record is the point where the CLI threw its own
 * history away, so the rows after it are precisely what the resumed model still
 * remembers — a principled edge rather than an arbitrary row count, and the one
 * place where "what we kept" and "what it knows" agree. Where no boundary is in
 * reach, a row budget cuts instead. Measured against the five largest
 * transcripts on this machine (212 MB down to 55 MB): 72 to 125 rows each, 17
 * to 25 ms, and no measurable heap growth.
 *
 * THE SUMMARY IS ALREADY WRITTEN. #616 asks for a bounded tail PLUS a summary
 * of the rest, and the obvious reading — generate one — is unnecessary: after
 * every compaction the CLI writes the summary it generated as a `user` record
 * flagged `isCompactSummary`, typically 10-15 KB of prose covering everything
 * before the boundary. So the summary is verbatim provider output, costs
 * nothing, and is the same text the model itself was handed. It is emitted as
 * its own row type, never as the person's message — a 14 KB block rendered as
 * a user bubble is exactly the lie this file exists to avoid.
 *
 * EVERY ROW IS MARKED `imported`. A row that claims to be a Telar turn it never
 * was misleads every later reader, the Agent's digest included.
 */
import fs from "node:fs";
import type { ItemDetail, ItemStatus, ProviderRefs } from "@telar/engine-client";
import { itemDetailForToolCall, titleForToolCall } from "./driver";

/**
 * One journal row read out of a transcript, in the shape `Item` wants minus the
 * identity the store assigns. Producing `Item`s directly would mean inventing
 * ids and a `runId` here, and which run an imported row belongs to is the
 * ADOPT step's decision, not the reader's — the seam #616 asks to keep narrow.
 */
export type ImportedRow = {
  detail: ItemDetail;
  title?: string;
  status: ItemStatus;
  startedAt: number;
  completedAt?: number;
  /** Always true. The row did not come from a turn this engine ran. */
  imported: true;
  /** The transcript's own `uuid` and session id, so a row can be traced back. */
  providerRefs: ProviderRefs;
};

/** Why the import stopped where it did — the UI's sentence comes from this. */
export type TranscriptCut =
  | { kind: "whole"; }
  | { kind: "compact_boundary"; at: number; droppedTokens?: number }
  | { kind: "row_budget"; budget: number };

export type TranscriptImport = {
  rows: ImportedRow[];
  cut: TranscriptCut;
  /**
   * Claude's own summary of everything before the cut, verbatim, when the cut
   * was a compaction boundary that had one. Absent otherwise — never invented.
   */
  priorSummary?: string;
  /** Records on the live path that produced no row, by transcript type. Here to
   *  be asserted on: a type that starts mattering shows up as a rising count
   *  rather than as rows silently going missing. */
  dropped: Record<string, number>;
  /** Lines that were not JSON. A transcript caught mid-write ends in one. */
  unparseable: number;
  /** Facts every record carries, taken from the newest one that had them. */
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  /** Newest timestamp seen on the live path. */
  lastActivityAt?: number;
  /** True when the parent walk ran out of records before reaching a root — a
   *  truncated or hand-edited file. The rows are still good; there are just
   *  fewer of them than the file suggests. */
  chainBrokeEarly: boolean;
};

export type ReadOptions = {
  /** Most rows to emit. The floor under a transcript with no compaction in
   *  reach; #599's memory work is why this is not unbounded. */
  maxRows?: number;
  /** Bytes of a tool's output kept on the row. The full text is not carried:
   *  transcripts store whole file reads and whole command outputs, and that is
   *  three quarters of the bytes in a big one. */
  maxOutputChars?: number;
};

const DEFAULT_MAX_ROWS = 200;
const DEFAULT_MAX_OUTPUT_CHARS = 2_000;
/**
 * How far back from EOF `readClaudeTranscriptFile` reads. Generous against the
 * row budget above — the transcripts here average 5.7 KB per line, so 16 MB
 * covers a few hundred rows even where every one of them carries a tool
 * output — and still two orders of magnitude under the largest file on disk.
 */
const DEFAULT_MAX_TAIL_BYTES = 16 * 1024 * 1024;
const NEWLINE = 0x0a;

/**
 * The record types the conversation itself is made of — the three that are 96%
 * of a transcript's bytes, plus `system` for the compaction boundary. Used to
 * choose where the backward walk STARTS; once on the chain, a record is on the
 * live path by its uuid and the mapper below decides what it becomes.
 */
const CONVERSATION_TYPES = new Set(["user", "assistant", "system"]);

/** A transcript record. Everything is optional because this is a FOREIGN file
 *  written by a CLI that versions independently of Telar. */
type Record_ = {
  type?: string;
  subtype?: string;
  uuid?: string;
  parentUuid?: string | null;
  /**
   * How a `compact_boundary` points past itself: its `parentUuid` is null, so
   * this is the only way back to the conversation it compacted. The walk below
   * CUTS at a boundary rather than crossing one, so this is the fallback for
   * any other record that severs `parentUuid` the same way — and the reason a
   * reader that only knew `parentUuid` would read a compaction as the start of
   * the conversation.
   */
  logicalParentUuid?: string | null;
  isSidechain?: boolean;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  isApiErrorMessage?: boolean;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  message?: { role?: string; content?: unknown };
  compactMetadata?: { trigger?: string; preTokens?: number; postTokens?: number; cumulativeDroppedTokens?: number };
  toolUseResult?: unknown;
  [key: string]: unknown;
};

type Block = { type?: string; text?: string; thinking?: string; name?: string; input?: unknown; id?: string; tool_use_id?: string; content?: unknown; is_error?: boolean };

function asBlocks(content: unknown): Block[] {
  return Array.isArray(content) ? (content.filter((b) => b && typeof b === "object") as Block[]) : [];
}

function millis(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const at = Date.parse(iso);
  return Number.isFinite(at) ? at : undefined;
}

/**
 * Tool output as text, from whichever of the three shapes the record used —
 * a bare string, a block list, or the CLI's decoded `toolUseResult`. Truncated
 * hard: the row is a preview and the transcript keeps the original.
 */
function outputText(block: Block, limit: number): string | undefined {
  const raw = typeof block.content === "string" ? block.content : asBlocks(block.content).map((b) => b.text ?? "").join("");
  if (!raw) return undefined;
  return raw.length > limit ? `${raw.slice(0, limit)}\n… ${raw.length - limit} more characters in the transcript` : raw;
}

/**
 * A slash command, as the person typed it. The CLI stores one as a `user`
 * record whose text is an XML-ish `<command-name>` envelope, so rendering the
 * content raw shows markup the person never saw. Returns undefined for
 * anything that is not one, which is the common case.
 */
function slashCommand(text: string): string | undefined {
  const name = /<command-name>([^<]*)<\/command-name>/.exec(text)?.[1]?.trim();
  if (!name) return undefined;
  const args = /<command-args>([^<]*)<\/command-args>/.exec(text)?.[1]?.trim();
  return args ? `${name} ${args}` : name;
}

/** The text of a user record, from the two shapes it comes in. */
function userText(content: unknown): string {
  if (typeof content === "string") return content;
  return asBlocks(content)
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("")
    .trim();
}

function oneLine(text: string, limit = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/**
 * Read a transcript's live path into journal rows, newest-bounded.
 *
 * PURE, and takes lines rather than a path, because the awkward shapes this has
 * to survive — a `user` record carrying only `tool_result`, a compaction
 * boundary, a sidechain, an `isMeta` wrapper, a slash command — are all
 * expressible as fixtures, and a reader that needs a real 200 MB file to be
 * tested is a reader nobody re-tests.
 *
 * `lines` is indexed from the END, so a caller with a huge file may pass a tail
 * slice; a chain that runs off the start of the slice reports
 * `chainBrokeEarly` rather than pretending the conversation began there.
 */
export function readClaudeTranscript(lines: readonly string[], options: ReadOptions = {}): TranscriptImport {
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
  const maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;

  const dropped: Record<string, number> = {};
  const drop = (what: string) => {
    dropped[what] = (dropped[what] ?? 0) + 1;
  };

  let unparseable = 0;
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let gitBranch: string | undefined;
  let lastActivityAt: number | undefined;

  /**
   * THE BACKWARD WALK. `want` is the uuid of the next record on the live path;
   * everything else the scan passes is an abandoned branch, a sidechain, or
   * bookkeeping, and is counted rather than read.
   */
  let want: string | undefined;
  const chain: Record_[] = [];
  let cut: TranscriptCut = { kind: "whole" };
  let chainBrokeEarly = false;
  let keptEstimate = 0;
  /** Whether the lines held any conversation record at all, which is what
   *  separates "this transcript is empty" from "this slice missed it". */
  let sawLinkedRecord = false;

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]?.trim();
    if (!line) continue;

    let record: Record_;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        unparseable += 1;
        continue;
      }
      record = parsed as Record_;
    } catch {
      // A transcript caught mid-append ends in half a line. Counted, not fatal
      // — the record it belongs to will be complete on the next read.
      unparseable += 1;
      continue;
    }

    const uuid = record.uuid;
    if (!uuid) {
      // `queue-operation`, `last-prompt`, `atis-latch` and friends carry no
      // uuid and sit outside the conversation entirely.
      drop(record.type ?? "<untyped>");
      continue;
    }
    sawLinkedRecord = true;

    if (want === undefined) {
      // THE TAIL IS THE LAST MAIN-LINE RECORD. A sidechain record is a
      // sub-agent's own conversation and is not where the person left off.
      if (record.isSidechain) {
        drop("sidechain");
        continue;
      }
      /**
       * AND IT IS A CONVERSATION RECORD, NOT MERELY ONE WITH A UUID.
       *
       * Bookkeeping that carries no uuid is already skipped above, but some of
       * it does carry one — and the CLI writes exactly such a record LAST. A
       * fork stamps `custom-title` after the copied messages; `/rename` writes
       * the same record; `ai-title` arrives the same way. Each has a uuid and
       * no parent, so starting the walk there ended it immediately: the whole
       * conversation read as ZERO rows, with nothing to say it had gone wrong.
       * Found by adopting a real fork, which is the first caller that reads a
       * transcript the CLI has just written a title into.
       */
      if (!CONVERSATION_TYPES.has(record.type ?? "")) {
        drop(record.type ?? "<untyped>");
        continue;
      }
      want = uuid;
    } else if (uuid !== want) {
      drop(record.isSidechain ? "sidechain" : "offPath");
      continue;
    }

    // On the live path from here down.
    chain.push(record);
    sessionId ??= record.sessionId;
    cwd ??= record.cwd;
    gitBranch ??= record.gitBranch;
    const at = millis(record.timestamp);
    if (at !== undefined && (lastActivityAt === undefined || at > lastActivityAt)) lastActivityAt = at;

    if (record.type === "assistant") keptEstimate += asBlocks(record.message?.content).length;
    else if (record.type === "user" && !record.isMeta) keptEstimate += 1;

    /**
     * THE CUT. A compaction boundary is where the CLI's own memory of the
     * earlier conversation ends, so stopping here keeps exactly what the
     * resumed model still has — and the summary record sitting just after it
     * covers the rest in the provider's own words.
     */
    if (record.subtype === "compact_boundary") {
      cut = {
        kind: "compact_boundary",
        at: at ?? 0,
        ...(typeof record.compactMetadata?.cumulativeDroppedTokens === "number"
          ? { droppedTokens: record.compactMetadata.cumulativeDroppedTokens }
          : {}),
      };
      break;
    }

    if (keptEstimate >= maxRows) {
      cut = { kind: "row_budget", budget: maxRows };
      break;
    }

    const parent = record.parentUuid ?? record.logicalParentUuid ?? undefined;
    if (!parent) {
      cut = { kind: "whole" };
      want = undefined;
      break;
    }
    want = parent;
  }

  /**
   * A walk cut by the LINES rather than by us. Two shapes, and both have to
   * say so: the chain still wanted a parent when the lines ran out, or the
   * slice held conversation records but never a main-line one to start from —
   * a tail short enough to contain only a sub-agent's trailing exchange. The
   * second returns no rows, and an empty result that does not admit it was
   * clipped is indistinguishable from an empty conversation.
   */
  if (cut.kind === "whole" && sawLinkedRecord && (want !== undefined || chain.length === 0)) chainBrokeEarly = true;

  chain.reverse();

  /**
   * TOOL RESULTS ARE NOT ROWS. A `user` record whose content is `tool_result`
   * blocks is the OUTPUT half of an earlier `tool_use` — 256 of the 295 user
   * records across the real terminal transcripts measured. Rendering them as
   * rows would double every tool call and put the model's own words in the
   * person's mouth, so they are indexed here and folded in below.
   */
  const results = new Map<string, { block: Block; at?: number }>();
  for (const record of chain) {
    if (record.type !== "user") continue;
    for (const block of asBlocks(record.message?.content)) {
      if (block.type === "tool_result" && block.tool_use_id) {
        results.set(block.tool_use_id, { block, at: millis(record.timestamp) });
      }
    }
  }

  const rows: ImportedRow[] = [];
  let priorSummary: string | undefined;

  const push = (record: Record_, detail: ItemDetail, extra: { title?: string; status?: ItemStatus; completedAt?: number } = {}) => {
    const startedAt = millis(record.timestamp) ?? 0;
    rows.push({
      detail,
      ...(extra.title ? { title: extra.title } : {}),
      status: extra.status ?? "completed",
      startedAt,
      ...(extra.completedAt !== undefined ? { completedAt: extra.completedAt } : {}),
      imported: true,
      providerRefs: {
        ...(record.uuid ? { itemId: record.uuid } : {}),
        ...(record.sessionId ? { sessionId: record.sessionId } : {}),
      },
    });
  };

  for (const record of chain) {
    if (record.subtype === "compact_boundary") {
      push(record, {
        type: "context_compaction",
        ...(record.compactMetadata?.trigger ? { reason: record.compactMetadata.trigger } : {}),
        ...(typeof record.compactMetadata?.preTokens === "number" ? { preTokens: record.compactMetadata.preTokens } : {}),
        ...(typeof record.compactMetadata?.postTokens === "number" ? { postTokens: record.compactMetadata.postTokens } : {}),
      }, { title: "Context compacted" });
      continue;
    }

    if (record.type === "user") {
      /**
       * CLAUDE'S OWN SUMMARY OF THE EARLIER CONVERSATION. It arrives as a user
       * record — it is what the CLI hands the model after a compaction — but
       * nobody typed it, so it must not render as the person's message.
       */
      if (record.isCompactSummary) {
        const text = userText(record.message?.content);
        if (text) {
          priorSummary = text;
          push(record, { type: "unknown", label: "Summary of the earlier conversation", payload: { text } }, {
            title: "Summary of the earlier conversation",
          });
        }
        continue;
      }

      if (record.isMeta) {
        // Environment blurbs, caveats and hook noise the CLI injects. Never
        // typed, never interesting to re-read.
        drop("meta");
        continue;
      }

      const blocks = asBlocks(record.message?.content);
      if (blocks.length > 0 && blocks.every((b) => b.type === "tool_result")) {
        // Folded into its tool_use below.
        continue;
      }

      const text = userText(record.message?.content);
      if (!text) {
        drop("emptyUser");
        continue;
      }
      const command = slashCommand(text);
      if (command) {
        push(record, { type: "user_message", text: command }, { title: command });
        continue;
      }
      push(record, { type: "user_message", text }, { title: oneLine(text) });
      continue;
    }

    if (record.type === "assistant") {
      for (const block of asBlocks(record.message?.content)) {
        if (block.type === "thinking") {
          const text = block.thinking ?? "";
          if (text.trim()) push(record, { type: "reasoning", text });
          continue;
        }
        if (block.type === "text") {
          const text = block.text ?? "";
          if (text.trim()) push(record, { type: "assistant_message", text }, { title: oneLine(text) });
          continue;
        }
        if (block.type === "tool_use" && block.name) {
          /**
           * THE CLASSIFIER IS ALREADY WRITTEN. `itemDetailForToolCall` is what
           * the live driver uses on the very same `tool_use` blocks, so a Bash
           * call imported from a transcript lands on the same row type as one
           * watched live — which is the whole point of the canonical item set.
           * A second classifier here would drift from it by the first release.
           */
          const detail = itemDetailForToolCall(block.name, block.input);
          const found = block.id ? results.get(block.id) : undefined;
          const output = found ? outputText(found.block, maxOutputChars) : undefined;
          const withOutput = attachOutput(detail, block, output);
          push(record, withOutput, {
            title: titleForToolCall(block.name, detail),
            status: found?.block.is_error ? "failed" : "completed",
            ...(found?.at !== undefined ? { completedAt: found.at } : {}),
          });
          continue;
        }
        drop(`assistant:${block.type ?? "<untyped>"}`);
      }
      continue;
    }

    drop(record.type ?? "<untyped>");
  }

  return {
    rows,
    cut,
    ...(priorSummary ? { priorSummary } : {}),
    dropped,
    unparseable,
    ...(sessionId ? { sessionId } : {}),
    ...(cwd ? { cwd } : {}),
    ...(gitBranch ? { gitBranch } : {}),
    ...(lastActivityAt !== undefined ? { lastActivityAt } : {}),
    chainBrokeEarly,
  };
}

/**
 * Put a tool's output where its row type keeps output. A command's goes in
 * `outputPreview` — the field whose name already says it is truncated — and
 * everything else on `call.output`. A file read or change has nowhere to put
 * one and does not want one.
 */
function attachOutput(detail: ItemDetail, block: Block, output: string | undefined): ItemDetail {
  if (output === undefined) return detail;
  switch (detail.type) {
    case "command_execution":
      return { ...detail, command: { ...detail.command, outputPreview: output } };
    case "mcp_tool_call":
    case "dynamic_tool_call":
    case "browser_action":
      return { ...detail, call: { ...detail.call, output, ...(block.id ? { toolUseId: block.id } : {}) } };
    default:
      return detail;
  }
}

/**
 * The same read, from a path, WITHOUT materialising the file.
 *
 * THIS FUNCTION IS THE POINT OF THE BACKWARD WALK. `readClaudeTranscript` only
 * ever parses the tail — measured on the 212 MB transcript on this machine: 72
 * rows out, 295 ms — but a caller reaching that function through
 * `readFileSync(...).split("\n")` has already paid for the whole file, and
 * measured that costs 862 MB of heap. #599 took the Agent's memory from 1.53 GB
 * to 9.1 MB; handing #616 a door that walks it back would be a poor trade.
 *
 * So the file is read from the END: `maxTailBytes` back from EOF, advanced to
 * the first newline so the first line is whole. A chain that runs off the front
 * of that slice comes back with `chainBrokeEarly`, which a caller may answer by
 * retrying with a bigger tail rather than by guessing.
 */
export function readClaudeTranscriptFile(
  filePath: string,
  options: ReadOptions & { maxTailBytes?: number } = {},
): TranscriptImport {
  const maxTailBytes = options.maxTailBytes ?? DEFAULT_MAX_TAIL_BYTES;
  const handle = fs.openSync(filePath, "r");
  try {
    const size = fs.fstatSync(handle).size;
    const from = Math.max(0, size - maxTailBytes);
    const buffer = Buffer.allocUnsafe(size - from);
    fs.readSync(handle, buffer, 0, buffer.length, from);
    // A slice that started mid-line drops that fragment: the record it belongs
    // to is incomplete here, and the walk reports the shortfall rather than
    // parsing half a record.
    const start = from === 0 ? 0 : buffer.indexOf(NEWLINE) + 1;
    const text = buffer.toString("utf8", start <= 0 ? 0 : start);
    return readClaudeTranscript(text.split("\n"), options);
  } finally {
    fs.closeSync(handle);
  }
}

/**
 * What the cockpit should say it kept. One sentence, because the alternative —
 * a session that silently shows a fraction of a conversation — is the failure
 * #616 calls out by name.
 */
export function describeImport(result: TranscriptImport): string {
  const rows = result.rows.length;
  const plural = rows === 1 ? "row" : "rows";
  switch (result.cut.kind) {
    case "compact_boundary":
      return `Imported the ${rows} ${plural} since this conversation last compacted its context${
        result.priorSummary ? ", with Claude's own summary of what came before" : ""
      }.`;
    case "row_budget":
      return `Imported the most recent ${rows} ${plural} of this conversation. Earlier turns stayed in Claude Code.`;
    case "whole":
      return result.chainBrokeEarly
        ? `Imported ${rows} ${plural}. The transcript did not reach the start of the conversation.`
        : `Imported this conversation in full — ${rows} ${plural}.`;
  }
}
