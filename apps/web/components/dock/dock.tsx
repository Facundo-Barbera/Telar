"use client";

// The mini-dock, mounted once in the root layout and portaled to <body> so its
// fixed positioning is viewport-relative regardless of any transformed layout
// ancestor (the HARD-WON overlay rule). Sessions that follow you across routes:
// a row of chat HEADS bottom-right, each expanding into a compact panel — the
// approved grammar in lib/demo-gallery/chat/mini-dock.tsx, here reading live
// Runtime from the dock store (heads/panels are pure readers; the runtime hosts
// own the HTTP/SSE wiring).

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import {
  ArrowUpIcon,
  ClockIcon,
  ExternalLinkIcon,
  FileTextIcon,
  MinusIcon,
  PencilIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { cn } from "@/lib/utils";
import {
  useDock,
  unreadOf,
  type CompactMsg,
  type DockEntry,
  type Runtime,
} from "./dock-provider";
import { SessionRuntimeHost } from "./session-runtime-host";

const TOOL_ICON: Record<string, typeof FileTextIcon> = {
  Read: FileTextIcon,
  Grep: SearchIcon,
  Edit: PencilIcon,
};

// ── compact message body (mirrors the 1.7 drawer ChatSurface) ───────────────
function CompactMessages({ messages }: { messages: CompactMsg[] }) {
  if (messages.length === 0)
    return (
      <p className="px-1 py-6 text-center text-[11px] text-muted-foreground">
        No messages yet.
      </p>
    );
  return (
    <div className="flex flex-col gap-2.5">
      {messages.map((m, i) => {
        if (m.role === "user")
          return (
            <div
              key={i}
              className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-lg bg-secondary px-2.5 py-1.5 text-[11px] text-foreground"
            >
              {m.text}
            </div>
          );
        if (m.role === "tools")
          return (
            <div key={i} className="rounded-md border border-border bg-card/50 p-1">
              {m.steps.map((s, j) => {
                const Icon = TOOL_ICON[s.tool] ?? FileTextIcon;
                return (
                  <div key={j} className="flex items-center gap-1.5 rounded px-1.5 py-1 text-[11px]">
                    <Icon className="size-3 shrink-0 text-muted-foreground" />
                    <span className="shrink-0 font-medium">{s.tool}</span>
                    <span className="min-w-0 truncate font-mono text-[10px] text-muted-foreground">{s.target}</span>
                  </div>
                );
              })}
            </div>
          );
        return (
          <p key={i} className="whitespace-pre-wrap text-[11px] leading-relaxed text-foreground">
            {m.text}
          </p>
        );
      })}
    </div>
  );
}

// ── head tooltip (fixed, collision-aware — escapes any clip) ────────────────
function HeadTooltip({
  entry,
  rt,
  children,
}: {
  entry: DockEntry;
  rt?: Runtime;
  children: React.ReactNode;
}) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }
    const measure = () => {
      const a = anchorRef.current?.getBoundingClientRect();
      const t = tipRef.current?.getBoundingClientRect();
      if (!a || !t) return;
      const M = 8;
      let left = a.left + a.width / 2 - t.width / 2;
      let top = a.top - t.height - 8;
      if (top < M) top = a.bottom + 8;
      left = Math.min(Math.max(left, M), window.innerWidth - t.width - M);
      top = Math.min(Math.max(top, M), window.innerHeight - t.height - M);
      setCoords({ left, top });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open]);

  const stateLabel = rt?.parked
    ? "parked · needs you"
    : rt?.working
      ? "working"
      : "idle";

  return (
    <span
      ref={anchorRef}
      className="inline-flex shrink-0"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      {children}
      {open && (
        <div
          ref={tipRef}
          aria-hidden
          style={{ position: "fixed", left: coords ? coords.left : -9999, top: coords ? coords.top : -9999 }}
          className={cn("pointer-events-none z-[60] transition-opacity duration-100", coords ? "opacity-100" : "opacity-0")}
        >
          <div className="w-max max-w-56 rounded-md border border-border bg-popover px-2.5 py-1.5 text-popover-foreground shadow-md">
            <div className="truncate text-xs font-medium">{rt?.title || entry.title}</div>
            <div className="mt-0.5 flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
              <span className="truncate">{rt?.project || entry.project}</span>
              <span className="opacity-40">·</span>
              <span className={cn(rt?.parked && "text-amber-500")}>{stateLabel}</span>
            </div>
          </div>
        </div>
      )}
    </span>
  );
}

// ── a chat head ─────────────────────────────────────────────────────────────
function Head({ entry }: { entry: DockEntry }) {
  const { runtime, viewed, expanded, toggleExpand, undock } = useDock();
  const rt = runtime[entry.id];
  const active = expanded.includes(entry.id);
  const unread = unreadOf(rt, viewed[entry.id]);
  const spinning = rt?.working ?? false;
  const parked = rt?.parked ?? false;

  return (
    <HeadTooltip entry={entry} rt={rt}>
      <div className="group relative size-11">
        {spinning && (
          <div
            aria-hidden
            className="absolute -inset-[2.5px] animate-spin rounded-full [animation-duration:1.4s]"
            style={{ background: "conic-gradient(from 0deg, transparent 40deg, var(--primary) 300deg, transparent 360deg)" }}
          />
        )}
        <button
          type="button"
          onClick={() => toggleExpand(entry.id)}
          aria-label={`${active ? "Minimize" : "Open"} ${rt?.title || entry.title}`}
          className={cn(
            "absolute inset-0 flex items-center justify-center rounded-full border text-sm font-semibold shadow-md transition-colors",
            parked
              ? "border-amber-500/70 bg-amber-500/10 text-amber-600 dark:text-amber-400"
              : "border-border bg-secondary text-secondary-foreground hover:bg-secondary/70",
            active && "ring-2 ring-ring ring-offset-2 ring-offset-background",
          )}
        >
          {entry.initial}
        </button>

        {unread > 0 && (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground shadow">
            {unread}
          </span>
        )}

        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            undock(entry.id);
          }}
          aria-label={`Undock ${rt?.title || entry.title}`}
          className="absolute -left-1.5 -top-1.5 hidden size-4 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-sm hover:text-foreground group-hover:flex"
        >
          <XIcon className="size-2.5" />
        </button>
      </div>
    </HeadTooltip>
  );
}

function IconBtn({ onClick, label, children }: { onClick: () => void; label: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      {children}
    </button>
  );
}

// ── queue-capable composer ──────────────────────────────────────────────────
// The send path lives in the runtime host (POST /api/chat), so a queued message
// survives minimizing the panel. The composer just enqueues into the store; the
// host drains one head at a time the moment the session goes idle (1.5 grammar).
function DockComposer({ id, rt }: { id: string; rt?: Runtime }) {
  const { enqueue } = useDock();
  const [text, setText] = useState("");
  const working = rt?.working ?? false;
  const queued = rt?.queued ?? [];

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const v = text.trim();
    if (!v) return;
    setText("");
    enqueue(id, v); // idle → host drains at once; working → waits in the queue
  };

  return (
    <div className="shrink-0 border-t border-border p-2">
      {queued.length > 0 && (
        <div className="mb-1.5 flex flex-col gap-1">
          {queued.map((q, i) => (
            <div key={i} className="flex items-center gap-1.5 rounded-lg border border-primary/30 bg-primary/5 px-2 py-1 text-[11px]">
              <ClockIcon className="size-3 shrink-0 text-primary" />
              <span className="min-w-0 flex-1 truncate">{q}</span>
              <span className="shrink-0 text-[9px] uppercase tracking-wide text-muted-foreground">queued</span>
            </div>
          ))}
        </div>
      )}
      <form onSubmit={submit} className="flex items-center gap-2 rounded-xl border border-border bg-card px-2 py-1.5">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={working ? "Queue a message while it works…" : "Reply…"}
          className="min-w-0 flex-1 bg-transparent text-[11px] text-foreground outline-none placeholder:text-muted-foreground/60"
        />
        <button type="submit" className="flex size-6 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground" aria-label="Send">
          <ArrowUpIcon className="size-3.5" />
        </button>
      </form>
    </div>
  );
}

// ── an expanded docked panel (compact ChatSurface grammar) ──────────────────
function DockPanel({ entry }: { entry: DockEntry }) {
  const { runtime, minimize, undock, markViewed } = useDock();
  const router = useRouter();
  const rt = runtime[entry.id];
  const scrollRef = useRef<HTMLDivElement>(null);
  const count = rt?.messages.length ?? 0;

  // Keep the newest message in view; a growing tail on an OPEN panel is read, so
  // clear its unread.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    markViewed(entry.id);
  }, [count, entry.id, markViewed]);

  return (
    <div className="flex h-[480px] w-[340px] flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-2xl">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {rt?.working && <span className="size-1.5 shrink-0 rounded-full bg-primary" />}
            <span className="truncate text-xs font-semibold">{rt?.title || entry.title}</span>
          </div>
          <div className="truncate font-mono text-[10px] text-muted-foreground">{rt?.project || entry.project}</div>
        </div>
        {rt?.working && (
          <Shimmer as="span" className="shrink-0 text-[10px] font-medium">
            working
          </Shimmer>
        )}
        <IconBtn
          onClick={() =>
            router.push(
              `/projects/${encodeURIComponent(rt?.project || entry.project)}/sessions/${encodeURIComponent(entry.id)}`,
            )
          }
          label="Open full session"
        >
          <ExternalLinkIcon className="size-3.5" />
        </IconBtn>
        <IconBtn onClick={() => minimize(entry.id)} label="Minimize to head">
          <MinusIcon className="size-3.5" />
        </IconBtn>
        <IconBtn onClick={() => undock(entry.id)} label="Close">
          <XIcon className="size-3.5" />
        </IconBtn>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <CompactMessages messages={rt?.messages ?? []} />
      </div>

      <DockComposer id={entry.id} rt={rt} />
    </div>
  );
}

export function Dock() {
  const { entries, expanded } = useDock();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted || entries.length === 0) return null;

  // Panels in expand order (oldest→newest, left→right); heads reversed so the
  // newest sits on the right (spec).
  const expandedEntries = expanded
    .map((id) => entries.find((e) => e.id === id))
    .filter((e): e is DockEntry => Boolean(e));

  return createPortal(
    <>
      {/* invisible effect hosts — one per docked session */}
      {entries.map((e) => (
        <SessionRuntimeHost key={e.id} id={e.id} />
      ))}

      <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col items-end gap-3">
        {expandedEntries.length > 0 && (
          <div className="pointer-events-auto flex items-end gap-3">
            {expandedEntries.map((e) => (
              <DockPanel key={e.id} entry={e} />
            ))}
          </div>
        )}
        <div className="pointer-events-auto flex flex-row-reverse items-center gap-2.5">
          {entries.map((e) => (
            <Head key={e.id} entry={e} />
          ))}
        </div>
      </div>
    </>,
    document.body,
  );
}
