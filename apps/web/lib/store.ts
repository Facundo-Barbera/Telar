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
  | { type: "text"; text: string }
  | { type: "tool"; name: string };

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
  messages: ChatMessage[];
};

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

export function listChats(project?: string): Omit<Chat, "messages">[] {
  return readChats()
    .filter((c) => (project ? c.project === project : true))
    .map(({ messages: _messages, ...meta }) => meta)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getChat(id: string): Chat | undefined {
  return readChats().find((c) => c.id === id);
}

export function deleteChat(id: string) {
  writeChats(readChats().filter((c) => c.id !== id));
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
