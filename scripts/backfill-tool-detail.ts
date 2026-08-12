#!/usr/bin/env bun
// One-off backfill: recover {id, input, output, isError} for legacy tool
// parts that old chats persisted as {type:"tool", name} only, before commit
// 9b71548 started persisting {id, input, output, isError} on every turn.
//
// The missing data still exists in the SDK session transcripts on disk
// (<configDir>/projects/<cwd-slug>/<sessionId>.jsonl). This script replays
// each affected chat's transcript, matches its legacy tool parts to the
// transcript's tool_use/tool_result blocks BY ORDER, and fills in the gap.
//
// Safety:
//   - Never touches parts that already have an id (new-format or already
//     backfilled) — only `{type:"tool"}` parts missing `id` are candidates.
//   - Never reads/writes SDK transcript files — read-only source of truth.
//   - Backs up every chat this run will modify (full pre-image) before any
//     write, to <telarDir>/backfill-backup-<chatId>.json.
//   - If a chat's legacy tool-part count/names don't line up 1:1 with the
//     transcript's tool_use blocks, the whole chat is skipped and reported
//     rather than guessed at.
//   - `--dry-run` runs the full scan/match and prints the report without
//     touching any file.
//
// Usage: bun scripts/backfill-tool-detail.ts [--dry-run]

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  capToolInput,
  capToolOutput,
  extractToolResultText,
} from "../apps/web_old/lib/transcript";
import type { Chat, Part } from "../apps/web_old/lib/store";

const TELAR_DIR = path.join(os.homedir(), ".telar");
const CHATS_FILE = path.join(TELAR_DIR, "chats.json");

// Mirrors apps/web_old/lib/accounts.ts (kept as a plain literal here so this
// script has no workspace/module-resolution dependency on the Next app).
const CONFIG_DIRS: Record<string, string> = {
  personal: path.join(os.homedir(), ".claude"),
  work: path.join(os.homedir(), ".claude-work"),
};

type RegistryEntry = { name: string; root: string; addedAt: number };
type Registry = Record<string, RegistryEntry>;

function readRegistry(): Registry {
  return JSON.parse(fs.readFileSync(path.join(TELAR_DIR, "projects.json"), "utf8"));
}

// cwd-slug: the project root with every "/" replaced by "-".
function slugify(root: string): string {
  return root.replace(/\//g, "-");
}

type TranscriptToolUse = { id: string; name: string; input: Record<string, unknown> };
type TranscriptToolResult = { content: unknown; isError: boolean };

// Parses one session transcript, mirroring the same top-level filtering
// app/api/chat/route.ts applies while streaming live: skip any assistant/user
// message that is itself a subagent relay (parentToolUseId set) — its
// tool_use/tool_result blocks never appear in the top-level chat this store
// persists, so they must not be counted when matching by order.
function parseTranscript(file: string): {
  toolUses: TranscriptToolUse[];
  resultsById: Map<string, TranscriptToolResult>;
} {
  const toolUses: TranscriptToolUse[] = [];
  const resultsById = new Map<string, TranscriptToolResult>();
  const raw = fs.readFileSync(file, "utf8");
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // corrupt/partial trailing line — best-effort skip
    }
    if (obj.isSidechain || obj.parentToolUseId) continue;

    if (obj.type === "assistant") {
      const content = obj.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block?.type === "tool_use") {
          toolUses.push({
            id: block.id,
            name: block.name,
            input: (block.input ?? {}) as Record<string, unknown>,
          });
        }
      }
    } else if (obj.type === "user") {
      const content = obj.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block?.type === "tool_result") {
          resultsById.set(block.tool_use_id, {
            content: block.content,
            isError: !!block.is_error,
          });
        }
      }
    }
  }
  return { toolUses, resultsById };
}

type LegacyPartRef = { msgIndex: number; partIndex: number; name: string };

// Legacy = a "tool" part missing `id` — the exact marker the old persistence
// shape left behind. Chats never mix legacy and enriched tool parts (verified
// against the live data before writing this script), but this only ever
// selects the legacy ones regardless.
function legacyToolParts(chat: Chat): LegacyPartRef[] {
  const refs: LegacyPartRef[] = [];
  chat.messages.forEach((m, mi) => {
    m.parts.forEach((p, pi) => {
      if (p.type === "tool" && !p.id) refs.push({ msgIndex: mi, partIndex: pi, name: p.name });
    });
  });
  return refs;
}

type ChatResult =
  | { status: "enriched"; chatId: string; count: number }
  | { status: "clean"; chatId: string }
  | { status: "skipped"; chatId: string; reason: string };

function processChat(
  chat: Chat,
  registry: Registry,
): { result: ChatResult; modified?: Chat } {
  const legacy = legacyToolParts(chat);
  if (legacy.length === 0) return { result: { status: "clean", chatId: chat.id } };

  if (!chat.project) {
    return { result: { status: "skipped", chatId: chat.id, reason: "chat has no project field" } };
  }
  const entry = registry[chat.project];
  if (!entry) {
    return {
      result: {
        status: "skipped",
        chatId: chat.id,
        reason: `project "${chat.project}" not found in ~/.telar/projects.json`,
      },
    };
  }
  const configDir = CONFIG_DIRS[chat.account];
  if (!configDir) {
    return { result: { status: "skipped", chatId: chat.id, reason: `unknown account "${chat.account}"` } };
  }

  const tPath = path.join(configDir, "projects", slugify(entry.root), `${chat.id}.jsonl`);
  if (!fs.existsSync(tPath)) {
    return { result: { status: "skipped", chatId: chat.id, reason: `transcript not found: ${tPath}` } };
  }

  const { toolUses, resultsById } = parseTranscript(tPath);

  if (toolUses.length !== legacy.length) {
    return {
      result: {
        status: "skipped",
        chatId: chat.id,
        reason: `count mismatch: store has ${legacy.length} legacy tool parts, transcript has ${toolUses.length} top-level tool_use blocks (${tPath})`,
      },
    };
  }
  for (let i = 0; i < legacy.length; i++) {
    if (legacy[i].name !== toolUses[i].name) {
      return {
        result: {
          status: "skipped",
          chatId: chat.id,
          reason: `name mismatch at position ${i}: store has "${legacy[i].name}", transcript has "${toolUses[i].name}" (${tPath})`,
        },
      };
    }
  }

  // Positions and names agree end to end — safe to apply.
  const clone: Chat = JSON.parse(JSON.stringify(chat));
  for (let i = 0; i < legacy.length; i++) {
    const ref = legacy[i];
    const tu = toolUses[i];
    const part = clone.messages[ref.msgIndex].parts[ref.partIndex] as Extract<Part, { type: "tool" }>;
    part.id = tu.id;
    part.input = capToolInput(tu.input);
    const res = resultsById.get(tu.id);
    if (res) {
      part.output = capToolOutput(extractToolResultText(res.content));
      part.isError = res.isError;
    } else {
      // No tool_result anywhere in the transcript for this call — it never
      // resolved (aborted/crashed mid-flight), same signal route.ts flags
      // live turns with.
      part.interrupted = true;
    }
  }

  return { result: { status: "enriched", chatId: chat.id, count: legacy.length }, modified: clone };
}

function main() {
  const dryRun = process.argv.includes("--dry-run");
  const chatsData = JSON.parse(fs.readFileSync(CHATS_FILE, "utf8")) as { chats: Chat[] };
  const registry = readRegistry();

  const originalById = new Map(chatsData.chats.map((c) => [c.id, c]));
  const results: ChatResult[] = [];
  const modifiedChats: Chat[] = [];

  const nextChats = chatsData.chats.map((chat) => {
    const { result, modified } = processChat(chat, registry);
    results.push(result);
    if (modified) modifiedChats.push(modified);
    return modified ?? chat;
  });

  const enriched = results.filter((r): r is Extract<ChatResult, { status: "enriched" }> => r.status === "enriched");
  const clean = results.filter((r) => r.status === "clean");
  const skipped = results.filter((r): r is Extract<ChatResult, { status: "skipped" }> => r.status === "skipped");

  console.log(`${dryRun ? "[dry-run] " : ""}Scanned ${results.length} chats.`);
  console.log(`  enriched: ${enriched.length}`);
  for (const r of enriched) console.log(`    - ${r.chatId}: ${r.count} tool part(s)`);
  console.log(`  already clean (no legacy tool parts): ${clean.length}`);
  console.log(`  skipped: ${skipped.length}`);
  for (const r of skipped) console.log(`    - ${r.chatId}: ${r.reason}`);

  if (dryRun) {
    console.log("\n--dry-run: no files written.");
    return;
  }

  if (modifiedChats.length === 0) {
    console.log("\nNothing to write.");
    return;
  }

  fs.mkdirSync(TELAR_DIR, { recursive: true });
  for (const chat of modifiedChats) {
    const original = originalById.get(chat.id)!;
    const backupPath = path.join(TELAR_DIR, `backfill-backup-${chat.id}.json`);
    fs.writeFileSync(backupPath, JSON.stringify(original, null, 2));
    console.log(`Backed up ${chat.id} -> ${backupPath}`);
  }

  const tmp = CHATS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ chats: nextChats }, null, 2));
  fs.renameSync(tmp, CHATS_FILE);
  console.log(`\nWrote ${CHATS_FILE} (${modifiedChats.length} chat(s) enriched).`);
}

main();
