"use client";

/**
 * HOW FULL IS THIS CONVERSATION — the small meter #539 asked for.
 *
 * ── WHY IT EXISTS ───────────────────────────────────────────────────────────
 * The Agent reported no context at all: a coordinator whose history is quietly
 * being trimmed behind it is one a person cannot reason about, and the first
 * sign of trouble was the model forgetting something it had been told.
 *
 * ── TWO NUMBERS, AND THEY ARE NOT THE SAME KIND OF THING ────────────────────
 * TOKENS LAST TURN is the provider's own count, and it is a PRICE — what that
 * exchange cost. It says nothing about how much room is left, because a turn
 * can be expensive on a nearly empty thread.
 *
 * PERCENT OF BUDGET is the engine's own measurement, in characters, from the
 * trim step that decides what to send (`agent/trim.ts`). It is the one that
 * answers "how much room is left", and it is deliberately a proportion of
 * TELAR'S ceiling rather than of the model's window: the trim is what will
 * actually drop the oldest exchange, so it is the thing worth watching.
 *
 * Both are shown because neither substitutes for the other, and the title
 * attribute says which is which for the reader who wonders.
 *
 * ── NOT AGENT-SPECIFIC, ON PURPOSE ──────────────────────────────────────────
 * The session masthead has no meter today and should have the same one when it
 * does. So this takes numbers, not an `AgentState`: the reading is computed by
 * `contextMeterReading`, which is a pure function a test can hold without
 * rendering anything.
 */

import { cn } from "@/lib/utils";

export type ContextMeterInput = {
  /** The provider's own token count for the last turn. ABSENT is a real case —
   *  an OpenAI-compatible server need not report usage — and it must not be
   *  drawn as zero, which would assert the turn was free.
   *
   *  `cacheRead` is a PART OF `input`, not a number beside it, on every route
   *  the engine runs (#563 item 3) — so the honest way to draw it is as a
   *  proportion of the input, and absent means the provider said nothing about
   *  caching rather than that the cache was cold. */
  usage?: { input: number; output: number; total: number; cacheRead?: number; cacheCreate?: number };
  /** What the prompt cost in characters, as the trim step measured it. */
  contextChars: number;
  /** The trim ceiling those characters are a proportion of. */
  budgetChars: number;
  /** How many older turns the last turn folded to one line each (#567). Absent
   *  on a Mac too old to say; zero on the ordinary turn that folded nothing. */
  folded?: number;
};

export type ContextMeterReading = {
  /** 0–100, clamped. A prompt over budget draws full rather than overflowing:
   *  the newest block survives any budget (see the trim), so >100% is a real
   *  state and "full" is the honest way to draw it. */
  percent: number;
  /** "2,690 tokens" — absent when the provider reported none. */
  tokens?: string;
  /** "68% cached" — absent when the provider said nothing about caching, which
   *  is not the same as a cold cache. See `cached` below. */
  cached?: string;
  /** "folded 9 turns" — absent unless the last turn actually folded some. */
  folded?: string;
  /** The whole line, as a reader sees it. */
  label: string;
  /** The longer sentence, for the tooltip: what each number actually is. */
  title: string;
};

/**
 * The reading, or `undefined` when there is nothing honest to show — a thread
 * with no ended turn, or a budget of zero that would make every percentage a
 * division by nothing.
 */
export function contextMeterReading(input: ContextMeterInput | undefined): ContextMeterReading | undefined {
  if (!input || input.budgetChars <= 0) return undefined;
  const percent = Math.min(100, Math.max(0, Math.round((input.contextChars / input.budgetChars) * 100)));
  const tokens = input.usage ? `${input.usage.total.toLocaleString("en-US")} tokens` : undefined;
  /**
   * WHY THE METER DROPPED (#567). The engine folds to a LOW-water mark, so the
   * reading really does fall from full to about two thirds between two turns —
   * and a gauge that does that with nothing said beside it reads as a bug. Drawn
   * only when the last turn folded something: "folded 0 turns" on every
   * ordinary turn would be noise in the one place that has to stay quiet.
   */
  const count = input.folded ?? 0;
  const folded = count > 0 ? `folded ${count.toLocaleString("en-US")} turn${count === 1 ? "" : "s"}` : undefined;
  /**
   * HOW MUCH OF THE INPUT THE PROVIDER DID NOT HAVE TO RE-READ (#563 item 3).
   *
   * DRAWN ONLY WHEN THE PROVIDER SAID SOMETHING. `cacheRead` absent is "nobody
   * forwarded cache statistics", and a `0% cached` invented for that case would
   * be a measurement nobody took — the one mistake this whole item exists to
   * avoid. Zero WITH a reading is drawn, because a cold cache is a real and
   * actionable answer.
   *
   * A PROPORTION OF THE INPUT, never of the total: the output was generated and
   * could not have come from a cache, so dividing by `total` would understate
   * every hit by however much the model happened to say.
   */
  const read = input.usage?.cacheRead;
  const cached = read !== undefined && input.usage && input.usage.input > 0 ? `${Math.round((read / input.usage.input) * 100)}% cached` : undefined;
  return {
    percent,
    ...(tokens ? { tokens } : {}),
    ...(cached ? { cached } : {}),
    ...(folded ? { folded } : {}),
    label: [tokens, cached, `${percent}% context`, folded].filter(Boolean).join(" · "),
    title: [
      tokens ? `${tokens} on the last turn, as the model reported them.` : "The model reported no token count for the last turn.",
      ...(cached ? [`${cached}: that share of the input was served from the provider's prompt cache rather than re-read.`] : []),
      `The prompt was ${input.contextChars.toLocaleString("en-US")} of ${input.budgetChars.toLocaleString("en-US")} characters — Telar trims the oldest exchanges past that.`,
      ...(folded ? [`It ${folded} to one line each to make room; the thread keeps them whole.`] : []),
    ].join(" "),
  };
}

/** Under a fifth left is worth a colour; everything below it is ordinary. The
 *  threshold is high because the trim drops history SILENTLY, so the warning has
 *  to arrive before anything has been lost rather than after. */
const CROWDED_PERCENT = 80;

export function ContextMeter({ className, ...input }: ContextMeterInput & { className?: string }) {
  const reading = contextMeterReading(input);
  // NOTHING RATHER THAN A ZEROED GAUGE. A meter reading empty on a thread that
  // has simply not had a turn yet is a number that is wrong, not missing.
  if (!reading) return null;
  const crowded = reading.percent >= CROWDED_PERCENT;
  return (
    <div
      className={cn("flex shrink-0 items-center gap-1.5 text-3xs text-muted-foreground tabular-nums", className)}
      title={reading.title}
      data-testid="context-meter"
    >
      {/* `role="meter"` rather than a progressbar: nothing is in progress — this
          is a level, which is exactly what a meter is for. */}
      <span
        role="meter"
        aria-label="Context used"
        aria-valuenow={reading.percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={`${reading.percent}% of the context budget`}
        className="h-1 w-10 overflow-hidden rounded-full bg-muted"
      >
        <span
          aria-hidden
          className={cn("block h-full rounded-full transition-[width]", crowded ? "bg-warning" : "bg-muted-foreground/60")}
          style={{ width: `${reading.percent}%` }}
        />
      </span>
      <span className={cn("font-mono", crowded && "text-warning")}>{reading.label}</span>
    </div>
  );
}
