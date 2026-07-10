// File-backed persistence in ~/.telar — chats.json (chat history) and
// usage.ndjson (append-only usage ledger). Files remember; no database.
import fs from "fs";
import os from "os";
import path from "path";
import type { ClientPermissionMode } from "./permissions";

const DIR = path.join(os.homedir(), ".telar");
const CHATS = path.join(DIR, "chats.json");
const USAGE = path.join(DIR, "usage.ndjson");
const PLAN = path.join(DIR, "plan-usage.json");

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
  // Session<->Loom link (docs/loom-model.md §5): the loom this session is
  // planning/steering, and which of the two roles it holds. Optional: most
  // chats are plain sessions with no loom attached. Once set, persisted via
  // appendTurn's undefined-guarded assignment below (see contextTokens for
  // the same pattern) — an unrelated turn that omits these must never clobber
  // a link a prior turn/route established.
  loomId?: string;
  role?: "planner" | "steerer";
  createdAt: number;
  updatedAt: number;
  costUsd: number;
  turns: number;
  archived?: boolean; // optional: absent on entries predating archiving
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
  messages: ChatMessage[];
};

// A chat without its transcript, plus a one-line preview of the latest
// assistant reply — the shape every list surface (project detail, sidebar,
// dashboard) consumes.
export type ChatSummary = Omit<Chat, "messages"> & { preview: string };

export type UsageEntry = {
  ts: number;
  account: string;
  model: string;
  sessionId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  costUsd: number;
};

function ensureDir() {
  fs.mkdirSync(DIR, { recursive: true });
}

function readChats(): Chat[] {
  try {
    return JSON.parse(fs.readFileSync(CHATS, "utf8")).chats as Chat[];
  } catch {
    return [];
  }
}

function writeChats(chats: Chat[]) {
  ensureDir();
  const tmp = CHATS + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ chats }, null, 2));
  fs.renameSync(tmp, CHATS);
}

// Last assistant text, normalized to a single line and capped — the ~100-char
// glimpse the list surfaces show under each session title. Scans from the end
// so the freshest reply wins; "" when a session has no assistant text yet.
function previewOf(messages: ChatMessage[] = []): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    const parts = m.parts ?? [];
    for (let j = parts.length - 1; j >= 0; j--) {
      const p = parts[j];
      if (p.type === "text") {
        const text = p.text.replace(/\s+/g, " ").trim();
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
    .map(({ messages, ...meta }) => ({ ...meta, preview: previewOf(messages) }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

type TokenTotals = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
};

function emptyTokenTotals(): TokenTotals {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 };
}

// Parsed usage.ndjson, indexed by sessionId — memoized across calls and
// invalidated by the ledger's own mtime (a fresh logUsage() append changes
// it). Without this, every GET of any chat that predates per-turn token
// accumulation (tokensFromUsageLog's only caller) would synchronously
// re-read and re-parse the ENTIRE append-only ledger — one line per turn
// across every chat/project/account ever run — on every single request.
let usageLogCache: { mtimeMs: number; bySession: Map<string, TokenTotals> } | null = null;

function usageLogBySession(): Map<string, TokenTotals> {
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(USAGE).mtimeMs;
  } catch {
    usageLogCache = null;
    return new Map();
  }
  if (usageLogCache && usageLogCache.mtimeMs === mtimeMs) return usageLogCache.bySession;

  const bySession = new Map<string, TokenTotals>();
  let lines: string[] = [];
  try {
    lines = fs.readFileSync(USAGE, "utf8").split("\n").filter(Boolean);
  } catch {
    usageLogCache = { mtimeMs, bySession };
    return bySession;
  }
  for (const line of lines) {
    let e: UsageEntry;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const totals = bySession.get(e.sessionId) ?? emptyTokenTotals();
    totals.inputTokens += e.inputTokens;
    totals.outputTokens += e.outputTokens;
    totals.cacheReadTokens += e.cacheReadTokens;
    totals.cacheCreateTokens += e.cacheCreateTokens;
    bySession.set(e.sessionId, totals);
  }
  usageLogCache = { mtimeMs, bySession };
  return bySession;
}

// Sums usage.ndjson entries for one session — the read-time fallback for
// chats persisted before per-turn token accumulation existed on Chat itself
// (appendTurn's `usage` accumulation is the primary path; this only kicks in
// when a chat predates it, detected by getChat via inputTokens===undefined).
function tokensFromUsageLog(sessionId: string): TokenTotals {
  return usageLogBySession().get(sessionId) ?? emptyTokenTotals();
}

export function getChat(id: string): Chat | undefined {
  const chat = readChats().find((c) => c.id === id);
  if (!chat) return undefined;
  // Old chats predate per-turn token accumulation (inputTokens is the
  // canary — all four fields were added together) — derive their totals
  // from the usage ledger instead of silently showing zero.
  if (chat.inputTokens === undefined) {
    return { ...chat, ...tokensFromUsageLog(chat.id) };
  }
  return chat;
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

export function appendTurn(opts: {
  id: string;
  model: string;
  effort?: string;
  account: string;
  project?: string;
  permissionMode?: ClientPermissionMode;
  // Session<->Loom link — set once a session is attached to a loom (see
  // Chat.loomId/role). Undefined means "no change"; only ever narrows a
  // link in, never clears one (see the guarded assignment below).
  loomId?: string;
  role?: "planner" | "steerer";
  userMessage: ChatMessage;
  assistantMessage: ChatMessage;
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
  }
  chat.messages.push(opts.userMessage, opts.assistantMessage);
  chat.costUsd += opts.costUsd;
  chat.turns += 1;
  chat.model = opts.model;
  chat.effort = opts.effort;
  chat.permissionMode = opts.permissionMode;
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
  // Session<->Loom link: guarded the same way — once a caller sets it, a
  // later turn that doesn't pass loomId/role must not wipe it back out.
  if (opts.loomId !== undefined) chat.loomId = opts.loomId;
  if (opts.role !== undefined) chat.role = opts.role;
  chat.updatedAt = now;
  writeChats(chats);
}

// Real subscription rate-limit state, captured from the SDK per account.
// This is the same data Claude Code's /usage dialog shows.
export type PlanWindow = {
  utilization: number | null; // 0-100
  resets_at: string | null; // ISO 8601
};

export type PlanSnapshot = {
  capturedAt: number;
  subscriptionType: string | null; // pro | max | team | enterprise
  fiveHour?: PlanWindow | null;
  sevenDay?: PlanWindow | null;
  sevenDayOpus?: PlanWindow | null;
  sevenDaySonnet?: PlanWindow | null;
  modelScoped?: { display_name: string; utilization: number | null; resets_at: string | null }[];
};

export function readPlanUsage(): Record<string, PlanSnapshot> {
  try {
    return JSON.parse(fs.readFileSync(PLAN, "utf8"));
  } catch {
    return {};
  }
}

export function savePlanUsage(account: string, snapshot: Partial<PlanSnapshot>) {
  ensureDir();
  const all = readPlanUsage();
  all[account] = { ...all[account], ...snapshot, capturedAt: Date.now() } as PlanSnapshot;
  const tmp = PLAN + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2));
  fs.renameSync(tmp, PLAN);
}

export function logUsage(entry: UsageEntry) {
  ensureDir();
  fs.appendFileSync(USAGE, JSON.stringify(entry) + "\n");
}

export type UsageWindow = {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  requests: number;
};

function emptyWindow(): UsageWindow {
  return { costUsd: 0, inputTokens: 0, outputTokens: 0, requests: 0 };
}

export function usageSummary(): {
  session: UsageWindow; // trailing 5h — approximates the subscription window
  weekly: UsageWindow; // trailing 7d
  byAccount: Record<string, { session: UsageWindow; weekly: UsageWindow }>;
} {
  const now = Date.now();
  const H5 = 5 * 60 * 60 * 1000;
  const D7 = 7 * 24 * 60 * 60 * 1000;
  const session = emptyWindow();
  const weekly = emptyWindow();
  const byAccount: Record<string, { session: UsageWindow; weekly: UsageWindow }> = {};

  let lines: string[] = [];
  try {
    lines = fs.readFileSync(USAGE, "utf8").split("\n").filter(Boolean);
  } catch {
    // no ledger yet
  }
  for (const line of lines) {
    let e: UsageEntry;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (now - e.ts > D7) continue;
    byAccount[e.account] ??= { session: emptyWindow(), weekly: emptyWindow() };
    const targets = [weekly, byAccount[e.account].weekly];
    if (now - e.ts <= H5) targets.push(session, byAccount[e.account].session);
    for (const t of targets) {
      t.costUsd += e.costUsd;
      t.inputTokens += e.inputTokens;
      t.outputTokens += e.outputTokens;
      t.requests += 1;
    }
  }
  return { session, weekly, byAccount };
}
