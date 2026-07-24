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
import {
  ActivityIcon,
  ArrowUpIcon,
  CalendarIcon,
  CheckIcon,
  FlagIcon,
  FolderGit2Icon,
  HelpCircleIcon,
  InboxIcon,
  LayoutDashboardIcon,
  MoonIcon,
  SettingsIcon,
  SparklesIcon,
  XIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { WS_DESK, WS_ITEM_COUNT } from "./fixtures";
import { ToolPill, WorkspaceTabs } from "./shared";

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
        "group/desk rounded-lg border bg-card p-2.5",
        justUpdated ? "border-primary/40" : "border-border",
        unplaced && "border-dashed",
      )}
    >
      <div className="flex items-start gap-2">
        {unplaced && <HelpCircleIcon className="mt-0.5 size-3.5 shrink-0 text-amber-500" />}
        <p className="min-w-0 flex-1 text-xs font-medium leading-snug">{title}</p>
        <span
          className="hidden size-4 shrink-0 items-center justify-center rounded text-muted-foreground/50 hover:bg-muted group-hover/desk:flex"
          title="Dismiss — sends it to the queue, never deletes"
        >
          <XIcon className="size-3" />
        </span>
      </div>
      <div className="mt-1.5 flex items-center gap-1.5">
        {tag && (
          <span className="rounded bg-muted px-1 py-0.5 font-mono text-[9px] text-muted-foreground">
            {tag}
          </span>
        )}
        <span className="truncate font-mono text-[9px] text-muted-foreground/60">{hint}</span>
      </div>
    </div>
  );
}

// The Desk: the workspace's right rail, same pattern as a session surface's
// sidebar. Agent-filed items live here — persistent across the conversation,
// edited in place by talking about them, drained to the queue by dismissing.
function DeskRail() {
  return (
    <aside className="hidden w-72 shrink-0 flex-col border-l border-border bg-muted/10 lg:flex">
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Desk
        </h2>
        <span className="font-mono text-[10px] text-muted-foreground/50">{WS_DESK.length}</span>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {WS_DESK.map((d, i) => (
          <DeskCard key={d.id} {...d} justUpdated={i === 1} />
        ))}
      </div>
      <div className="shrink-0 border-t border-border p-3">
        <span className="flex items-center justify-between rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted">
          queue
          <span className="font-mono text-[10px] text-muted-foreground/60">{WS_ITEM_COUNT}</span>
        </span>
        <p className="mt-1 px-2 text-[9px] leading-relaxed text-muted-foreground/50">
          dismissing a card sends it here — nothing is deleted
        </p>
      </div>
    </aside>
  );
}

function FauxSidebar() {
  const nav = [
    { label: "Dashboard", Icon: LayoutDashboardIcon },
    { label: "Workspace", Icon: InboxIcon, active: true },
    { label: "Projects", Icon: FolderGit2Icon },
    { label: "Looms", Icon: ActivityIcon },
  ];
  return (
    <aside className="hidden w-56 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground md:flex">
      <div className="flex h-14 items-center border-b border-sidebar-border px-4">
        <span className="font-heading text-lg font-semibold tracking-tight">telar</span>
      </div>
      <nav className="flex-1 space-y-0.5 overflow-y-auto p-2">
        {nav.map(({ label, Icon, active }) => (
          <div
            key={label}
            className={cn(
              "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm",
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
          <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-sidebar-foreground/40">
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

// The master chat IS a session — user turns wear the production session
// bubble (ai-elements/message idiom), same as every chat in the app.
function You({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] whitespace-pre-line rounded-lg bg-secondary px-4 py-3 text-sm text-foreground">
        {children}
      </div>
    </div>
  );
}

function Master({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="mt-1 flex size-6 shrink-0 items-center justify-center rounded-full border border-border bg-card">
        <SparklesIcon className="size-3.5 text-muted-foreground" />
      </span>
      <div className="min-w-0 flex-1 space-y-3 text-sm leading-relaxed">{children}</div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
      {children}
    </p>
  );
}

function ChipButton({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex cursor-default items-center rounded-full border border-border bg-card px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted/50">
      {children}
    </span>
  );
}

// One line of the dump receipt: filed destination in mono, the gist after it.
function ReceiptLine({ dest, text }: { dest: string; text: string }) {
  return (
    <div className="flex items-start gap-2">
      <CheckIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/60" />
      <span className="shrink-0 rounded bg-muted px-1.5 font-mono text-[10px] leading-5 text-muted-foreground">
        {dest}
      </span>
      <span className="min-w-0 text-xs text-foreground/80">{text}</span>
    </div>
  );
}

export function WorkspaceHomeDemo() {
  return (
    <div className="flex h-full bg-background">
      <FauxSidebar />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-6">
          <h1 className="text-sm font-semibold tracking-tight">Workspace</h1>
          <WorkspaceTabs active="chat" />
          <span className="text-xs text-muted-foreground">Tuesday · 09:14</span>
          <span
            className="ml-auto flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground"
            title="Overnight run: filed, drafted, synced — proposals only"
          >
            <MoonIcon className="size-3" /> bed mode ran 02:40–03:15 · 7 actions, 0 started
          </span>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-2xl space-y-6 px-6 py-8">
            <You>Where did I stop last night? What’s up for today?</You>

            <Master>
              <div className="space-y-1.5">
                <SectionLabel>While you were away</SectionLabel>
                <p>
                  The <span className="font-mono text-xs">aurora</span> loom{" "}
                  <span className="font-mono text-xs">payments-retry</span> finished verify —{" "}
                  <span className="font-medium">ready for your accept</span>, evidence attached.
                  I filed 4 captures (2 aurora, 1 school, 1 telar), drafted one mockup
                  proposal, and synced 2 mirrored issues. Nothing was started or completed.
                </p>
              </div>

              <div className="space-y-1.5">
                <SectionLabel>Where you stopped</SectionLabel>
                <p>
                  <span className="font-mono text-xs">telar</span> — mid-spec on the workspace
                  module (last edit 23:48). <span className="font-mono text-xs">aurora</span> —
                  waiting on you: the accept above unblocks their staging deploy.
                </p>
              </div>

              <div className="space-y-1.5">
                <SectionLabel>Today</SectionLabel>
                <p>
                  Aurora 5 · Office 1 · School 3 · Free 2. Suggested first move: the aurora
                  accept — about ten minutes, and it’s the only thing anyone else is
                  waiting on.
                </p>
              </div>

              <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2.5">
                <CalendarIcon className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
                <div className="min-w-0 text-xs">
                  <p className="text-foreground/90">
                    Gap: “Aurora sync” was on your calendar yesterday 15:00 — nothing was
                    captured from it.
                  </p>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    <ChipButton>I’ll paste the transcript</ChipButton>
                    <ChipButton>mark no-notes</ChipButton>
                    <ChipButton>let me dump them now</ChipButton>
                  </div>
                </div>
              </div>

              <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2.5">
                <FlagIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 text-xs">
                  <p className="text-foreground/90">
                    Witness: essay draft-2 — you told yourself Friday, and it has slid twice.
                    Re-set it or drop it honestly?
                  </p>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    <ChipButton>keep Friday</ChipButton>
                    <ChipButton>move to Monday</ChipButton>
                    <ChipButton>drop it</ChipButton>
                  </div>
                </div>
              </div>
            </Master>

            <You>
              {`ok dump: aurora wants the csv export gone by friday, maría said invoice by
thursday, prof moved the lab report to sep 2, idea — telar notes should pin
per-screen, and something about the pdf thing from the call`}
            </You>

            <Master>
              <div className="space-y-1.5">
                <ReceiptLine dest="aurora #214" text="Remove CSV export button — deadline Fri (external), expert says: session." />
                <ReceiptLine dest="floating" text="Call María about the invoice — Thu." />
                <ReceiptLine dest="thesis" text="Lab report moved to Sep 2 — deadline updated, nothing else changed." />
                <ReceiptLine dest="telar" text="“Notes pin per-screen” — filed as an idea in Free." />
                <div className="flex items-start gap-2">
                  <HelpCircleIcon className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
                  <span className="min-w-0 text-xs text-foreground/80">
                    One I can’t place: <span className="italic">“the pdf thing from the call”</span> —
                    aurora’s invoice export, or something new?
                  </span>
                </div>
              </div>
              <p className="text-[11px] text-muted-foreground">
                5 in → 4 filed, 1 question. Nothing invented. They’re on your sidebar —
                dismiss any to send it to the queue.
              </p>
            </Master>

            <You>actually maría can wait — make the invoice thing friday too</You>

            <Master>
              <p className="text-sm">
                Done — <span className="font-medium">Call María</span> moved to Friday.
                Updated in place; it hasn’t moved from your sidebar.
              </p>
            </Master>

            <You>anything waiting on me in linear?</You>

            <ToolPill call="linear.issues · assigned to me" />

            <Master>
              <p className="text-sm">
                Two: <span className="font-mono text-xs">INV-142</span> (invoice rounding on
                receipts, due Monday) and <span className="font-mono text-xs">INV-137</span>{" "}
                (no due date, untouched for three weeks). Neither is tracked here — say the
                word and either becomes a task.
              </p>
            </Master>
          </div>
        </div>

        <div className="shrink-0 border-t border-border px-6 py-4">
          <div className="mx-auto flex w-full max-w-2xl items-center gap-2 rounded-xl border border-border bg-card px-4 py-2.5">
            <span className="flex-1 text-sm text-muted-foreground/60">
              Ask, dump everything, or paste anything…
            </span>
            <span className="flex size-7 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <ArrowUpIcon className="size-4" />
            </span>
          </div>
          <p className="mx-auto mt-2 w-full max-w-2xl text-center text-[10px] text-muted-foreground/50">
            pull-based — this surface never notifies you; it answers when you arrive
          </p>
        </div>
      </div>

      <DeskRail />
    </div>
  );
}
