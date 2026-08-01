// LANE: conversation (UX BRAINSTORM 2026-07-23) — fixtures for the six
// configurations the six hand-rebuilt chat lanes need.
//
// SELF-CONTAINED, LIKE EVERY OTHER LANE. No request of any kind, no scene, no
// GALLERY_ID_PREFIX id, and deliberately NOT routed through the dormant
// gallery-fetch interceptor: the shell has no data fetching at all (AD-12), so
// there is nothing to intercept. If a fixture here ever needed the interceptor,
// that would be proof someone had wired session semantics into the shell.
//
// EVERY AGE STRING GOES THROUGH `fmtAgo`/`DEMO_NOW`. Reading the wall clock
// makes SSR and hydration compute different "Xm ago" strings, React fails
// hydration, regenerates the tree, and the stage paints EMPTY — a failure that
// looks exactly like a broken component.
//
// The items below are built with the REAL exported types and the REAL kind ids,
// so `fixtures.validate.test.ts` can resolve every one of them against the
// production registry rather than against a copy of it.

import {
  CONVERSATION_KINDS,
  type MarkerPayload,
  type PermissionPart,
  type PermissionPayload,
  type StatusPayload,
  type TextPayload,
  type ThinkingPayload,
  type ToolsPayload,
  type TranscriptItem,
  type TurnPayload,
} from "@/components/conversation";
import type { ToolPart } from "@/components/session/tool-step";
import { DEMO_NOW, fmtAgo } from "../now";

/** The six configurations, one per lane the 2026-07-23 session found rebuilt by
 *  hand. The ids double as the gallery entry ids. */
export const CONVERSATION_CONFIGS = [
  "conversation-full",
  "conversation-minimal",
  "conversation-readonly",
  "conversation-rail-desk",
  "conversation-approval",
  "conversation-empty-and-tombstone",
] as const;

export type ConversationConfig = (typeof CONVERSATION_CONFIGS)[number];

/** Deliberately NOT registered anywhere. Configuration 6 exists to show AD-8's
 *  tombstone: a transcript containing one unknown kind still renders every other
 *  item, and says which id was missing. Track D registers this for real in 4.2. */
export const UNREGISTERED_KIND = "ultra:run-anchor";

// ── builders (the envelope is the same one production mints) ────────────────

const text = (key: string, body: string): TranscriptItem => ({
  kind: CONVERSATION_KINDS.text,
  key,
  payload: { text: body } satisfies TextPayload,
});

const thinking = (key: string, body: string, done = true): TranscriptItem => ({
  kind: CONVERSATION_KINDS.thinking,
  key,
  payload: { text: body, done } satisfies ThinkingPayload,
});

const tools = (key: string, parts: ToolPart[]): TranscriptItem => ({
  kind: CONVERSATION_KINDS.tools,
  key,
  payload: { parts } satisfies ToolsPayload,
});

const marker = (key: string, body: string, attention?: boolean): TranscriptItem => ({
  kind: CONVERSATION_KINDS.marker,
  key,
  payload: { text: body, ...(attention ? { attention } : {}) } satisfies MarkerPayload,
});

const permission = (
  key: string,
  part: PermissionPart,
  onRespond?: PermissionPayload["onRespond"],
): TranscriptItem => ({
  kind: CONVERSATION_KINDS.permission,
  key,
  payload: { part, onRespond } satisfies PermissionPayload,
});

const turn = (
  key: string,
  from: TurnPayload["from"],
  items: TranscriptItem[],
): TranscriptItem => ({
  kind: CONVERSATION_KINDS.turn,
  key,
  payload: { from, items } satisfies TurnPayload,
});

// The live in-flight row. A fixture is a STILL of a moving thing, so this one
// picks the `tool` arm: it is the only WorkState that carries a name and a
// target, and a gallery still of "starting"/"working" is an unlabelled spinner
// no reviewer can judge. `elapsed` is a constant for the same reason every age
// string here goes through DEMO_NOW — a wall-clock read would hydrate differently.
const status = (key: string, state: StatusPayload["state"]): TranscriptItem => ({
  kind: CONVERSATION_KINDS.status,
  key,
  payload: { state } satisfies StatusPayload,
});

const tool = (name: string, id: string, input: Record<string, unknown>, output?: string): ToolPart => ({
  type: "tool",
  name,
  id,
  input,
  ...(output === undefined ? {} : { output }),
});

// ── the raw material ────────────────────────────────────────────────────────

export const PENDING_PERMISSION: PermissionPart = {
  type: "permission",
  id: "perm_1",
  toolName: "Edit",
  input: { file_path: "apps/web/components/conversation/conversation.tsx" },
  rule: "Edit(apps/web/components/conversation/**)",
  ruleOptions: [
    { rule: "Edit(apps/web/components/conversation/conversation.tsx)", label: "this file only" },
    { rule: "Edit(apps/web/components/conversation/**)", label: "the conversation directory" },
    { rule: "Edit(apps/web/**)", label: "anywhere in apps/web" },
  ],
  status: "pending",
};

export const RESOLVED_PERMISSION: PermissionPart = {
  ...PENDING_PERMISSION,
  id: "perm_2",
  toolName: "Bash",
  input: { command: "bun test apps/web/components/conversation" },
  rule: "Bash(bun test:*)",
  status: "allowed",
};

const READ = tool("Read", "t_read", { file_path: "docs/loom-model.md" }, "…4.1kB");
const GREP = tool("Grep", "t_grep", { pattern: "createItemKindRegistry" }, "3 matches");
const BASH = tool("Bash", "t_bash", { command: "bun test packages/core" }, "2011 pass / 0 fail");
const RUNNING = tool("Edit", "t_edit", { file_path: "components/conversation/kinds.tsx" });

const AGO = fmtAgo(DEMO_NOW - 8 * 60 * 1000);

// A transcript that exercises every built-in kind at least once.
const EVERY_KIND: TranscriptItem[] = [
  turn("m1", "user", [text("m1:0", "Carve the chat window out of session-view and give it a registry.")]),
  turn("m2", "assistant", [
    thinking("m2:0", "Two dispatch switches over the same union — the second one's own comment admits it mirrors the first. Collapse them."),
    tools("t_read", [READ, GREP]),
    text("m2:1", "`groupParts` and its four-variant projection move to `components/conversation/items.ts`; the shell renders them through the registry."),
  ]),
  marker("k_marker", `shell extracted · 11 modules · ${AGO}`),
  turn("m3", "assistant", [
    tools("t_bash", [BASH]),
    text("m3:0", "Gate is green. One dispatch site left, which is the whole proof."),
  ]),
];

// ── the six configurations ──────────────────────────────────────────────────

export const CONVERSATION_FIXTURES: Record<ConversationConfig, readonly TranscriptItem[]> = {
  // 1 — the donor: everything on, every kind present, ending on a live approval.
  "conversation-full": [
    ...EVERY_KIND,
    turn("m4", "assistant", [
      tools("t_edit", [RUNNING]),
      permission("m4:1", PENDING_PERMISSION),
      // LAST, exactly where the adapter appends it in production: the status row
      // narrates the turn rather than adding to it, and `isTrailingItem` exempts
      // it so the running tools group above keeps its liveness and its spinner.
      status("m4:2", { kind: "tool", tool: "Edit", target: "components/conversation/kinds.tsx", elapsed: 12 }),
    ]),
  ],

  // 2 — loom node chats: "talking is free". No header, no rail, a bare composer.
  "conversation-minimal": [
    turn("n1", "user", [text("n1:0", "Why is this node still waiting?")]),
    turn("n2", "assistant", [
      text("n2:0", "Its upstream contract hasn't been signed off. Nothing here is blocked on you yet."),
    ]),
    marker("n_marker", "node parked — waiting on the gate", true),
  ],

  // 3 — TranscriptView / agent transcripts. NO composer, no rail, and every kind
  // still renders — including the approval card, which degrades to read-only
  // because its payload simply omits the callback. This configuration is AC4's
  // visible proof and is the one that must never be dropped for time.
  "conversation-readonly": [
    ...EVERY_KIND,
    turn("r4", "assistant", [permission("r4:0", PENDING_PERMISSION)]),
    turn("r5", "assistant", [permission("r5:0", RESOLVED_PERMISSION)]),
  ],

  // 4 — master chat's Desk: one slot, a DIFFERENT rail.
  "conversation-rail-desk": [
    turn("d1", "user", [text("d1:0", "What's across the whole workspace right now?")]),
    turn("d2", "assistant", [
      tools("d_tools", [GREP]),
      text("d2:0", "Three looms weaving, one parked on a question, one ready for you."),
    ]),
    marker("d_marker", `desk refreshed · ${AGO}`),
  ],

  // 5 — the cockpit gate room (UX-DR7): an approval as the last item, in BOTH
  // label vocabularies. One component, one protocol shape, two vocabularies.
  "conversation-approval": [
    turn("g1", "assistant", [
      text("g1:0", "The PRD delta is drafted. Advancing this node commits it into the flow compile."),
    ]),
    turn("g2", "assistant", [permission("g2:0", PENDING_PERMISSION)]),
  ],

  // 6 — the degradation contract, which nothing else shows: the empty state, and
  // an unregistered kind rendering its tombstone beside items that render fine.
  "conversation-empty-and-tombstone": [
    turn("e1", "user", [text("e1:0", "Show me the run anchor.")]),
    { kind: UNREGISTERED_KIND, key: "e_unknown", payload: { runId: "run_1" } },
    turn("e2", "assistant", [
      text("e2:0", "The item above is registered by another module. This transcript still renders."),
    ]),
  ],
};

/** Every item in a configuration, nested composites included — what a validator
 *  has to walk, and what the shell actually dispatches. */
export function flattenItems(items: readonly TranscriptItem[]): TranscriptItem[] {
  const out: TranscriptItem[] = [];
  for (const item of items) {
    out.push(item);
    const nested = (item.payload as { items?: readonly TranscriptItem[] } | null)?.items;
    if (Array.isArray(nested)) out.push(...flattenItems(nested));
  }
  return out;
}
