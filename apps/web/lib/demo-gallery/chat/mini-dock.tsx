"use client";

// EXTRA — Mini-chat dock: sessions that follow you.
// IDEA: you're deep in one session but want to peek at another. Instead of
// leaving the page, a Messenger-style dock lives in the bottom-right corner and
// FOLLOWS YOU across every route: a row of chat HEADS (one per live session)
// that expand into small docked panels. The panel is the APPROVED 1.7 ChatSurface
// in its COMPACT (drawer) grammar — minimal chrome, the same message body, a
// queue-capable composer (1.5). Nothing here reflows the page: the dock is an
// out-of-flow overlay, so opening a panel never nudges the route underneath.
//
// This mockup renders a fake app (nav + decorative backdrop) so the dock reads
// IN SITU; the nav links swap the backdrop to prove the dock persists across
// pages. A scripted, replayable timeline drives the heads through their states
// (unread, working, parked) and demonstrates a queued message dispatching.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  ArrowUpIcon,
  ChevronRightIcon,
  ClockIcon,
  ExternalLinkIcon,
  FileTextIcon,
  LayersIcon,
  MinusIcon,
  PencilIcon,
  RotateCcwIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
// Lane-local, mask-based shimmer (the production one washes out on light).
import { Shimmer } from "./shimmer";
import { Caption, DemoShell, LIGHT_VARS, Section } from "./_shared";

// SSR-safe layout effect — the fixed-position tooltip only measures client-side.
const useIsoLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

// ── conversation grammar (mirrors the 1.7 compact ChatSurface body) ─────────
type Msg =
  | { role: "user"; text: string }
  | { role: "thought"; text: string }
  | { role: "tools"; steps: { tool: string; target: string }[] }
  | { role: "assistant"; text: string };

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
        className="flex items-center gap-1.5 rounded-md px-1 py-0.5 text-[11px] text-muted-foreground hover:bg-muted/60"
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
          <div key={i} className="flex items-center gap-1.5 rounded px-1.5 py-1 text-[11px]">
            <Icon className="size-3 shrink-0 text-muted-foreground" />
            <span className="shrink-0 font-medium">{s.tool}</span>
            <span className="min-w-0 truncate font-mono text-[10px] text-muted-foreground">{s.target}</span>
          </div>
        );
      })}
    </div>
  );
}

function CompactMessages({ messages }: { messages: Msg[] }) {
  return (
    <div className="flex flex-col gap-2.5">
      {messages.map((m, i) => {
        if (m.role === "user")
          return (
            <div
              key={i}
              className="ml-auto max-w-[85%] rounded-lg bg-secondary px-2.5 py-1.5 text-[11px] text-foreground"
            >
              {m.text}
            </div>
          );
        if (m.role === "thought") return <ThoughtMini key={i} text={m.text} />;
        if (m.role === "tools") return <ToolsMini key={i} steps={m.steps} />;
        return (
          <p key={i} className="text-[11px] leading-relaxed text-foreground">
            {m.text}
          </p>
        );
      })}
    </div>
  );
}

// ── session model ───────────────────────────────────────────────────────────
type SState = "idle" | "working" | "parked";

interface Session {
  id: string;
  initial: string;
  title: string;
  project: string;
  state: SState;
  unread: number;
  flash: boolean; // brief attention beat right after a reply lands
  messages: Msg[];
  queued: string[]; // 1.5 — messages typed while the agent was working
}

const initialSessions = (): Session[] => [
  {
    id: "a",
    initial: "H",
    title: "Fix header cost total",
    project: "telar / core",
    state: "idle",
    unread: 0,
    flash: false,
    queued: [],
    messages: [
      { role: "user", text: "The cost total in the header is wrong — sub-agent spend isn't counted. Fix it?" },
      {
        role: "thought",
        text: "Cost sums only the main agent's usage. I'll bucket the transcript by parent_tool_use_id and fold every bucket in before formatting.",
      },
      {
        role: "tools",
        steps: [
          { tool: "Read", target: "session-view.tsx" },
          { tool: "Grep", target: "sessionCost" },
        ],
      },
    ],
  },
  {
    id: "b",
    initial: "P",
    title: "Port tests to vitest",
    project: "telar / web",
    state: "idle",
    unread: 0,
    flash: false,
    queued: ["also run the web suite after"],
    messages: [
      { role: "user", text: "Port the core test suite from bun:test to vitest." },
      { role: "assistant", text: "On it — starting with the executor suite, then the reducers." },
    ],
  },
  {
    id: "c",
    initial: "M",
    title: "Draft migration plan",
    project: "ozom / api",
    state: "parked",
    unread: 1,
    flash: false,
    queued: [],
    messages: [
      { role: "user", text: "Draft the pg → sqlite migration plan." },
      { role: "assistant", text: "I need a decision before continuing: keep the JSONB columns as TEXT+json1, or normalise them out?" },
    ],
  },
];

type Action =
  | { type: "reset" }
  | { type: "reply"; id: string; msg: Msg; markUnread?: boolean }
  | { type: "clearUnread"; id: string }
  | { type: "unflash"; id: string }
  | { type: "setState"; id: string; state: SState }
  | { type: "enqueue"; id: string; text: string }
  | { type: "dispatchQueue"; id: string }
  | { type: "dismiss"; id: string };

function reducer(state: Session[], action: Action): Session[] {
  if (action.type === "reset") return initialSessions();
  if (action.type === "dismiss") return state.filter((s) => s.id !== action.id);
  return state.map((s) => {
    if (s.id !== action.id) return s;
    switch (action.type) {
      case "reply":
        return {
          ...s,
          messages: [...s.messages, action.msg],
          unread: action.markUnread ? s.unread + 1 : s.unread,
          flash: action.markUnread ? true : s.flash,
        };
      case "clearUnread":
        return { ...s, unread: 0, flash: false };
      case "unflash":
        return { ...s, flash: false };
      case "setState":
        return { ...s, state: action.state };
      case "enqueue":
        return { ...s, queued: [...s.queued, action.text] };
      case "dispatchQueue": {
        if (s.queued.length === 0) return s;
        const [first, ...rest] = s.queued;
        return { ...s, queued: rest, messages: [...s.messages, { role: "user", text: first }] };
      }
      default:
        return s;
    }
  });
}

// ── head tooltip (fixed-position, collision-aware — escapes the stage clip) ──
function HeadTooltip({ session, children }: { session: Session; children: React.ReactNode }) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ left: number; top: number } | null>(null);

  useIsoLayoutEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }
    const measure = () => {
      const anchor = anchorRef.current;
      const tip = tipRef.current;
      if (!anchor || !tip) return;
      const a = anchor.getBoundingClientRect();
      const t = tip.getBoundingClientRect();
      const GAP = 8;
      const M = 8;
      let left = a.left + a.width / 2 - t.width / 2;
      let top = a.top - t.height - GAP;
      if (top < M) top = a.bottom + GAP; // flip below if it would hit the top
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

  const stateLabel =
    session.state === "working" ? "working" : session.state === "parked" ? "parked · needs you" : "idle";

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
          className={cn(
            "pointer-events-none z-50 transition-opacity duration-100",
            coords ? "opacity-100" : "opacity-0",
          )}
        >
          <div className="w-max max-w-56 rounded-md border border-border bg-popover px-2.5 py-1.5 text-popover-foreground shadow-md">
            <div className="truncate text-xs font-medium">{session.title}</div>
            <div className="mt-0.5 flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
              <span className="truncate">{session.project}</span>
              <span className="opacity-40">·</span>
              <span className={cn(session.state === "parked" && "text-amber-500")}>{stateLabel}</span>
            </div>
          </div>
        </div>
      )}
    </span>
  );
}

// ── a chat head ─────────────────────────────────────────────────────────────
function Head({
  session,
  active,
  onOpen,
  onDismiss,
}: {
  session: Session;
  active: boolean;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  // A rotating conic gradient = a light sweeping around the rim (shimmer ring),
  // shown while the agent runs or briefly when a reply just landed. Rotation is
  // a transform on THIS ring only — never an ancestor of the fixed tooltip.
  const spinning = session.state === "working" || session.flash;
  const parked = session.state === "parked";

  return (
    <HeadTooltip session={session}>
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
          onClick={onOpen}
          aria-label={`Open ${session.title}`}
          className={cn(
            "absolute inset-0 flex items-center justify-center rounded-full border text-sm font-semibold shadow-md transition-colors",
            parked
              ? "border-amber-500/70 bg-amber-500/10 text-amber-600 dark:text-amber-400"
              : "border-border bg-secondary text-secondary-foreground hover:bg-secondary/70",
            active && "ring-2 ring-ring ring-offset-2 ring-offset-background",
          )}
        >
          {session.initial}
        </button>

        {session.unread > 0 && (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground shadow">
            {session.unread}
          </span>
        )}

        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDismiss();
          }}
          aria-label={`Dismiss ${session.title}`}
          className="absolute -left-1.5 -top-1.5 hidden size-4 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-sm hover:text-foreground group-hover:flex"
        >
          <XIcon className="size-2.5" />
        </button>
      </div>
    </HeadTooltip>
  );
}

// ── an expanded docked panel (compact ChatSurface grammar) ──────────────────
function IconBtn({
  onClick,
  label,
  children,
}: {
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
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

function DockComposer({ session, onSubmit }: { session: Session; onSubmit: (id: string, text: string) => void }) {
  const [text, setText] = useState("");
  const working = session.state === "working";
  return (
    <div className="shrink-0 border-t border-border p-2">
      {session.queued.length > 0 && (
        <div className="mb-1.5 flex flex-col gap-1">
          {session.queued.map((q, i) => (
            <div
              key={i}
              className="flex items-center gap-1.5 rounded-lg border border-primary/30 bg-primary/5 px-2 py-1 text-[11px]"
            >
              <ClockIcon className="size-3 shrink-0 text-primary" />
              <span className="min-w-0 flex-1 truncate">{q}</span>
              <span className="shrink-0 text-[9px] uppercase tracking-wide text-muted-foreground">queued</span>
            </div>
          ))}
        </div>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const v = text.trim();
          if (!v) return;
          onSubmit(session.id, v);
          setText("");
        }}
        className="flex items-center gap-2 rounded-xl border border-border bg-card px-2 py-1.5"
      >
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={working ? "Queue a message while it works…" : "Reply…"}
          className="min-w-0 flex-1 bg-transparent text-[11px] text-foreground outline-none placeholder:text-muted-foreground/60"
        />
        <button
          type="submit"
          className="flex size-6 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground"
          aria-label="Send"
        >
          <ArrowUpIcon className="size-3.5" />
        </button>
      </form>
    </div>
  );
}

function DockPanel({
  session,
  onMinimize,
  onClose,
  onSubmit,
}: {
  session: Session;
  onMinimize: () => void;
  onClose: () => void;
  onSubmit: (id: string, text: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Keep the newest message in view as the scripted convo grows.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [session.messages.length]);

  return (
    <div className="flex h-[480px] w-[340px] flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-2xl">
      {/* minimal chrome header */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {session.state === "working" && <span className="size-1.5 shrink-0 rounded-full bg-primary" />}
            <span className="truncate text-xs font-semibold">{session.title}</span>
          </div>
          <div className="truncate font-mono text-[10px] text-muted-foreground">{session.project}</div>
        </div>
        {session.state === "working" && (
          <Shimmer as="span" className="shrink-0 text-[10px] font-medium">
            working
          </Shimmer>
        )}
        <IconBtn onClick={() => {}} label="Open full session">
          <ExternalLinkIcon className="size-3.5" />
        </IconBtn>
        <IconBtn onClick={onMinimize} label="Minimize to head">
          <MinusIcon className="size-3.5" />
        </IconBtn>
        <IconBtn onClick={onClose} label="Close">
          <XIcon className="size-3.5" />
        </IconBtn>
      </div>

      {/* message scroll */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <CompactMessages messages={session.messages} />
      </div>

      {/* queue-capable composer */}
      <DockComposer session={session} onSubmit={onSubmit} />
    </div>
  );
}

// ── decorative fake-app backdrop (purely to place the dock in situ) ─────────
type Page = "looms" | "sessions" | "projects" | "settings";
const NAV: { key: Page; label: string }[] = [
  { key: "looms", label: "Looms" },
  { key: "sessions", label: "Sessions" },
  { key: "projects", label: "Projects" },
  { key: "settings", label: "Settings" },
];

function Bar({ w, dim = false }: { w: string; dim?: boolean }) {
  return <div className={cn("h-2.5 rounded-full", dim ? "bg-muted/40" : "bg-muted")} style={{ width: w }} />;
}

function Backdrop({ page }: { page: Page }) {
  // All decorative, non-interactive, dimmed — it exists only to read as "an app
  // page underneath the dock" and to visibly change when you switch routes.
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 select-none overflow-hidden p-6 opacity-45">
      <div className="mb-5 flex items-center justify-between">
        <div className="h-4 w-40 rounded bg-muted" />
        <div className="h-7 w-24 rounded-lg bg-muted/60" />
      </div>
      {page === "looms" && (
        <div className="grid grid-cols-2 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="rounded-xl border border-border bg-card/40 p-4">
              <div className="mb-3 flex items-center gap-2">
                <div className="size-6 rounded-full bg-muted" />
                <Bar w="55%" />
              </div>
              <div className="flex items-center gap-2">
                <div className="size-2 rounded-full bg-muted" />
                <div className="h-px flex-1 bg-border" />
                <div className="size-2 rounded-full bg-muted" />
                <div className="h-px flex-1 bg-border" />
                <div className="size-2 rounded-full bg-muted" />
              </div>
              <div className="mt-3 space-y-2">
                <Bar w="80%" dim />
                <Bar w="65%" dim />
              </div>
            </div>
          ))}
        </div>
      )}
      {page === "sessions" && (
        <div className="space-y-2.5">
          {Array.from({ length: 7 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 rounded-lg border border-border bg-card/40 px-4 py-3">
              <div className="size-8 rounded-full bg-muted" />
              <div className="flex-1 space-y-1.5">
                <Bar w={`${45 + ((i * 7) % 35)}%`} />
                <Bar w="30%" dim />
              </div>
              <div className="h-6 w-16 rounded-md bg-muted/50" />
            </div>
          ))}
        </div>
      )}
      {page === "projects" && (
        <div className="grid grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="rounded-xl border border-border bg-card/40 p-4">
              <div className="mb-3 size-9 rounded-lg bg-muted" />
              <Bar w="70%" />
              <div className="mt-2 space-y-1.5">
                <Bar w="90%" dim />
                <Bar w="55%" dim />
              </div>
            </div>
          ))}
        </div>
      )}
      {page === "settings" && (
        <div className="max-w-xl space-y-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center justify-between rounded-lg border border-border bg-card/40 px-4 py-3">
              <div className="space-y-1.5">
                <Bar w="140px" />
                <Bar w="220px" dim />
              </div>
              <div className="h-6 w-11 rounded-full bg-muted/60" />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function FakeNav({ page, onNavigate }: { page: Page; onNavigate: (p: Page) => void }) {
  return (
    <div className="z-30 flex shrink-0 items-center gap-1 border-b border-border bg-background/80 px-4 py-2 backdrop-blur">
      <div className="mr-3 flex items-center gap-1.5 font-mono text-sm font-semibold">
        <LayersIcon className="size-4 text-primary" />
        telar
      </div>
      {NAV.map((n) => (
        <button
          key={n.key}
          type="button"
          onClick={() => onNavigate(n.key)}
          className={cn(
            "rounded-md px-2.5 py-1 text-xs transition-colors",
            page === n.key ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted/60",
          )}
        >
          {n.label}
        </button>
      ))}
      <div className="ml-auto size-6 rounded-full bg-muted" />
    </div>
  );
}

// ── the whole stage: fake app + the dock + a scripted, replayable timeline ──
const MAX_PANELS = 2;

function DockStage() {
  const [sessions, dispatch] = useReducer(reducer, undefined, initialSessions);
  const [open, setOpen] = useState<string[]>([]); // panel ids, left→right, oldest first
  const [page, setPage] = useState<Page>("looms");
  const [runId, setRunId] = useState(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const openPanel = useCallback((id: string) => {
    dispatch({ type: "clearUnread", id });
    setOpen((prev) => {
      if (prev.includes(id)) return prev;
      const next = [...prev, id];
      return next.slice(-MAX_PANELS); // a third opens by collapsing the oldest
    });
  }, []);

  const onSubmit = useCallback(
    (id: string, text: string) => {
      const s = sessions.find((x) => x.id === id);
      if (!s) return;
      // 1.5 — typing while the agent works queues a chip; otherwise it just sends.
      if (s.state === "working") dispatch({ type: "enqueue", id, text });
      else dispatch({ type: "reply", id, msg: { role: "user", text } });
    },
    [sessions],
  );

  // Scripted life — a fresh timeline each Replay. Every step is a scheduled
  // dispatch; all handles are cleared on replay/unmount so nothing leaks.
  useEffect(() => {
    dispatch({ type: "reset" });
    setOpen([]);
    const at = (ms: number, fn: () => void) => timers.current.push(setTimeout(fn, ms));

    // A background session receives an agent reply → head shimmer-beats + unread.
    at(900, () =>
      dispatch({
        type: "reply",
        id: "a",
        markUnread: true,
        msg: { role: "assistant", text: "Fixed — the total now folds every sub-agent bucket before formatting, plus a test over a two-subagent transcript." },
      }),
    );
    at(2400, () => dispatch({ type: "unflash", id: "a" }));
    // User expands it → badge clears, sees the compact convo.
    at(3200, () => openPanel("a"));
    // The other session starts working → shimmer ring on its head.
    at(4800, () => dispatch({ type: "setState", id: "b", state: "working" }));
    at(6100, () => openPanel("b"));
    // Its queued message dispatches into the transcript.
    at(7500, () => dispatch({ type: "dispatchQueue", id: "b" }));
    at(9000, () => {
      dispatch({ type: "setState", id: "b", state: "idle" });
      dispatch({
        type: "reply",
        id: "b",
        msg: { role: "assistant", text: "Picked up the queued task — web suite ported and green." },
      });
    });

    const handles = timers.current;
    return () => {
      handles.forEach(clearTimeout);
      timers.current = [];
    };
  }, [runId, openPanel]);

  const openSessions = open.map((id) => sessions.find((s) => s.id === id)).filter((s): s is Session => Boolean(s));

  return (
    <div className="relative flex h-[44rem] flex-col overflow-hidden rounded-xl border border-border bg-background">
      <FakeNav page={page} onNavigate={setPage} />

      <div className="relative min-h-0 flex-1 overflow-hidden">
        <Backdrop page={page} />

        {/* replay control */}
        <button
          type="button"
          onClick={() => setRunId((v) => v + 1)}
          className="absolute left-4 top-4 z-30 flex items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs font-medium text-foreground shadow-sm hover:bg-muted"
        >
          <RotateCcwIcon className="size-3.5" />
          Replay
        </button>

        {/* THE DOCK — out of flow, so opening a panel never reflows the page */}
        <div className="absolute bottom-4 right-4 z-30 flex flex-col items-end gap-3">
          {openSessions.length > 0 && (
            <div className="flex items-end gap-3">
              {openSessions.map((s) => (
                <DockPanel
                  key={s.id}
                  session={s}
                  onMinimize={() => setOpen((p) => p.filter((x) => x !== s.id))}
                  onClose={() => {
                    setOpen((p) => p.filter((x) => x !== s.id));
                    dispatch({ type: "dismiss", id: s.id });
                  }}
                  onSubmit={onSubmit}
                />
              ))}
            </div>
          )}

          {/* heads: a row stacked right-to-left (newest on the right) */}
          <div className="flex flex-row-reverse items-center gap-2.5">
            {sessions.map((s) => (
              <Head
                key={s.id}
                session={s}
                active={open.includes(s.id)}
                onOpen={() => openPanel(s.id)}
                onDismiss={() => {
                  setOpen((p) => p.filter((x) => x !== s.id));
                  dispatch({ type: "dismiss", id: s.id });
                }}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function ChatMiniDockDemo() {
  return (
    <DemoShell className="max-w-none">
      <Section
        title="Mini-chat dock — sessions that follow you"
        note="Switch routes with the fake nav: the backdrop changes, the dock stays. Watch Replay: a head shimmer-beats + shows unread on a reply, expands to the compact 1.7 surface, another head starts its working ring, and a queued message dispatches into the transcript. Panels are out-of-flow — nothing reflows the page."
      >
        <div className="space-y-4">
          <div>
            <Caption>Dark</Caption>
            <DockStage />
          </div>
          <div>
            <Caption>Light</Caption>
            <div style={LIGHT_VARS}>
              <DockStage />
            </div>
          </div>
        </div>
      </Section>
    </DemoShell>
  );
}
