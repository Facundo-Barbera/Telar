// GALLERY (delete with /gallery) — GallerySessionSeed fixtures for the mirrored
// session stage (session-plain / -empty / -planner). These feed the REAL
// SessionsRail + SessionView; the session stage mirrors the SERVER wiring of
// app/projects/[name]/sessions/[id]/page.tsx:75-126 and
// app/looms/plan/[project]/page.tsx:89-108. The /api/chat* stream stays
// benign-stubbed (a documented limitation — the transcript below is the seed the
// page resumes from, not a live turn).
import type { GallerySessionSeed } from "../../index";
import { makeChat, makeStoreMessage } from "../../builders";
import { accountsList, finchChats } from "./projects";

// Display-only account metadata for the client picker (the page passes plain
// { name, displayTier } data so the client never imports the server registry).
const pickerAccounts = accountsList.map((a) => ({ name: a.name, displayTier: a.displayTier }));

// A resumed finch session with a real (text/tool/text) transcript.
const resumedChat = makeChat({
  id: "gallery__chat-finch-1",
  model: "claude-sonnet-4",
  costUsd: 0.42,
  inputTokens: 18_400,
  outputTokens: 2_100,
  contextTokens: 21_000,
  messages: [
    makeStoreMessage("user", [
      { type: "text", text: "Add satisfies(version, range) covering ^, ~, and hyphen ranges." },
    ]),
    makeStoreMessage("assistant", [
      { type: "text", text: "I'll start by reading the existing comparator so the new range logic reuses compareIdentifiers." },
      {
        type: "tool",
        name: "Read",
        id: "toolu_read_1",
        input: { file_path: "/Users/you/code/finch/src/compare.ts" },
        output: "export function compareIdentifiers(a: string, b: string): number { … }",
      },
      {
        type: "tool",
        name: "Edit",
        id: "toolu_edit_1",
        input: { file_path: "/Users/you/code/finch/src/satisfies.ts", old_string: "", new_string: "export function satisfies(v, range) { … }" },
        output: "Applied edit to src/satisfies.ts",
      },
      { type: "text", text: "Added satisfies() with caret, tilde, and hyphen-range handling. Running the comparator suite next." },
    ]),
  ],
});

export const sessionPlainSeed: GallerySessionSeed = {
  project: "finch",
  account: "personal",
  accounts: pickerAccounts,
  initialChat: resumedChat,
  sessions: finchChats,
  activeId: resumedChat.id,
};

// A fresh session: no transcript (initialChat undefined → the "Work in this
// repo" empty framing), empty rail, activeId "new".
export const sessionEmptySeed: GallerySessionSeed = {
  project: "finch",
  account: "personal",
  accounts: pickerAccounts,
  initialChat: undefined,
  initialTitle: "New session",
  sessions: [],
  activeId: "new",
};

// A loom-planning session: planner framing + the Loom-Session banner. No chat
// yet (the role is a hint until the loom MCP server drafts a bundle).
export const sessionPlannerSeed: GallerySessionSeed = {
  project: "aurora",
  account: "work",
  accounts: pickerAccounts,
  initialChat: undefined,
  initialTitle: "Plan a new loom",
  initialRole: "planner",
  planner: true,
  sessions: [],
  activeId: "new",
};
