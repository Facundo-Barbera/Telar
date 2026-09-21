/**
 * `/resume`'s PICKER (#616) — and what it has to show for a person to be able
 * to choose at all.
 *
 * The finding these pin is not a design preference. Six identically-titled
 * conversations were produced deliberately in one directory and the CLI ITSELF
 * refused to resolve between them (`--resume "PINEAPPLE-7742" matches 6
 * sessions`). A picker that leant on titles would reproduce that failure here,
 * so every row carries the person's own opening words, when they were last in
 * it, which project, and how much of it there is.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import type { ClaudeConversation, ConversationImportDetail } from "@telar/engine-client";
import type { JournalItem } from "@/lib/engine/journal";
import { ConversationRow } from "./resume-picker";
import { TranscriptItem } from "../transcript";

/** Two conversations the CLI named identically — the case that matters. */
const SAME_TITLE: ClaudeConversation[] = [
  {
    sessionId: "1111aaaa-1111-4111-8111-111111111111",
    title: "PINEAPPLE-7742",
    firstPrompt: "Set up the deploy script for staging",
    lastActivityAt: Date.now() - 3 * 60 * 60 * 1000,
    cwd: "/work/telar",
    gitBranch: "main",
    bytes: 245_760,
  },
  {
    sessionId: "2222bbbb-2222-4222-8222-222222222222",
    title: "PINEAPPLE-7742",
    firstPrompt: "Why does the parser drop the last column",
    lastActivityAt: Date.now() - 40 * 60 * 1000,
    cwd: "/work/other",
    bytes: 4_096,
  },
];

const row = (conversation: ClaudeConversation) =>
  renderToStaticMarkup(<ConversationRow conversation={conversation} onPick={() => undefined} />);

test("two identically-titled conversations are still tellable apart", () => {
  /**
   * THE MEASURED FAILURE, as an assertion: the rows share a title and nothing
   * else, and what the person reads is the part that differs.
   */
  const [first, second] = SAME_TITLE.map(row) as [string, string];
  expect(first).toContain("Set up the deploy script for staging");
  expect(second).toContain("Why does the parser drop the last column");
  expect(first).toContain("/work/telar");
  expect(second).toContain("/work/other");
  // How much conversation there is — a long thread from a one-line question.
  expect(first).toContain("240 KB");
  expect(second).toContain("4.0 KB");
  // And when they were last in it.
  expect(first).toContain("3h ago");
  expect(second).toContain("40m ago");
});

test("a conversation with no opening prompt still shows something a person chose", () => {
  const html = row({
    sessionId: "4444dddd-4444-4444-8444-444444444444",
    title: "PINEAPPLE-7742",
    customTitle: "The parser rewrite",
    lastActivityAt: Date.now() - 60_000,
  });
  // The name they gave it beats the one the CLI generated.
  expect(html).toContain("The parser rewrite");
});

test("the dialog says the conversation is copied rather than continued", () => {
  /**
   * PINNED AGAINST SOURCE, like the command palette's suite and for the same
   * reason: the dialog renders through a portal, so a static render produces no
   * markup to assert on.
   *
   * NOT A DETAIL. Telar forks so it never writes into somebody's own Claude
   * Code history, and "your own copy is untouched" is exactly the kind of thing
   * a person should be told rather than left to discover.
   */
  const source = readFileSync(new URL("./resume-picker.tsx", import.meta.url), "utf8");
  expect(source).toContain("forks the conversation");
  expect(source).toContain("Claude Code history is left");
  // "No conversations" and "the store could not be read" must not look the same.
  expect(source).toContain("Reading your conversations…");
  expect(source).toContain("could not be read");
});

test("the transcript's head row says where an adopted conversation came from", () => {
  /**
   * THE ONLY RECORD THERE IS. The CLI stamps nothing about a fork's origin —
   * measured, the forked transcript mentions the source id zero times — so a
   * session that quietly knows a conversation it never had is indistinguishable
   * from one that invented it unless this row says so.
   */
  const detail: ConversationImportDetail = {
    provider: "claude",
    sourceSessionId: "1111aaaa-1111-4111-8111-111111111111",
    sessionId: "3333cccc-3333-4333-8333-333333333333",
    sourceCwd: "/work/telar",
    firstPrompt: "Set up the deploy script for staging",
    records: 240,
    cut: "whole",
    rows: 72,
    rowCut: "row_budget",
    sourceBytes: 245_760,
  };
  const item: JournalItem = {
    id: "import_run_one",
    runId: "run_one",
    sessionId: "session_one",
    status: "completed",
    detail: { type: "conversation_import", import: detail },
    startedAt: Date.now(),
    completedAt: Date.now(),
    streamedText: "",
    openedBy: 1,
  };

  const html = renderToStaticMarkup(<TranscriptItem item={item} />);
  expect(html).toContain("Imported from Claude Code");
  expect(html).toContain("untouched");
  // WHICH conversation, by the field that actually identifies one.
  expect(html).toContain("Set up the deploy script for staging");
  expect(html).toContain("1111aaaa-1111-4111-8111-111111111111");
  expect(html).toContain("/work/telar");
  // BOTH CUTS, because they disagree here: 240 records is what the model still
  // remembers, 72 rows is what the person can scroll.
  expect(html).toContain("240 records");
  expect(html).toContain("72 rows shown");
});

test("a whole import that fitted does not report two numbers for one fact", () => {
  const detail: ConversationImportDetail = {
    provider: "claude",
    sourceSessionId: "1111aaaa-1111-4111-8111-111111111111",
    sessionId: "3333cccc-3333-4333-8333-333333333333",
    records: 12,
    cut: "whole",
    rows: 12,
    rowCut: "whole",
  };
  const item: JournalItem = {
    id: "import_run_two",
    runId: "run_two",
    sessionId: "session_one",
    status: "completed",
    detail: { type: "conversation_import", import: detail },
    startedAt: Date.now(),
    completedAt: Date.now(),
    streamedText: "",
    openedBy: 1,
  };
  const html = renderToStaticMarkup(<TranscriptItem item={item} />);
  expect(html).toContain("12 records");
  expect(html).not.toContain("rows shown");
});
