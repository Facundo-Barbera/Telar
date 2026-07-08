// File-backed persistence in ~/.telar — chats.json (chat history) and
// usage.ndjson (append-only usage ledger). Files remember; no database.
import fs from "fs";
import os from "os";
import path from "path";

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
    };

export type ChatMessage = {
  role: "user" | "assistant";
  parts: Part[];
};

export type Chat = {
  id: string; // = SDK session id (stable across resumes)
  title: string;
  model: string;
  account: string;
  project?: string; // registry name of the anchoring project (optional: old entries predate it)
  createdAt: number;
  updatedAt: number;
  costUsd: number;
  turns: number;
  archived?: boolean; // optional: absent on entries predating archiving
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

export function getChat(id: string): Chat | undefined {
  return readChats().find((c) => c.id === id);
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

export function appendTurn(opts: {
  id: string;
  model: string;
  account: string;
  project?: string;
  userMessage: ChatMessage;
  assistantMessage: ChatMessage;
  costUsd: number;
}) {
  const chats = readChats();
  let chat = chats.find((c) => c.id === opts.id);
  const now = Date.now();
  if (!chat) {
    const firstText = opts.userMessage.parts.find((p) => p.type === "text");
    chat = {
      id: opts.id,
      title:
        (firstText?.type === "text" ? firstText.text : "New thread").slice(0, 60),
      model: opts.model,
      account: opts.account,
      project: opts.project,
      createdAt: now,
      updatedAt: now,
      costUsd: 0,
      turns: 0,
      messages: [],
    };
    chats.push(chat);
  }
  chat.messages.push(opts.userMessage, opts.assistantMessage);
  chat.costUsd += opts.costUsd;
  chat.turns += 1;
  chat.model = opts.model;
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
