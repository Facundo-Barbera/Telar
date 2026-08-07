// The transcript as a file the user keeps: what GET /api/chats/[id]/export
// hands back. Pure, and separate from the route, so the FORMAT is testable
// without a request.
//
// THE INPUT IS THE PERSISTED CHAT (chats.json), never the session feed.
// feed.ndjson holds one window and is truncated when the next one opens (see
// session-log.ts's startSessionFeedWindow), so a feed-sourced export would ship
// the last question and call it the conversation.

import type { Chat, ChatMessage, Part } from "./store";

// Narration is live-stream-only: the server emits "thinking" over SSE and never
// writes it into a persisted Part (components/conversation/items.ts's Part
// union states the invariant). It is named here anyway, because that guarantee
// lives in another module and this file leaves the machine — if narration ever
// starts landing in chats.json it must be dropped HERE rather than shipped by
// default in something the user forwards.
type ExportPart = Part | { type: "thinking"; text?: string };

/**
 * Only what the renderer reads. A fixture is three fields rather than a whole
 * persisted Chat, and the format cannot quietly start depending on cost,
 * tokens or inbox state.
 */
export type TranscriptChat = Pick<Chat, "id" | "title"> & {
  messages: readonly { role: ChatMessage["role"]; parts: readonly ExportPart[] }[];
};

// The salient argument of a tool call, in the same precedence the transcript's
// own step rows use — see components/session/tool-step.tsx's stepPreview, cited
// by symbol because importing a "use client" module into a server route would
// drag React through it. An export is not a debug dump: everything outside this
// list stays behind.
const TARGET_KEYS = ["command", "file_path", "pattern", "path", "url"] as const;

function toolTarget(input?: Record<string, unknown>): string | null {
  if (!input) return null;
  const key = TARGET_KEYS.find((k) => typeof input[k] === "string" && input[k]);
  if (!key) return null;
  const oneLine = String(input[key]).replace(/\s+/g, " ").trim();
  if (!oneLine) return null;
  // Code points, not UTF-16 units: a plain slice can cut an astral character in
  // half exactly at the boundary.
  const points = Array.from(oneLine);
  return points.length > 80 ? `${points.slice(0, 80).join("")}…` : oneLine;
}

// Every line prefixed, not just the first: a marker carrying a newline would
// otherwise close the quote and continue as prose.
const blockquote = (text: string) =>
  text
    .split("\n")
    .map((line) => `> ${line}`.trimEnd())
    .join("\n");

// "You"/"Assistant", not the stored role words — the file is read away from the
// UI that made "user" obvious.
const heading = (role: ChatMessage["role"]) => (role === "user" ? "## You" : "## Assistant");

function messageBlocks(parts: readonly ExportPart[]): string[] {
  const blocks: string[] = [];
  // Consecutive tool calls stay in ONE block so they render as one list: a
  // blank line between two "- " lines is two lists to most renderers.
  let steps: string[] = [];
  const flush = () => {
    if (steps.length) blocks.push(steps.join("\n"));
    steps = [];
  };

  for (const part of parts) {
    if (part.type === "tool") {
      const target = toolTarget(part.input);
      steps.push(`- ${part.name}${target ? ` \`${target}\`` : ""}`);
      continue;
    }
    flush();
    switch (part.type) {
      case "text": {
        const text = part.text.trim();
        if (text) blocks.push(text);
        break;
      }
      case "marker":
        blocks.push(blockquote(part.text));
        break;
      case "attachments": {
        // Names only. The bytes have a lifetime of their own (archiving a chat
        // destroys them, see lib/attachments.ts), so a link here would rot.
        const names = part.files.map((file) => file.name).filter(Boolean);
        if (names.length) blocks.push(`Attachments: ${names.join(", ")}`);
        break;
      }
      // "thinking", and any part kind added after this file: dropped rather
      // than guessed at. See ExportPart.
      default:
        break;
    }
  }

  flush();
  return blocks;
}

export function chatToMarkdown(chat: TranscriptChat): string {
  const blocks: string[] = [`# ${chat.title.trim() || "Untitled session"}`];

  for (const message of chat.messages) {
    const body = messageBlocks(message.parts);
    // A message whose every part was dropped contributes nothing: a lone
    // heading over blank space reads as content that went missing.
    if (body.length) blocks.push(heading(message.role), ...body);
  }

  return `${blocks.join("\n\n")}\n`;
}

const slugify = (raw: string) =>
  raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 60)
    .replace(/^-+|-+$/g, "");

/**
 * The download's filename. ASCII-only BY CONSTRUCTION: this lands in a quoted
 * Content-Disposition and a title is arbitrary user text, so the sanitizer is
 * what keeps a quote, a newline or a path separator out of that header — not
 * the caller's quoting.
 *
 * A title that is entirely emoji or CJK slugifies to nothing; the id at least
 * says which session the file is.
 */
export function transcriptFilename(chat: Pick<TranscriptChat, "id" | "title">): string {
  return `${slugify(chat.title) || slugify(chat.id) || "transcript"}.md`;
}
