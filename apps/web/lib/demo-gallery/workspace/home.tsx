"use client";
// LANE: workspace (CONCEPT) — the master chat. One project-less conversation
// that is the module's front door: pull-based (it never pings), it answers
// "where did I stop?" with a briefing, swallows a brain dump, and returns a
// receipt whose item count matches the input — the conservation law on screen.
//
// Direction (3rd pass): items the agents create land on a RIGHT RAIL — the
// "Desk", same pattern as the session surfaces' right sidebar. The master says
// "it's on your sidebar"; talking about an item edits it in place without
// moving it; dismissing (✕) drains it to the queue, never deletes. The faux
// left sidebar remains a static prop showing nav placement only.
//
// ── RE-SKIN PASS (2026-08-08): THE MASTER CHAT IS NOW DRAWN BY THE REAL SHELL ─
// ui-contract.md §1 says it in as many words — "the master chat IS a session —
// user turns wear the production message bubble idiom, built on the shared
// `Conversation` shell". When this mockup was drawn there was no such shell, so
// it hand-rolled `You`/`Master` bubbles out of `rounded-lg bg-secondary` and a
// bordered avatar circle. Both are gone: the transcript below is
// components/conversation's `Conversation`, configured through the four slots
// (items · kinds · composer · rail · header) exactly the way an owner adapter
// configures it, and the bubbles are `conversation:turn` — i.e. the production
// `Message`/`MessageContent`. Precedent and permission: the shell's own gallery
// lane already renders a "master chat's Desk" configuration
// (lib/demo-gallery/conversation/shell.tsx's ConversationRailDeskDemo).
//
// THE FOUR RICH SURFACES ARE REGISTERED KINDS, not inline JSX, and the ids are
// design output rather than decoration: `workspace:` is already a member of the
// shell's CLOSED namespace vocabulary (registry.ts's MODULE_NAMESPACES), so
// briefing / gap / witness / receipt are the four registrations the master
// chat's owner adapter will make. Naming them here is what a design source is
// for — the alternative (one anonymous "render this JSX" kind) would hide the
// only architectural decision this surface actually implies.
//
// CONTENT IS UNTOUCHED. Every word, every band, every chip label is the 25 Jul
// prototype's. Inline `<span className="font-mono text-xs">` around a project
// name is now a markdown code span, because prose reaches the bubble through
// `MessageResponse` (streamdown) the way it does in every other chat in the
// app — same rendering, one fewer hand-spelled type scale.
import type { ReactNode } from "react";
import {
  ActivityIcon,
  CalendarIcon,
  CheckIcon,
  FlagIcon,
  FolderGit2Icon,
  HelpCircleIcon,
  LayoutDashboardIcon,
  ListTodoIcon,
  MoonIcon,
  SettingsIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import {
  BUILTIN_KINDS,
  CONVERSATION_KINDS,
  Conversation,
  MessageResponse,
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  createItemKindRegistry,
  type ItemKind,
  type TextPayload,
  type TranscriptItem,
  type TurnPayload,
} from "@/components/conversation";
import { Badge } from "@/components/ui/badge";
import { Chip } from "@/components/common/list-controls";
import { PageHeader } from "@/components/common/page-header";
import { cn } from "@/lib/utils";
import { WS_DESK, WS_ITEM_COUNT } from "./fixtures";
import { SectionLabel, ToolPill, WorkspaceTabs } from "./shared";

// ── the Desk (ui-contract.md §2) ────────────────────────────────────────────

function DeskCard({
  title,
  tag,
  hint,
  unplaced,
  justUpdated,
}: {
  title: string;
  tag?: string;
  hint?: string;
  unplaced?: boolean;
  justUpdated?: boolean;
}) {
  return (
    <div
      className={cn(
        "group/desk rounded-lg border bg-card p-2.5 transition-colors",
        // "A card the conversation just touched is border-highlighted IN PLACE"
        // — spelled the way StatTile spells its own selected state
        // (components/common/list-controls.tsx), so a highlight in the workspace
        // and a highlight on the dashboard are the same visual event.
        justUpdated ? "border-primary ring-1 ring-primary/40" : "border-border",
        unplaced && "border-dashed",
      )}
    >
      <div className="flex items-start gap-2">
        {/* Amber, through the token. The state vocabulary owns every status
            hue now (globals.css, `--warning`), and an unplaced card is a
            QUESTION — the one thing on this rail the master could not resolve.
            Hue on the icon only: the card body stays a neutral outline. */}
        {unplaced && <HelpCircleIcon className="mt-0.5 size-3.5 shrink-0 text-warning" />}
        <p className="min-w-0 flex-1 text-xs font-medium leading-snug">{title}</p>
        <span
          className="hidden size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground/50 transition-colors hover:bg-muted group-hover/desk:flex"
          title="Dismiss — sends it to the queue, never deletes"
        >
          <XIcon className="size-3" />
        </span>
      </div>
      <div className="mt-1.5 flex items-center gap-1.5">
        {tag && (
          <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            {tag}
          </span>
        )}
        <span className="truncate font-mono text-[10px] text-muted-foreground/60">{hint}</span>
      </div>
    </div>
  );
}

// The Desk: the workspace's right rail, same pattern as a session surface's
// sidebar — and here it is literally the shell's `rail` slot, the one
// components/conversation's ConversationProps documents as "one slot, many
// rails". Agent-filed items live here: persistent across the conversation,
// edited in place by talking about them, drained to the queue by dismissing.
function DeskRail() {
  return (
    <aside className="hidden w-72 shrink-0 flex-col border-l border-border bg-muted/10 lg:flex">
      <div className="flex min-h-14 shrink-0 items-center gap-2 border-b border-border px-4">
        <h2 className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
          Desk
        </h2>
        <span className="font-mono text-[10px] tabular-nums text-muted-foreground/60">
          {WS_DESK.length}
        </span>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {WS_DESK.map((d, i) => (
          <DeskCard key={d.id} {...d} justUpdated={i === 1} />
        ))}
      </div>
      <div className="shrink-0 border-t border-border p-3">
        <span className="flex items-center justify-between rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground">
          queue
          <span className="font-mono text-[10px] tabular-nums text-muted-foreground/60">
            {WS_ITEM_COUNT}
          </span>
        </span>
        <p className="mt-1 px-2 text-[10px] leading-relaxed text-muted-foreground/60">
          dismissing a card sends it here — nothing is deleted
        </p>
      </div>
    </aside>
  );
}

// The app nav, as a STATIC PROP — it shows where the Workspace destination sits
// and nothing more. Re-dressed to the live AppSidebar's current roster and
// icons (Overview · Projects · Looms · Workspace, with `ListTodoIcon` on
// Workspace — the mockup used to draw an inbox tray, which is not the icon the
// app ships).
function FauxSidebar() {
  const nav: { label: string; Icon: LucideIcon; active?: boolean }[] = [
    { label: "Overview", Icon: LayoutDashboardIcon },
    { label: "Projects", Icon: FolderGit2Icon },
    { label: "Looms", Icon: ActivityIcon },
    { label: "Workspace", Icon: ListTodoIcon, active: true },
  ];
  return (
    <aside className="hidden w-56 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground md:flex">
      <div className="flex min-h-14 items-center border-b border-sidebar-border px-4">
        <span className="font-heading text-lg font-semibold tracking-tight">telar</span>
      </div>
      <nav className="flex-1 space-y-0.5 overflow-y-auto p-2">
        {nav.map(({ label, Icon, active }) => (
          <div
            key={label}
            className={cn(
              "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
              active
                ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                : "text-sidebar-foreground/70",
            )}
          >
            <Icon className="size-4 shrink-0" />
            <span className="flex-1">{label}</span>
          </div>
        ))}

        <div className="pt-3">
          <p className="px-2 pb-1 text-[10px] font-medium uppercase tracking-wider text-sidebar-foreground/50">
            Pinned
          </p>
          {["aurora", "telar", "thesis"].map((p) => (
            <div
              key={p}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-sidebar-foreground/70"
            >
              <FolderGit2Icon className="size-4 shrink-0 text-sidebar-foreground/50" />
              {p}
            </div>
          ))}
        </div>
      </nav>
      <div className="border-t border-sidebar-border p-2">
        <div className="flex items-center gap-2 rounded-md p-2 text-sm text-sidebar-foreground/60">
          <SettingsIcon className="size-4" /> Settings
        </div>
      </div>
    </aside>
  );
}

// ── the four registered kinds (ui-contract.md §1) ───────────────────────────

// A capture/answer chip. The shared `Chip` from components/common/list-controls
// IS the app's neutral-outline pill — same h-7 box, same `hover:bg-muted/50
// transition-colors`, same register as a lane filter — so the master's chips
// and the queue's chips are one affordance rather than two that rhyme. Inert
// here: a gallery stage answers nothing.
function AnswerChips({ chips }: { chips: readonly string[] }) {
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      {chips.map((c) => (
        <Chip key={c} active={false} onClick={() => {}}>
          {c}
        </Chip>
      ))}
    </div>
  );
}

// The gap and the witness are the SAME card with a different icon and a
// different question — one presenter, two registrations, so their geometry
// cannot drift apart the way two inline copies would.
function QuestionCard({
  icon: Icon,
  warn,
  text,
  chips,
}: {
  icon: LucideIcon;
  // A FLAG, NOT A CLASS STRING. Handing the caller a `tone` prop would move the
  // hue's spelling out to the call site, where the quiet-colour law's "on the
  // icon only" stops being checkable — by eye or by ./idiom.test.ts's scan. The
  // literal stays inside the icon element; the caller only says which question
  // this is.
  warn?: boolean;
  text: ReactNode;
  chips: readonly string[];
}) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2.5">
      <Icon
        className={cn(
          "mt-0.5 size-3.5 shrink-0",
          warn ? "text-warning" : "text-muted-foreground",
        )}
      />
      <div className="min-w-0 text-xs">
        <p className="text-foreground">{text}</p>
        <AnswerChips chips={chips} />
      </div>
    </div>
  );
}

type BriefingPayload = { bands: readonly { label: string; body: string }[] };

// "Briefing renders as labelled bands: While you were away · Where you stopped
// · Today (per-lane counts + suggested first move)."
const briefingKind: ItemKind<BriefingPayload> = {
  id: "workspace:briefing",
  render: (payload) => (
    <div className="space-y-3">
      {payload.bands.map((band) => (
        // No wrapper spacing: SectionLabel carries the app's own `mb-2`.
        <div key={band.label}>
          <SectionLabel>{band.label}</SectionLabel>
          <MessageResponse>{band.body}</MessageResponse>
        </div>
      ))}
    </div>
  ),
};

type QuestionPayload = { text: string; chips: readonly string[] };

// CAP-8. NOTE THE RECORDED DEVIATION, which is the contract's own and not this
// file's: ui-contract.md §1 says the v1 gap is "a commitment MINED FROM A
// CAPTURE ('you said you'd sync Thursday'), not a calendar event — there is no
// external calendar in v1, so the mockup's 'was on your calendar yesterday
// 15:00' phrasing is out of scope. The card's shape stands; its source
// changes." The prototype keeps its own words because it is the record of the
// shape; the story that builds this reads the deviation, not the copy.
const gapKind: ItemKind<QuestionPayload> = {
  id: "workspace:gap",
  render: (payload) => (
    <QuestionCard icon={CalendarIcon} warn text={payload.text} chips={payload.chips} />
  ),
};

// CAP-7 — "a question, never an alarm", which is why the flag stays MUTED
// while the gap's calendar is amber. A slipped self-deadline is a witness; the
// state vocabulary's warning hue here would make it a klaxon, and NFR-OW-11
// bans exactly that.
const witnessKind: ItemKind<QuestionPayload> = {
  id: "workspace:witness",
  render: (payload) => (
    <QuestionCard icon={FlagIcon} text={payload.text} chips={payload.chips} />
  ),
};

type ReceiptPayload = {
  lines: readonly { dest: string; text: string }[];
  // The one the master could not place — quoted VERBATIM, per ui-contract §1.
  question: { lead: string; fragment: string; tail: string };
  tally: string;
};

// CAP-2. One line per filed item — mono destination chip + gist — then the
// unplaceable one as an amber question, then the tally.
const receiptKind: ItemKind<ReceiptPayload> = {
  id: "workspace:receipt",
  render: (payload) => (
    <div className="space-y-3">
      <div className="space-y-1.5">
        {payload.lines.map((line) => (
          <div key={line.dest} className="flex items-start gap-2">
            <CheckIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/60" />
            <span className="shrink-0 rounded-md bg-muted px-1.5 font-mono text-[10px] leading-5 text-muted-foreground">
              {line.dest}
            </span>
            <span className="min-w-0 text-xs text-foreground">{line.text}</span>
          </div>
        ))}
        <div className="flex items-start gap-2">
          <HelpCircleIcon className="mt-0.5 size-3.5 shrink-0 text-warning" />
          <span className="min-w-0 text-xs text-foreground">
            {payload.question.lead}{" "}
            <span className="italic">“{payload.question.fragment}”</span>{" "}
            {payload.question.tail}
          </span>
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground">{payload.tally}</p>
    </div>
  ),
};

// "External reads render as a tool pill (mono, wrench, done-check), same idiom
// as any agent surface" — and that pill is production code now
// (components/workspace/chips.tsx's ToolPill), re-exported through ./shared.
// `max-w-[50rem]` is the `Message` measure, so the pill sits in the same
// reading lane as the bubbles above and below it.
const toolPillKind: ItemKind<{ call: string }> = {
  id: "workspace:tool-pill",
  render: (payload) => (
    <div className="mx-auto flex w-full max-w-[50rem] justify-start">
      <ToolPill call={payload.call} />
    </div>
  ),
};

// The real factory over the real built-ins, plus this surface's four. Built
// once at module scope, exactly as an owner adapter builds its own.
const MASTER_KINDS = createItemKindRegistry([
  ...BUILTIN_KINDS,
  briefingKind,
  gapKind,
  witnessKind,
  receiptKind,
  toolPillKind,
]);

// ── the transcript ──────────────────────────────────────────────────────────

const text = (key: string, body: string): TranscriptItem => ({
  kind: CONVERSATION_KINDS.text,
  key,
  payload: { text: body } satisfies TextPayload,
});

const turn = (
  key: string,
  from: "user" | "assistant",
  items: readonly TranscriptItem[],
): TranscriptItem => ({
  kind: CONVERSATION_KINDS.turn,
  key,
  payload: { from, items } satisfies TurnPayload,
});

const MASTER_TRANSCRIPT: readonly TranscriptItem[] = [
  turn("t1", "user", [text("t1-a", "Where did I stop last night? What’s up for today?")]),
  turn("t2", "assistant", [
    {
      kind: briefingKind.id,
      key: "t2-briefing",
      payload: {
        bands: [
          {
            label: "While you were away",
            body:
              "The `aurora` loom `payments-retry` finished verify — **ready for your accept**, " +
              "evidence attached. I filed 4 captures (2 aurora, 1 school, 1 telar), drafted one " +
              "mockup proposal, and synced 2 mirrored issues. Nothing was started or completed.",
          },
          {
            label: "Where you stopped",
            body:
              "`telar` — mid-spec on the workspace module (last edit 23:48). `aurora` — waiting " +
              "on you: the accept above unblocks their staging deploy.",
          },
          {
            label: "Today",
            body:
              "Aurora 5 · Office 1 · School 3 · Free 2. Suggested first move: the aurora accept " +
              "— about ten minutes, and it’s the only thing anyone else is waiting on.",
          },
        ],
      } satisfies BriefingPayload,
    },
    {
      kind: gapKind.id,
      key: "t2-gap",
      payload: {
        text: "Gap: “Aurora sync” was on your calendar yesterday 15:00 — nothing was captured from it.",
        chips: ["I’ll paste the transcript", "mark no-notes", "let me dump them now"],
      } satisfies QuestionPayload,
    },
    {
      kind: witnessKind.id,
      key: "t2-witness",
      payload: {
        text:
          "Witness: essay draft-2 — you told yourself Friday, and it has slid twice. " +
          "Re-set it or drop it honestly?",
        chips: ["keep Friday", "move to Monday", "drop it"],
      } satisfies QuestionPayload,
    },
  ]),
  turn("t3", "user", [
    text(
      "t3-a",
      "ok dump: aurora wants the csv export gone by friday, maría said invoice by thursday, " +
        "prof moved the lab report to sep 2, idea — telar notes should pin per-screen, and " +
        "something about the pdf thing from the call",
    ),
  ]),
  turn("t4", "assistant", [
    {
      kind: receiptKind.id,
      key: "t4-receipt",
      payload: {
        lines: [
          {
            dest: "aurora #214",
            text: "Remove CSV export button — deadline Fri (external), expert says: session.",
          },
          { dest: "floating", text: "Call María about the invoice — Thu." },
          {
            dest: "thesis",
            text: "Lab report moved to Sep 2 — deadline updated, nothing else changed.",
          },
          { dest: "telar", text: "“Notes pin per-screen” — filed as an idea in Free." },
        ],
        question: {
          lead: "One I can’t place:",
          fragment: "the pdf thing from the call",
          tail: "— aurora’s invoice export, or something new?",
        },
        tally:
          "5 in → 4 filed, 1 question. Nothing invented. They’re on your sidebar — dismiss any to send it to the queue.",
      } satisfies ReceiptPayload,
    },
  ]),
  turn("t5", "user", [
    text("t5-a", "actually maría can wait — make the invoice thing friday too"),
  ]),
  turn("t6", "assistant", [
    text(
      "t6-a",
      "Done — **Call María** moved to Friday. Updated in place; it hasn’t moved from your sidebar.",
    ),
  ]),
  turn("t7", "user", [text("t7-a", "anything waiting on me in linear?")]),
  {
    kind: toolPillKind.id,
    key: "t8",
    payload: { call: "linear.issues · assigned to me" },
  },
  turn("t9", "assistant", [
    text(
      "t9-a",
      "Two: `INV-142` (invoice rounding on receipts, due Monday) and `INV-137` (no due date, " +
        "untouched for three weeks). Neither is tracked here — say the word and either becomes a task.",
    ),
  ]),
];

// ── the composer (ui-contract.md §1) ────────────────────────────────────────
//
// The real `PromptInput` family, the same one the conversation lane's own
// composers use. It "invites all three modes: ask, dump, or paste anything",
// and it carries NO ULTRA CHIP — ultra's mutating tools dereference a project,
// which the master lacks. The footer line is the surface stating its own
// contract, which is where the prototype already put it.
function MasterComposer() {
  return (
    <div className="relative mx-auto w-full max-w-[50rem] px-4 pb-4">
      <PromptInput onSubmit={() => {}}>
        <PromptInputBody>
          <PromptInputTextarea
            className="min-h-10"
            placeholder="Ask, dump everything, or paste anything…"
          />
        </PromptInputBody>
        <PromptInputFooter>
          <span className="text-[10px] text-muted-foreground/60">
            pull-based — this surface never notifies you; it answers when you arrive
          </span>
          <PromptInputSubmit className="ml-auto shrink-0 self-end" />
        </PromptInputFooter>
      </PromptInput>
    </div>
  );
}

export function WorkspaceHomeDemo() {
  return (
    <div className="flex h-full bg-background">
      <FauxSidebar />

      <Conversation
        items={MASTER_TRANSCRIPT}
        kinds={MASTER_KINDS}
        header={
          <PageHeader
            leading={<WorkspaceTabs active="chat" />}
            title="Workspace"
            description="Tuesday · 09:14"
            actions={
              // Bed mode's honesty line, in the app's outline Badge rather than
              // a hand-rolled pill: a run happened, it did seven things, and it
              // STARTED NOTHING (ui-contract invariant 6).
              <Badge
                variant="outline"
                className="gap-1.5 px-2 py-0.5 text-[11px] font-normal text-muted-foreground"
                title="Overnight run: filed, drafted, synced — proposals only"
              >
                <MoonIcon className="size-3" />
                bed mode ran 02:40–03:15 · 7 actions, 0 started
              </Badge>
            }
          />
        }
        composer={<MasterComposer />}
        rail={<DeskRail />}
      />
    </div>
  );
}
