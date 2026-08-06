// File-backed persistence under TELAR_HOME (default ~/.telar) — chats.json
// (chat history) and usage.ndjson (append-only usage ledger). Files remember;
// no database.
import fs from "fs";
import os from "os";
import path from "path";
import { ledgerReadDegraded, sessionCostFolds, usageTokensBySession } from "@telar/core";
import type { ClientPermissionMode } from "./permission-modes";
import type { CompactionFacts, CompactionRecord } from "./compaction";
import { previewPlainText } from "./preview-text";
import type { ContextUsageSnapshot } from "./context-usage";
import type { RuntimeMode } from "@telar/core/runtime-mode";

// The spend ledger itself lives in @telar/core (usage-ledger.ts) — it is
// shared runtime state that belongs to no module, so its owning core service
// is its sole writer (AD-20) and the only code that opens usage.ndjson. These
// re-exports keep every existing caller of this module unchanged; there is one
// implementation and one file on disk.
export { logUsage, usageSummary } from "@telar/core";
export type { UsageEntry, UsageWindow } from "@telar/core";

// The settled TELAR_HOME expression, copied verbatim from permissions.ts's
// telarHome() and session-log.ts's home() (and matching core's manifest.ts
// telarDir() and looms.ts's private telarDir()). Not a variant.
//
// Cited by SYMBOL, deliberately. This comment previously named line numbers in
// those files; they were wrong within one editing round, because a line number
// identifies a slot in a file and any edit above it hands that slot to
// something else. A symbol survives edits and grep finds it — same policy as
// _bmad-output/implementation-artifacts/deferred-work.md.
//
// WHY lazy, and WHY exported:
//  - Lazy: a test (or a reconfigured process) can point TELAR_HOME elsewhere,
//    exactly as manifest.ts, looms.ts, session-log.ts and permissions.ts do. A
//    top-level const freezes the root at first import, so a dev server, the
//    packaged app and the --smoke gate could not hold distinct state roots —
//    and no second test file could ever re-pin it.
//  - Exported: os.homedir() under Bun is resolved at process start and ignores
//    a later process.env.HOME write, so the unset-TELAR_HOME fallback can only
//    be asserted as a STRING, never by writing into a fake home in-process.
//    manifest.ts exports telarDir() for the same reason.
//
// WHY trim-and-check rather than `??`: `??` falls back on null/undefined but
// NOT on "", and an exported-but-empty `TELAR_HOME=` is routine in shell
// scripts and CI. The harm is not uniform across the five modules that share
// this expression, and this one is the lucky case — measured, not assumed:
// with root "" this file's writes CRASH (writeChats' ensureDir() does
// fs.mkdirSync("", { recursive: true }), which throws ENOENT) rather than
// landing in the cwd. The siblings are not so lucky: permissions.ts silently
// writes <cwd>/permissions.json — the rules that gate the Human-Accept Moat —
// session-log.ts creates <cwd>/sessions/<id>/live.ndjson, and core's looms.ts
// creates <cwd>/looms/<id>. READS are silently cwd-scoped
// everywhere, here included: readChats() swallows its failure and returns [],
// so an empty root reads an empty history rather than reporting anything. The
// root expression is the one thing all five have in common, so it is the one
// thing to guard — like-for-like in each, since collapsing the duplication is
// separately tracked and would widen this change.
//
// DESIGN CALL on a RELATIVE root: path.resolve makes it absolute but still
// lands it under the cwd, and it pins NOTHING — this resolver is lazy, so
// path.resolve re-runs against the CURRENT cwd on every call and a process that
// chdir's mid-run reads and writes a different root afterwards (measured: with
// TELAR_HOME="rel-root", two calls straddling a process.chdir() returned two
// different absolute paths). Refusing a relative root outright is the stronger
// guarantee, but it is a behavior change beyond this fix, so we resolve and
// document.
export const stateRoot = () => {
  const v = process.env.TELAR_HOME?.trim();
  return v ? path.resolve(v) : path.join(os.homedir(), ".telar");
};
const chatsFile = () => path.join(stateRoot(), "chats.json");

export type Part =
  | { type: "text"; text: string; parentId?: string }
  | {
      type: "tool";
      name: string;
      id?: string;
      input?: Record<string, unknown>;
      output?: string;
      isError?: boolean;
      // Set at persist time when the turn ended (abort/mid-turn error) before
      // this call's tool_result ever arrived — distinguishes "cancelled
      // mid-flight" from a genuinely empty successful result.
      interrupted?: boolean;
      // Present on subagent text/tool parts forwarded via
      // forwardSubagentText — the tool_use id of the (possibly flattened,
      // see lib/transcript.ts's ParentFlattener) spawn step that produced
      // this part. Absent for parts belonging to the main conversation.
      // All-optional by design: old persisted chats have no parentId and
      // must keep loading as plain (parentless) parts.
      parentId?: string;
      // Present only on the spawn step itself — the tool_use that invoked
      // the agent-spawn tool ("Agent"/"Task" depending on SDK version, see
      // detectAgentSpawnTool) — pulled from its raw AgentInput. This is what
      // lets the client turn one tool part into a tab, with zero separate
      // tab bookkeeping.
      agent?: { type: string | null; description: string; name?: string };
      // Present only on the spawn step itself, once the SDK's own
      // task_notification system message arrives for it. Backgrounded
      // subagents (the default) get their own tool_result almost instantly
      // ("Async agent launched…") — this is the actual completion signal,
      // decoupled from that ack, and takes priority over output/isError for
      // status purposes (see agentStatus in session-view.tsx). Absent means
      // "go by output/interrupted instead" (a synchronous subagent, or an
      // SDK build that never emits this message).
      taskStatus?: "completed" | "failed" | "stopped";
      // Set when this call was auto-denied by permissionMode "auto"/
      // "acceptEdits" — a hard block (guardrail PreToolUse hook or the SDK's
      // own classifier) rather than a user's interactive "Deny" click, which
      // never touches this field (the permission card's own status covers
      // that case instead).
      autoDenied?: boolean;
    }
  // What the user attached to a message, as METADATA ONLY — id, name, media
  // type, size. The bytes live under <stateRoot>/attachments (see
  // lib/attachments.ts) with a lifetime of their own: archiving the chat
  // destroys them while this part survives here, which is exactly what lets an
  // old message still render a named chip once the file behind it is gone.
  //
  // NOTHING BASE64 EVER GOES IN HERE. chats.json is one document holding every
  // transcript in the app; inlining bytes would grow it without bound and make
  // every unrelated read pay for them.
  | {
      type: "attachments";
      files: { id: string; name: string; mediaType: string; size: number }[];
    };

export type ChatMessage = {
  role: "user" | "assistant";
  parts: Part[];
};

export type Chat = {
  id: string; // = SDK session id (stable across resumes)
  title: string;
  customTitle?: boolean; // true once the user has explicitly renamed the chat (PATCH .../route.ts)
  model: string;
  effort?: string; // reasoning effort level for this chat's turns (optional: model default when absent)
  account: string;
  project?: string; // registry name of the anchoring project (optional: old entries predate it)
  // Client-choosable SDK permission mode for this session's turns — see
  // lib/permissions.ts's ClientPermissionMode. Optional: absent on entries
  // predating mode selection, which read as "default" (the prior hardcoded
  // behavior).
  permissionMode?: ClientPermissionMode;
  runtimeMode?: RuntimeMode;
  fastMode?: boolean;
  serviceTier?: string;
  // Session<->Loom link (docs/loom-model.md §5): the loom this session is
  // planning/steering/discussing, and which of the three roles it holds.
  // Optional: most chats are plain sessions with no loom attached. Once set,
  // persisted via appendTurn's undefined-guarded assignment below (see
  // contextTokens for the same pattern) — an unrelated turn that omits these
  // must never clobber a link a prior turn/route established. "escalation"
  // (M11.3's blocked-loom "Discuss with the orchestrator" chat) is persisted
  // like "steerer" so the surface can reattach across navigation/reload —
  // both are loom-born and filtered out of the regular project session list
  // (GET /api/chats), reachable only from the loom's own UI instead.
  loomId?: string;
  role?: "planner" | "steerer" | "escalation";
  createdAt: number;
  updatedAt: number;
  costUsd: number;
  turns: number;
  archived?: boolean; // optional: absent on entries predating archiving
  // ── inbox state (docs/phase-2-sidebar-design.md; t3code Sidebar V2) ────────
  // Settling is a RESTING state, deliberately not archiving: a settled session
  // drops out of the active band but stays a first-class session everywhere
  // else. Two things can shelve a row — this explicit timestamp, and the
  // derived "quiet for SETTLED_AFTER_MS" rule in lib/session-list.ts. Only the
  // explicit one is persisted, so the quiet rule stays a pure view over
  // updatedAt and never needs a migration pass to re-derive.
  settledAt?: number;
  // A deferral with a scheduled return. While Date.now() < snoozedUntil the row
  // sits in the Snoozed shelf; past it, it re-enters the active band on its own
  // with no writer involved. Cleared, not just passed, by fresh activity.
  snoozedUntil?: number;
  // Read watermark for the unread dot: unread ⟺ readAt is absent or older than
  // updatedAt. Storing a timestamp rather than a boolean means a later turn
  // re-marks the row unread for free, and "mark unread" is a write of 0 rather
  // than a separate flag that can disagree with updatedAt.
  readAt?: number;
  // Per-turn token totals, accumulated on appendTurn. All optional so chats
  // persisted before this field existed keep loading — see getChat's
  // read-time derivation fallback (tokensFromUsageLog) for those.
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreateTokens?: number;
  // Context-window occupancy after the LATEST turn (input + cache-read +
  // cache-create of that turn) — SET each turn, not accumulated, because every
  // turn re-sends the whole conversation as its prompt, so the last turn's
  // input side IS the current context size. This is the "CTX" the header shows.
  contextTokens?: number;
  // Exact latest-window attribution when the active harness exposes one.
  // Optional and provider-neutral: old chats and harnesses without a breakdown
  // continue to use contextTokens plus the UI's conservative estimate.
  contextUsage?: ContextUsageSnapshot;
  // Where this session's history was replaced by a summary (issue #25). A fact
  // ABOUT the transcript, deliberately NOT an entry in it: a compaction has no
  // role, no author and no parts, so folding it into `messages` would make it a
  // turn — the exact landmine session-view.tsx guards against on the live side.
  // Anchored by message COUNT (see CompactionRecord), so the pair renders as
  // one interleaved list on reload. Optional: absent on every chat written
  // before compactions were recorded, which reads as "none known", not "none
  // happened".
  compactions?: CompactionRecord[];
  messages: ChatMessage[];
};

// A chat without its transcript, plus a one-line preview of the latest
// assistant reply — the shape every list surface (project detail, sidebar,
// dashboard) consumes.
export type ChatSummary = Omit<Chat, "messages"> & { preview: string };

function ensureDir() {
  fs.mkdirSync(stateRoot(), { recursive: true });
}

function readChats(): Chat[] {
  try {
    return JSON.parse(fs.readFileSync(chatsFile(), "utf8")).chats as Chat[];
  } catch {
    return [];
  }
}

function writeChats(chats: Chat[]) {
  ensureDir();
  const file = chatsFile();
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ chats }, null, 2));
  fs.renameSync(tmp, file);
}

// Last assistant text, flattened to plain words, normalized to a single line
// and capped — the ~100-char glimpse the list surfaces show under each session
// title. Scans from the end so the freshest reply wins; "" when a session has
// no assistant text yet. The markdown strip runs BEFORE the whitespace
// collapse (its line-anchored rules need the line starts) and before the cap
// (so all 100 characters are visible ones) — see lib/preview-text.ts.
function previewOf(messages: ChatMessage[] = []): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    const parts = m.parts ?? [];
    for (let j = parts.length - 1; j >= 0; j--) {
      const p = parts[j];
      if (p.type === "text") {
        const text = previewPlainText(p.text).replace(/\s+/g, " ").trim();
        if (text) return text.slice(0, 100);
      }
    }
  }
  return "";
}

// `archived` controls which slice is returned; default "exclude" keeps every
// existing caller hiding archived chats with no code change.
export function listChats(
  project?: string,
  opts?: { archived?: "exclude" | "include" | "only" },
): ChatSummary[] {
  const mode = opts?.archived ?? "exclude";
  return readChats()
    .filter((c) => (project ? c.project === project : true))
    .filter((c) => {
      if (mode === "include") return true;
      return mode === "only" ? !!c.archived : !c.archived;
    })
    // costUsd is projected over the ledger (AD-18), exactly as getChat does —
    // the two read surfaces must not be able to disagree, including about what
    // an unreadable ledger means (see displayedSpendUsd).
    .map(({ messages, ...meta }) => ({
      ...meta,
      costUsd: displayedSpendUsd(meta.id, meta.costUsd),
      preview: previewOf(messages),
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

// A session's spend, projected over the one ledger — the session's OWN turns
// plus the Ultra runs those turns launched (story 4.1 / AC5, FR-UW-5).
//
// Exported because the LIVE per-turn readout has to be the same projection as
// the persisted one (AD-18 — "three counters that can disagree" is the failure
// it exists to prevent). The chat route reads this after appending the turn's
// ledger line and broadcasts it on "done"; the session view sets that value
// rather than accumulating a delta of its own.
//
// THE ONE WIDENING STORY 4.1 MAKES TO A READOUT, and it is here on purpose.
// This function is the single source for BOTH the live `done` payload and the
// persisted display (getChat/listChats via displayedSpendUsd), so widening it
// moves both surfaces together and neither can drift. What is NOT widened:
// `usageCostBySession()` itself, and therefore `usageSummary()`'s
// sidebar/dashboard account windows — that is an unresolved [Review][Decision]
// on story 1.1 and is the human's call, not this story's.
//
// NO DOUBLE COUNT, and it is a property of the two folds rather than a hope. A
// ledger row has exactly one `ownerKind`, so a row counted by
// `usageCostBySession()` (which folds only `ownerKind === "session"`) is
// structurally invisible to `ultraCostBySession()` (which folds only
// `ownerKind === "ultra"`). They are also disjoint in substance: the chat route
// logs its own SDK turn's `lastResult.totalCostUsd`, while an ultra run's
// children go through a SEPARATE detached `query()` that outlives the launching
// turn. A loom row on the same session is in neither map and is that loom's
// spend, not this chat's.
//
// A DEGRADED READ NOW HAS TWO SUMMANDS, and they degrade TOGETHER — but ONLY
// because this goes through `sessionCostFolds()`, which takes BOTH maps out of
// ONE `readFold()`. That is not a micro-optimization, it is the correctness
// condition, and the obvious spelling gets it wrong:
// `usageCostBySession().get(id) + ultraCostBySession().get(id)` is TWO reads,
// and the port's `readUnavailable`/`readStale` flags are cleared on entry to
// each — so a transient failure on the session leg that clears before the ultra
// leg is ERASED, `ledgerReadDegraded()` answers false, and the fallback below
// never fires. See `sessionCostFolds`' own comment in
// packages/core/src/usage-ledger.ts for the full scenario; it is asserted there
// too, in both directions.
export function sessionSpendUsd(sessionId: string): number {
  const { session, ultra } = sessionCostFolds();
  return (session.get(sessionId) ?? 0) + (ultra.get(sessionId) ?? 0);
}

// The spend a CHAT DISPLAYS. The same projection as sessionSpendUsd, plus the
// one distinction a bare number cannot carry: `0` is the answer both to "this
// session has no rows in the ledger" (true — show it) and to "the number you
// just got did not come from reading the ledger" (meaningless). The port's
// ledgerReadDegraded() is the predicate for the second. On a degraded read the
// stored chat.costUsd is the last figure this chat's own turns wrote, so
// holding it beats printing $0.00 beside a real transcript and real token
// counts.
//
// WHY ledgerReadDegraded() AND NOT ledgerReadUnavailable(), which is what
// weave.ts's budget guard and ultra's manifest spend use: `Unavailable` is
// FILE-scoped — the read failed AND there was no fold to serve. It is FALSE in
// the case measured to be the more likely one here: a warm process whose read
// fails and which is therefore served its own last known good fold. That fold
// is real and it still binds a budget, which is why the narrower predicate is
// right for weave — but it predates every row appended since it was taken (by
// the packaged app, or by this process before the failure), and for a row it
// has never seen it answers 0. Reproduced: a chat whose turn really spent
// $12.34, read while a stale fold is being served, displayed $0.00 with
// `Unavailable` reporting false. A budget wants stale-and-high; a per-session
// readout wants "was this row's figure actually read".
//
// STORY 4.1 NARROWED WHAT THE FALLBACK CAN SUBSTITUTE FOR, and it is stated
// rather than left for a reader to discover. `stored` is `chat.costUsd`, which
// appendTurn only ever increments by the chat's OWN turn cost — it has never
// held ultra spend and still does not. Before 4.1 that made it a COMPLETE
// substitute for the (session-only) projection. Now that the projection also
// folds the session's ultra runs, `stored` is a KNOWN-INCOMPLETE substitute
// whenever the fallback actually fires for a session that launched runs: the
// displayed figure loses the ultra component for as long as the ledger is
// unreadable. That is still the right trade — a partial real number beats a
// confident $0.00 — and it is bounded, because the moment the ledger reads
// clean the full projection wins again.
//
// NOT A GENERAL FALLBACK, deliberately. A ledger that READS CLEAN and simply
// has no row for this session still displays 0 — that case (a rotated, pruned
// or deleted usage.ndjson) is an open product decision on story 1.1, and "the
// honest answer is $0" is a defensible position that is not this function's to
// settle. Falling back on every zero would make the stored counter authoritative
// again whenever the ledger disagrees, which is the exact failure AD-18 exists
// to end. What is never defensible is a number derived from a read that did not
// happen.
function displayedSpendUsd(sessionId: string, stored: unknown): number {
  const projected = sessionSpendUsd(sessionId);
  if (projected !== 0 || !ledgerReadDegraded()) return projected;
  return typeof stored === "number" && Number.isFinite(stored) ? stored : projected;
}

// Per-session token totals, projected over the core usage ledger — the
// read-time fallback for chats persisted before per-turn token accumulation
// existed on the Chat record itself (appendTurn's `usage` accumulation is the
// primary path; this only kicks in when a chat predates it, detected by
// getChat via inputTokens===undefined). The parse + memoization now live in
// the ledger's own port; this is a projection, not a second reader.
function tokensFromUsageLog(sessionId: string) {
  return (
    usageTokensBySession().get(sessionId) ?? {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
    }
  );
}

export function getChat(id: string): Chat | undefined {
  const chat = readChats().find((c) => c.id === id);
  if (!chat) return undefined;
  // AD-18 — a session's spend is a PROJECTION over usage.ndjson, not an
  // independent counter. Chat.id is the SDK session id, which is what the
  // ledger's session-owned lines are keyed by. The stored chat.costUsd is a
  // denormalized cache that nothing reads any more (see appendTurn) — except
  // when the ledger itself could not be read, which is the one case
  // displayedSpendUsd keeps it for.
  const projected = { ...chat, costUsd: displayedSpendUsd(chat.id, chat.costUsd) };
  // Old chats predate per-turn token accumulation (inputTokens is the
  // canary — all four fields were added together) — derive their totals
  // from the usage ledger instead of silently showing zero.
  if (chat.inputTokens === undefined) {
    return { ...projected, ...tokensFromUsageLog(chat.id) };
  }
  return projected;
}

export function deleteChat(id: string) {
  writeChats(readChats().filter((c) => c.id !== id));
}

// Toggle a chat's archived flag; returns false when the id is unknown.
export function setChatArchived(id: string, archived: boolean): boolean {
  const chats = readChats();
  const chat = chats.find((c) => c.id === id);
  if (!chat) return false;
  chat.archived = archived;
  writeChats(chats);
  return true;
}

// Settle (rest) or unsettle a chat. Settling also clears any snooze — the two
// are alternative ways of saying "not now", and holding both would leave a row
// that un-snoozes into a shelf it is already sitting in. Returns false when the
// id is unknown.
export function setChatSettled(id: string, settled: boolean): boolean {
  const chats = readChats();
  const chat = chats.find((c) => c.id === id);
  if (!chat) return false;
  if (settled) {
    chat.settledAt = Date.now();
    delete chat.snoozedUntil;
  } else {
    delete chat.settledAt;
  }
  writeChats(chats);
  return true;
}

// Snooze a chat until `until` (epoch ms), or clear the snooze with null. A
// snooze also unsettles: choosing a wake-up time is a statement that the work
// is not finished, so the row must be able to come back to the active band.
// Returns false when the id is unknown or `until` is already in the past —
// a snooze that expires on write is a no-op the caller should hear about.
export function setChatSnoozed(id: string, until: number | null): boolean {
  const chats = readChats();
  const chat = chats.find((c) => c.id === id);
  if (!chat) return false;
  if (until === null) {
    delete chat.snoozedUntil;
  } else {
    if (!Number.isFinite(until) || until <= Date.now()) return false;
    chat.snoozedUntil = until;
    delete chat.settledAt;
  }
  writeChats(chats);
  return true;
}

// Mark a chat read (readAt = now) or unread (readAt = 0, which is always older
// than updatedAt and so reads as unread without a second flag). Returns false
// when the id is unknown.
export function setChatRead(id: string, read: boolean): boolean {
  const chats = readChats();
  const chat = chats.find((c) => c.id === id);
  if (!chat) return false;
  chat.readAt = read ? Date.now() : 0;
  writeChats(chats);
  return true;
}

// Rename a chat. `custom: true` (the PATCH /api/chats/[id] path) flags it so
// appendTurn's fallback title-on-create logic never matters again for this
// chat — a user rename always wins. Returns false when the id is unknown.
export function setChatTitle(id: string, title: string, opts?: { custom?: boolean }): boolean {
  const chats = readChats();
  const chat = chats.find((c) => c.id === id);
  if (!chat) return false;
  chat.title = title;
  if (opts?.custom) chat.customTitle = true;
  writeChats(chats);
  return true;
}

// Register-at-create (docs/runtime-architecture.md §A, contract §1): the POST
// /api/chat run calls this at system:init — the instant the SDK confirms the
// session id, BEFORE the first turn finishes — so the chat row EXISTS while the
// turn is still running. That lets the client flip chatPersisted on the "saved"
// event at the START of the turn (unlocking rename / minimize-to-dock) instead
// of only after appendTurn lands.
//
// Idempotent by id: a row that already exists (a resumed session, or a stray
// double-init) is left completely untouched and NOTHING is written — appendTurn
// below finds this same id and updates the row in place, so no duplicate row is
// ever created. Atomic via writeChats' tmp-write + rename, the same convention
// every other writer here uses, so a concurrent reader never sees a torn file.
//
// The row starts at turns:0 with an empty transcript — a "running, no turns
// yet" state every list/dashboard/recents surface renders gracefully
// (previewOf returns "" for empty messages; listChats maps it like any other).
// The title is the best available at init (a message-prefix fallback, or an
// early-generated one); appendTurn upgrades it at end-of-turn if a better
// generated title exists and the user hasn't renamed it.
export function upsertChatStub(opts: {
  id: string;
  model: string;
  effort?: string;
  account: string;
  project?: string;
  permissionMode?: ClientPermissionMode;
  runtimeMode?: RuntimeMode;
  fastMode?: boolean;
  serviceTier?: string;
  loomId?: string;
  role?: "planner" | "steerer" | "escalation";
  title?: string;
  userText: string;
}): void {
  const chats = readChats();
  if (chats.some((c) => c.id === opts.id)) return; // idempotent — never duplicate
  const now = Date.now();
  const fallbackTitle = (opts.userText.trim() || "New thread").slice(0, 60);
  chats.push({
    id: opts.id,
    title: opts.title?.trim() || fallbackTitle,
    model: opts.model,
    effort: opts.effort,
    account: opts.account,
    project: opts.project,
    permissionMode: opts.permissionMode,
    runtimeMode: opts.runtimeMode,
    fastMode: opts.fastMode,
    serviceTier: opts.serviceTier,
    loomId: opts.loomId,
    role: opts.role,
    createdAt: now,
    updatedAt: now,
    costUsd: 0,
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
    messages: [],
  });
  writeChats(chats);
}

export function appendTurn(opts: {
  id: string;
  model: string;
  effort?: string;
  account: string;
  project?: string;
  permissionMode?: ClientPermissionMode;
  runtimeMode?: RuntimeMode;
  fastMode?: boolean;
  serviceTier?: string;
  // Session<->Loom link — set once a session is attached to a loom (see
  // Chat.loomId/role). Undefined means "no change"; only ever narrows a
  // link in, never clears one (see the guarded assignment below).
  loomId?: string;
  role?: "planner" | "steerer" | "escalation";
  userMessage: ChatMessage;
  assistantMessage: ChatMessage;
  // M11.3 fix — the escalation kickoff's userMessage carries the server-
  // authored instruction prompt (route.ts's ESCALATION_KICKOFF_PROMPT), not
  // anything the human typed. It's machinery, not conversation: when true,
  // userMessage is used ONLY for the fresh-chat fallback title below and is
  // never pushed into the persisted transcript, so it can never render as a
  // human "said this" bubble on reattach. Absent/false for every other turn
  // (unchanged behavior).
  hideUserMessage?: boolean;
  costUsd: number;
  // Only consulted when this call CREATES the chat (fresh session) — an
  // existing chat keeps whatever title it already has, custom or derived.
  title?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreateTokens: number;
  };
  // Context-window occupancy after this turn (final model call's prompt size),
  // computed by the caller — SET, not accumulated.
  contextTokens?: number;
  // Exact latest-window snapshot, also replaced per turn rather than folded.
  contextUsage?: ContextUsageSnapshot;
}) {
  const chats = readChats();
  let chat = chats.find((c) => c.id === opts.id);
  const now = Date.now();
  if (!chat) {
    const firstText = opts.userMessage.parts.find((p) => p.type === "text");
    const fallbackTitle =
      (firstText?.type === "text" ? firstText.text : "New thread").slice(0, 60);
    chat = {
      id: opts.id,
      title: opts.title?.trim() || fallbackTitle,
      model: opts.model,
      effort: opts.effort,
      account: opts.account,
      project: opts.project,
      permissionMode: opts.permissionMode,
      runtimeMode: opts.runtimeMode,
      fastMode: opts.fastMode,
      serviceTier: opts.serviceTier,
      createdAt: now,
      updatedAt: now,
      costUsd: 0,
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
      messages: [],
    };
    chats.push(chat);
  } else if (chat.turns === 0 && !chat.customTitle && opts.title?.trim()) {
    // Register-at-create left a stub with a provisional (message-prefix or
    // early-generated) title; a better generated title arriving at end-of-turn
    // upgrades it in place. Bounded to a still-empty stub (turns === 0) and to
    // non-renamed chats — a user rename (customTitle) always wins, and resumed
    // real sessions never reach here anyway (their turns pass no title:
    // titlePromise is null once a sessionId exists).
    chat.title = opts.title.trim();
  }
  if (opts.hideUserMessage) {
    chat.messages.push(opts.assistantMessage);
  } else {
    chat.messages.push(opts.userMessage, opts.assistantMessage);
  }
  // Denormalized cache only — every read surface (getChat, listChats) now
  // projects costUsd over usage.ndjson instead (AD-18). Kept because removing
  // it would change the Chat type, appendTurn's contract, the gallery fixtures
  // and the session view's seed prop; deleting it is a separate change.
  chat.costUsd += opts.costUsd;
  chat.turns += 1;
  // Fresh activity un-shelves the row. t3code's rule, and the one that makes
  // settling safe to do liberally: a settled or snoozed session you actually
  // talk to again is, by that act, live work — so it returns to the active band
  // rather than being answered inside a shelf nobody has expanded. Archiving is
  // deliberately NOT cleared here: it is an explicit "hide this", not a rest.
  delete chat.settledAt;
  delete chat.snoozedUntil;
  chat.model = opts.model;
  chat.effort = opts.effort;
  chat.permissionMode = opts.permissionMode;
  chat.runtimeMode = opts.runtimeMode;
  chat.fastMode = opts.fastMode;
  chat.serviceTier = opts.serviceTier;
  if (opts.usage) {
    // chat.inputTokens === undefined means this chat predates per-turn token
    // accumulation (getChat's tokensFromUsageLog fallback is the canary's
    // other consumer) — its whole pre-upgrade history lives ONLY in
    // usage.ndjson, never on the chat record itself. Seed the cumulative
    // fields from that ledger before folding in `opts.usage`, or the
    // fallback's derived total (already shown to the user via getChat) is
    // silently replaced by just this one turn's delta and every earlier
    // turn's tokens become permanently unrecoverable the moment this chat is
    // resumed. This must not ALSO add opts.usage on top of the seeded
    // total: route.ts's teardown always calls logUsage() for this exact
    // turn/session before calling appendTurn (both gated by the same
    // `capturedSession`/`lastResult` truthiness, in the same synchronous
    // block — see route.ts), so usage.ndjson already includes this turn's
    // entry by the time tokensFromUsageLog runs here.
    if (chat.inputTokens === undefined) {
      const historical = tokensFromUsageLog(chat.id);
      chat.inputTokens = historical.inputTokens;
      chat.outputTokens = historical.outputTokens;
      chat.cacheReadTokens = historical.cacheReadTokens;
      chat.cacheCreateTokens = historical.cacheCreateTokens;
    } else {
      chat.inputTokens += opts.usage.inputTokens;
      chat.outputTokens = (chat.outputTokens ?? 0) + opts.usage.outputTokens;
      chat.cacheReadTokens = (chat.cacheReadTokens ?? 0) + opts.usage.cacheReadTokens;
      chat.cacheCreateTokens = (chat.cacheCreateTokens ?? 0) + opts.usage.cacheCreateTokens;
    }
  }
  // Context is the latest turn's final-call prompt size (computed by the
  // caller from the last main-thread assistant message, not the step-summed
  // usage above) — overwrite, never accumulate.
  if (opts.contextTokens !== undefined) chat.contextTokens = opts.contextTokens;
  if (opts.contextUsage !== undefined) chat.contextUsage = opts.contextUsage;
  // Session<->Loom link: guarded the same way — once a caller sets it, a
  // later turn that doesn't pass loomId/role must not wipe it back out.
  if (opts.loomId !== undefined) chat.loomId = opts.loomId;
  if (opts.role !== undefined) chat.role = opts.role;
  chat.updatedAt = now;
  writeChats(chats);
}

/**
 * Records that this session's history was compacted (issue #25). Called once
 * per stream, after `appendTurn` has landed whatever turn was in flight, so the
 * anchor is the transcript AS THE READER SAW IT when the divider was drawn: a
 * compaction that happened mid-turn sits below that turn on reload, exactly
 * where the live marker sat.
 *
 * NOT A TURN, AND THEREFORE NOT ACTIVITY. This deliberately touches neither
 * `turns`, `costUsd` (the compaction's own tokens are already in usage.ndjson,
 * which every spend readout projects over — AD-18) nor `updatedAt`. Bumping
 * updatedAt would re-sort the sidebar and re-mark the row unread because the
 * harness reorganized its own memory, and would un-shelve a settled session
 * without a human doing anything — settling stays user-driven.
 *
 * Returns false for a session with no chat record yet (a compaction during the
 * very first turn of a session that has not persisted). The live marker still
 * showed; there is simply nothing on disk to hang it from, and inventing a chat
 * here would create one with no messages in it.
 *
 * `remeasured` is the caller's answer to "did a turn land after these, and did
 * it measure the context again?" — true for a mid-turn auto-compaction, false
 * for a compact-only request that appends no turn. It is stamped on the record
 * because the anchor cannot express it (both cases land on the same
 * `afterMessages`), and the wheel reads it on reload: see seedCompactedContext.
 */
export function recordCompactions(
  id: string,
  facts: readonly CompactionFacts[],
  remeasured = false,
): boolean {
  if (facts.length === 0) return false;
  const chats = readChats();
  const chat = chats.find((c) => c.id === id);
  if (!chat) return false;
  const afterMessages = chat.messages.length;
  chat.compactions = [
    ...(chat.compactions ?? []),
    // Every compaction in one batch happened before the same turn landed, so
    // they share its verdict. Only the newest is ever consulted.
    ...facts.map((f) => ({ ...f, afterMessages, ...(remeasured ? { remeasured } : {}) })),
  ];
  writeChats(chats);
  return true;
}
