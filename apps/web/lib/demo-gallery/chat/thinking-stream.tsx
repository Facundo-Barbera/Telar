"use client";

// 1.3 — Thinking block that actually shows something.
// CURRENT: session-view's ThinkingRow renders a collapsible, but the server
// emits thinking only as live SSE and never persists it, so on any non-live
// render the block is present yet empty — a "✻ Thought" row that expands to
// nothing. REDESIGN: (a) stream the thinking text live into a growing muted
// block with a caret; (b) collapse to a labelled, DURATION-stamped row that
// expands to the captured text; (c) a hard suppression rule — no text, no
// block, ever.

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { cn } from "@/lib/utils";
import { Caption, DemoShell, Section, ThemePair } from "./_shared";

type Thinking = { text: string; done: boolean; durationMs?: number };

// The single source of truth for how a thinking part renders. The very first
// line is the suppression rule: whitespace-only content renders NOTHING, so an
// empty collapsible is structurally impossible.
function ThinkingBlock({ part }: { part: Thinking }) {
  const [open, setOpen] = useState(false);
  if (!part.text.trim()) return null; // ← suppression

  if (!part.done) {
    return (
      <div className="rounded-md border border-dashed border-border bg-muted/10 px-2.5 py-2">
        <div className="mb-1 flex items-center gap-1.5">
          <span aria-hidden className="text-xs">
            ✻
          </span>
          <Shimmer as="span" className="text-[11px] font-medium">
            Thinking
          </Shimmer>
        </div>
        <p className="text-xs italic leading-relaxed whitespace-pre-wrap text-muted-foreground">
          {part.text}
          <span className="ml-0.5 inline-block h-3 w-[2px] translate-y-0.5 animate-pulse bg-muted-foreground/70 align-middle" />
        </p>
      </div>
    );
  }

  const secs = part.durationMs ? `${Math.max(1, Math.round(part.durationMs / 1000))}s` : null;
  return (
    <div className="rounded-md">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs text-muted-foreground hover:bg-muted/60"
      >
        <span aria-hidden className="shrink-0">
          ✻
        </span>
        <span className="min-w-0 flex-1 truncate italic">Thought</span>
        {secs && <span className="shrink-0 font-mono text-[10px] text-muted-foreground/60">{secs}</span>}
        <ChevronRightIcon className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} />
      </button>
      {open && (
        <p className="mx-1.5 mb-1.5 rounded-md bg-muted/10 p-2 text-[11px] italic leading-relaxed whitespace-pre-wrap text-muted-foreground">
          {part.text}
        </p>
      )}
    </div>
  );
}

const THINKING_TEXT =
  "The user wants the failing test fixed. First I should reproduce it — the assertion is on the parsed cost total. Cost is summed only over the main agent's usage events, so sub-agent spend is dropped. I'll walk the transcript, bucket by parent_tool_use_id, and fold every bucket's usage into the total before formatting.";

function StreamSim() {
  const words = useRef(THINKING_TEXT.split(" "));
  const [count, setCount] = useState(0);
  const [phase, setPhase] = useState<"idle" | "streaming" | "done">("idle");
  const startedAt = useRef(0);
  const [durationMs, setDurationMs] = useState<number>();

  const play = useCallback(() => {
    setCount(0);
    setDurationMs(undefined);
    setPhase("streaming");
    startedAt.current = Date.now();
  }, []);

  useEffect(() => {
    if (phase !== "streaming") return;
    if (count >= words.current.length) {
      setPhase("done");
      setDurationMs(Date.now() - startedAt.current);
      return;
    }
    const t = setTimeout(() => setCount((c) => c + 1), 55);
    return () => clearTimeout(t);
  }, [phase, count]);

  const part: Thinking =
    phase === "idle"
      ? { text: "", done: true }
      : {
          text: words.current.slice(0, count).join(" "),
          done: phase === "done",
          durationMs,
        };

  return (
    <div className="rounded-xl border border-border bg-card/40 p-4">
      <div className="mb-3 flex items-center gap-2">
        <button
          type="button"
          onClick={play}
          className="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          {phase === "idle" ? "Stream thinking" : "Replay"}
        </button>
        <span className="font-mono text-[10px] text-muted-foreground/60">
          {phase === "idle" ? "idle" : phase === "streaming" ? "streaming…" : "collapsed — click ✻ Thought"}
        </span>
      </div>
      <div className="min-h-16">
        {phase === "idle" ? (
          <p className="text-xs text-muted-foreground/60">press “Stream thinking”</p>
        ) : (
          <ThinkingBlock part={part} />
        )}
      </div>
    </div>
  );
}

export function ThinkingStreamDemo() {
  return (
    <DemoShell>
      <Section
        title="Live stream → collapsed thought"
        note="Streams token-by-token into a growing block with a caret, then collapses to a duration-stamped row you can re-expand."
      >
        <StreamSim />
      </Section>
      <Section title="Finished vs. empty — the suppression rule" note="Same component, three inputs. Whitespace-only content returns null: an empty collapsible cannot exist.">
        <ThemePair className="items-start">
          <div className="space-y-3">
            <div>
              <Caption>done · has text → collapsed row</Caption>
              <ThinkingBlock part={{ text: THINKING_TEXT, done: true, durationMs: 4200 }} />
            </div>
            <div>
              <Caption>done · empty text → renders nothing</Caption>
              <div className="rounded-md border border-dashed border-border/60 px-2.5 py-2 text-[11px] text-muted-foreground/50">
                {/* suppression: ThinkingBlock returns null, so this row is a
                    stand-in note, not the component */}
                (suppressed — no “✻ Thought” chrome emitted)
              </div>
            </div>
          </div>
        </ThemePair>
      </Section>
    </DemoShell>
  );
}
