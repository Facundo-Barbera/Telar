"use client";

// 1.7 — One adaptable ChatSurface, three contexts.
// CURRENT: the chat surface (session-view.tsx) is copy-pasted uniformly — a
// project session, a loom thread, and a drawer all render the SAME full chrome,
// so a back-to-project button shows up inside a loom where it makes no sense.
// REDESIGN: a single ChatSurface takes a `context`; the conversation body is
// identical everywhere, only the CHROME (header, back affordance, meta density,
// composer) adapts. All three shown side by side over one fixture conversation.

import { useState } from "react";
import {
  ArrowLeftIcon,
  ArrowUpIcon,
  BotIcon,
  ChevronRightIcon,
  PencilIcon,
  SearchIcon,
  FileTextIcon,
  WorkflowIcon,
  XIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { DemoShell, Section } from "./_shared";

type Ctx = "standalone" | "loom" | "drawer";

// ── shared conversation fixture ────────────────────────────────────────────
type Msg =
  | { role: "user"; text: string }
  | { role: "thought"; text: string }
  | { role: "tools"; steps: { tool: string; target: string }[] }
  | { role: "assistant"; text: string };

const CONVO: Msg[] = [
  { role: "user", text: "The cost total in the header is wrong — sub-agent spend isn't counted. Fix it?" },
  {
    role: "thought",
    text: "Cost is summed only over the main agent's usage events. I'll bucket the transcript by parent_tool_use_id and fold every bucket's usage into the total before formatting.",
  },
  {
    role: "tools",
    steps: [
      { tool: "Read", target: "components/session/session-view.tsx" },
      { tool: "Grep", target: "sessionCost" },
      { tool: "Edit", target: "fold sub-agent usage into total" },
    ],
  },
  {
    role: "assistant",
    text: "Fixed. The total now folds every sub-agent bucket's usage before formatting, and I added a test covering a two-subagent transcript.",
  },
];

const TOOL_ICON: Record<string, typeof FileTextIcon> = {
  Read: FileTextIcon,
  Grep: SearchIcon,
  Edit: PencilIcon,
};

function ThoughtMini({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded-md px-1 py-0.5 text-xs text-muted-foreground hover:bg-muted/60"
      >
        <span aria-hidden>✻</span>
        <span className="italic">Thought</span>
        <ChevronRightIcon className={cn("size-3 transition-transform", open && "rotate-90")} />
      </button>
      {open && (
        <p className="mt-1 rounded-md bg-muted/10 p-2 text-[11px] italic leading-relaxed text-muted-foreground">
          {text}
        </p>
      )}
    </div>
  );
}

function ToolsMini({ steps }: { steps: { tool: string; target: string }[] }) {
  return (
    <div className="rounded-md border border-border bg-card/50 p-1">
      {steps.map((s, i) => {
        const Icon = TOOL_ICON[s.tool] ?? FileTextIcon;
        return (
          <div key={i} className="flex items-center gap-1.5 rounded px-1.5 py-1 text-xs">
            <Icon className="size-3 shrink-0 text-muted-foreground" />
            <span className="shrink-0 font-medium">{s.tool}</span>
            <span className="min-w-0 truncate font-mono text-[10px] text-muted-foreground">{s.target}</span>
          </div>
        );
      })}
    </div>
  );
}

function MessageList({ dense }: { dense: boolean }) {
  return (
    <div className={cn("flex flex-col", dense ? "gap-2.5" : "gap-3.5")}>
      {CONVO.map((m, i) => {
        if (m.role === "user")
          return (
            <div key={i} className="ml-auto max-w-[85%] rounded-lg bg-secondary px-3 py-2 text-xs text-foreground">
              {m.text}
            </div>
          );
        if (m.role === "thought") return <ThoughtMini key={i} text={m.text} />;
        if (m.role === "tools") return <ToolsMini key={i} steps={m.steps} />;
        return (
          <p key={i} className="text-xs leading-relaxed text-foreground">
            {m.text}
          </p>
        );
      })}
    </div>
  );
}

// ── the adaptable surface ──────────────────────────────────────────────────
function SurfaceHeader({ context }: { context: Ctx }) {
  if (context === "standalone") {
    return (
      <div className="shrink-0 border-b border-border">
        <div className="flex items-center gap-2 px-3 py-2">
          <button
            type="button"
            aria-label="Back to project"
            className="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <ArrowLeftIcon className="size-4" />
          </button>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">Fix header cost total</div>
            <div className="truncate font-mono text-[10px] text-muted-foreground">telar / core</div>
          </div>
        </div>
        <div className="flex items-center gap-2 border-t border-border px-3 py-1.5">
          <Badge variant="outline" className="gap-1 font-mono text-[10px]">
            anthropic · sonnet
          </Badge>
          <Badge variant="secondary" className="font-mono text-[10px]">
            a1b2c3d4
          </Badge>
          <div className="ml-auto flex items-center gap-1.5">
            <Badge variant="outline" className="font-mono text-[10px]">
              CTX 58.2k
            </Badge>
            <Badge variant="outline" className="font-mono text-[10px]">
              $0.5360
            </Badge>
          </div>
        </div>
      </div>
    );
  }

  if (context === "loom") {
    // no back button — you're inside a loom; instead a breadcrumb into the weave
    return (
      <div className="shrink-0 border-b border-border">
        <div className="flex items-center gap-1.5 px-3 py-2 text-[10px] text-muted-foreground">
          <WorkflowIcon className="size-3 text-primary" />
          <span>cost-accuracy loom</span>
          <ChevronRightIcon className="size-3 opacity-50" />
          <span className="font-medium text-foreground">thread: header-cost</span>
          <Badge variant="outline" className="ml-auto gap-1 border-primary/30 bg-primary/5 px-1.5 py-0 font-mono text-[9px] text-primary">
            <BotIcon className="size-2.5" />
            weaving
          </Badge>
        </div>
        <div className="flex items-center gap-2 border-t border-border px-3 py-1 font-mono text-[10px] text-muted-foreground">
          <span>step 4/6</span>
          <span className="opacity-40">·</span>
          <span>$0.5360</span>
          <span className="ml-auto opacity-70">verify pending</span>
        </div>
      </div>
    );
  }

  // drawer — tightest chrome, a close affordance, minimal meta
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border px-2.5 py-1.5">
      <span className="truncate text-xs font-medium">Fix header cost total</span>
      <span className="font-mono text-[10px] text-muted-foreground/70">$0.54</span>
      <button
        type="button"
        aria-label="Close drawer"
        className="ml-auto flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <XIcon className="size-3.5" />
      </button>
    </div>
  );
}

function Composer({ context }: { context: Ctx }) {
  const compact = context === "drawer";
  return (
    <div className="shrink-0 border-t border-border p-2">
      <div
        className={cn(
          "flex items-end gap-2 rounded-xl border border-border bg-card",
          compact ? "px-2 py-1.5" : "px-3 py-2",
        )}
      >
        <span className={cn("flex-1 text-muted-foreground/60", compact ? "text-[11px]" : "text-xs")}>
          {context === "loom" ? "Steer this thread…" : "Reply…"}
        </span>
        <button
          type="button"
          className={cn(
            "flex shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground",
            compact ? "size-6" : "size-7",
          )}
        >
          <ArrowUpIcon className={compact ? "size-3.5" : "size-4"} />
        </button>
      </div>
    </div>
  );
}

function ChatSurface({ context, label }: { context: Ctx; label: string }) {
  return (
    <div className="flex flex-col">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">{label}</span>
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-[9px] text-muted-foreground">
          context=&quot;{context}&quot;
        </code>
      </div>
      <div className="flex h-[26rem] flex-col overflow-hidden rounded-xl border border-border bg-background">
        <SurfaceHeader context={context} />
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          <MessageList dense={context === "drawer"} />
        </div>
        <Composer context={context} />
      </div>
    </div>
  );
}

export function ChatSurfaceVariantsDemo() {
  return (
    <DemoShell className="max-w-none">
      <Section
        title="One surface, three contexts"
        note="Same conversation body in all three — only the chrome adapts. Standalone keeps the back button + full heartbeat; loom-embedded drops the back button for a weave breadcrumb; drawer is the tightest, with a close affordance."
      >
        <div className="grid gap-4 lg:grid-cols-3">
          <ChatSurface context="standalone" label="Standalone" />
          <ChatSurface context="loom" label="Loom-embedded" />
          <ChatSurface context="drawer" label="Compact drawer" />
        </div>
      </Section>
    </DemoShell>
  );
}
