"use client";

// Concern 1.5 — Claude-Code-style message queueing. While the agent is working,
// anything you type is QUEUED (not dropped, not force-sent): queued messages
// render as editable / removable chips above the composer and are dispatched in
// order the moment the agent frees up. Fully interactive against a simulated
// working agent.
import { cn } from "@/lib/utils";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Button } from "@/components/ui/button";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUpIcon,
  CheckIcon,
  GripVerticalIcon,
  PencilIcon,
  TerminalIcon,
  XIcon,
} from "lucide-react";

type Msg = { id: string; role: "user" | "assistant"; text: string };
type Queued = { id: string; text: string };

let seq = 0;
const uid = () => `m${++seq}`;

// Canned agent activities + replies so the sim feels alive without a backend.
const ACTIVITIES = [
  "Reading src/executor.ts",
  "Running bash: bun test",
  "Editing dispatcher.ts",
  "Grepping for parkReason",
];
const REPLIES = [
  "Done — the dispatcher now propagates the blocked park as an awaiting-human pause. Tests are green.",
  "Added the guard and a regression test. Want me to wire it into the fan-out path too?",
  "Refactored that into a single helper. The three call sites now share one code path.",
  "Confirmed — no other callers depend on the old field. Safe to remove.",
];

export function MessageQueueDemo() {
  const [messages, setMessages] = useState<Msg[]>([
    { id: uid(), role: "user", text: "Fix the blocked-park propagation in the dispatcher." },
    { id: uid(), role: "assistant", text: "On it — tracing where the park reason gets swallowed." },
  ]);
  const [busy, setBusy] = useState(true);
  const [queue, setQueue] = useState<Queued[]>([]);
  const [draft, setDraft] = useState("");
  const [activity, setActivity] = useState(ACTIVITIES[1]);
  const [elapsed, setElapsed] = useState(0);
  const [editingId, setEditingId] = useState<string | null>(null);

  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const queueRef = useRef<Queued[]>([]);
  const replyIdx = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  // Elapsed + rotating activity while busy — the "still alive" signal.
  useEffect(() => {
    if (!busy) {
      setElapsed(0);
      return;
    }
    const started = Date.now();
    const tick = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 250);
    const rot = setInterval(
      () => setActivity(ACTIVITIES[Math.floor(Math.random() * ACTIVITIES.length)]),
      1400,
    );
    return () => {
      clearInterval(tick);
      clearInterval(rot);
    };
  }, [busy]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  // Clean up any pending timeouts on unmount (stage navigation).
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  // Run one agent turn for `userText`; when it completes, immediately pull the
  // next queued message (staying busy across the whole queue) or go idle.
  const runTurn = useCallback((_userText: string) => {
    setBusy(true);
    const t = setTimeout(() => {
      const reply = REPLIES[replyIdx.current % REPLIES.length];
      replyIdx.current += 1;
      setMessages((prev) => [...prev, { id: uid(), role: "assistant", text: reply }]);

      const q = queueRef.current;
      if (q.length > 0) {
        const [next, ...rest] = q;
        setQueue(rest);
        setMessages((prev) => [...prev, { id: uid(), role: "user", text: next.text }]);
        runTurn(next.text);
      } else {
        setBusy(false);
      }
    }, 2600 + Math.random() * 900);
    timers.current.push(t);
  }, []);

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    if (busy) {
      // Agent is working → queue it.
      setQueue((q) => [...q, { id: uid(), text }]);
    } else {
      setMessages((prev) => [...prev, { id: uid(), role: "user", text }]);
      runTurn(text);
    }
  };

  const removeQueued = (id: string) => setQueue((q) => q.filter((m) => m.id !== id));
  const editQueued = (id: string, text: string) =>
    setQueue((q) => q.map((m) => (m.id === id ? { ...m, text } : m)));

  return (
    <div className="min-h-full bg-background p-6 sm:p-10">
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        <div className="space-y-1.5">
          <h2 className="text-lg font-semibold">Queue while the agent works</h2>
          <p className="text-sm text-muted-foreground">
            Type and hit Enter while the agent is busy — your message joins the queue above the
            composer instead of being dropped or interrupting the turn. Reorder-free, editable and
            removable; queued messages fire in order as each turn finishes. Try sending two or three
            in a row.
          </p>
        </div>

        {/* Transcript */}
        <div
          ref={scrollRef}
          className="h-[300px] space-y-3 overflow-y-auto rounded-xl border bg-card/40 p-4"
        >
          {messages.map((m) => (
            <div key={m.id} className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}>
              <div
                className={cn(
                  "max-w-[80%] rounded-2xl px-3.5 py-2 text-sm",
                  m.role === "user"
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-foreground",
                )}
              >
                {m.text}
              </div>
            </div>
          ))}
          {busy && (
            <div className="flex justify-start">
              <div className="flex items-center gap-2.5 rounded-2xl bg-muted px-3.5 py-2">
                <span className="relative flex size-2">
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary/60" />
                  <span className="relative inline-flex size-2 rounded-full bg-primary" />
                </span>
                <span className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
                  <TerminalIcon className="size-3.5" />
                  <Shimmer className="text-xs" duration={1.6}>
                    {activity}
                  </Shimmer>
                </span>
                <span className="font-mono text-[11px] text-muted-foreground/70">{elapsed}s</span>
              </div>
            </div>
          )}
        </div>

        {/* Queue + composer */}
        <div className="space-y-2">
          {queue.length > 0 && (
            <div className="space-y-1.5 rounded-xl border border-primary/25 bg-primary/[0.04] p-2">
              <div className="flex items-center justify-between px-1.5 pt-0.5">
                <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Queued · sends in order
                </span>
                <span className="rounded-full bg-primary/15 px-1.5 text-[10px] font-medium text-primary">
                  {queue.length}
                </span>
              </div>
              {queue.map((m, i) => (
                <QueueItem
                  key={m.id}
                  index={i + 1}
                  text={m.text}
                  editing={editingId === m.id}
                  onEdit={() => setEditingId(m.id)}
                  onCommit={(v) => {
                    editQueued(m.id, v);
                    setEditingId(null);
                  }}
                  onRemove={() => removeQueued(m.id)}
                />
              ))}
            </div>
          )}

          <div className="overflow-hidden rounded-xl border border-input bg-card shadow-sm">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
              rows={2}
              placeholder={busy ? "Agent is working — type to queue a message…" : "Send a message…"}
              className="w-full resize-none bg-transparent px-3.5 pt-3 text-sm outline-none placeholder:text-muted-foreground"
            />
            <div className="flex items-center gap-2 px-2.5 pb-2.5">
              {busy ? (
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span className="size-1.5 animate-pulse rounded-full bg-primary" />
                  Working — Enter queues
                </span>
              ) : (
                <span className="text-xs text-muted-foreground">Ready — Enter sends</span>
              )}
              <span className="ml-auto" />
              <Button size="icon-sm" aria-label={busy ? "Queue message" : "Send"} onClick={submit} disabled={!draft.trim()}>
                <ArrowUpIcon className="size-4" />
              </Button>
            </div>
          </div>
          <p className="px-1 text-xs text-muted-foreground">
            Nothing is lost while the agent is mid-turn, and you keep full control of what's pending —
            edit the wording or drop a message before it ever sends.
          </p>
        </div>
      </div>
    </div>
  );
}

function QueueItem({
  index,
  text,
  editing,
  onEdit,
  onCommit,
  onRemove,
}: {
  index: number;
  text: string;
  editing: boolean;
  onEdit: () => void;
  onCommit: (v: string) => void;
  onRemove: () => void;
}) {
  const [draft, setDraft] = useState(text);
  useEffect(() => setDraft(text), [text, editing]);

  return (
    <div className="group flex items-center gap-2 rounded-lg bg-background/80 px-2 py-1.5 ring-1 ring-border">
      <GripVerticalIcon className="size-3.5 shrink-0 text-muted-foreground/50" />
      <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[10px] font-medium text-primary">
        {index}
      </span>
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onCommit(draft.trim() || text);
            } else if (e.key === "Escape") {
              onCommit(text);
            }
          }}
          onBlur={() => onCommit(draft.trim() || text)}
          className="min-w-0 flex-1 border-b border-primary/40 bg-transparent text-sm outline-none"
        />
      ) : (
        <button
          type="button"
          onClick={onEdit}
          className="min-w-0 flex-1 truncate text-left text-sm hover:text-foreground"
          title="Click to edit"
        >
          {text}
        </button>
      )}
      {editing ? (
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Save"
          className="text-primary"
          onClick={() => onCommit(draft.trim() || text)}
        >
          <CheckIcon className="size-3.5" />
        </Button>
      ) : (
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Edit"
          className="text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
          onClick={onEdit}
        >
          <PencilIcon className="size-3.5" />
        </Button>
      )}
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label="Remove"
        className="text-muted-foreground hover:text-destructive"
        onClick={onRemove}
      >
        <XIcon className="size-3.5" />
      </Button>
    </div>
  );
}
