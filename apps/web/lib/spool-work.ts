"use client";

/**
 * WHAT THE SPOOL IS DOING RIGHT NOW, on the client side.
 *
 * The engine holds this in memory (`apps/engine/src/spool/work.ts`) because a
 * pass in flight is not durable data. This hook is the only way a surface sees
 * one, and its whole job is to be honest about a thing that costs minutes and
 * real money: which item is being read, how far along it is, and — the part
 * that did not exist before — that it is still happening after you navigated
 * away.
 *
 * ── POLLED ONLY WHILE THERE IS SOMETHING TO SEE ──────────────────────────────
 * The same rule the master chat already follows for its transcript: a settled
 * Spool is a static page, and tailing it forever would be a request storm for a
 * screen nobody is watching change. So:
 *
 *   · ONE READ ON MOUNT, always — a pass started before this page loaded (or in
 *     another window) has to appear, and a reload during one must not lose it.
 *   · KEEP POLLING while anything is running.
 *   · STOP when everything has settled, and start again the moment a caller
 *     says it began something (`began()`).
 *
 * That last hook is what makes the "stop when idle" rule safe: every way work
 * starts today goes through a click on this client, so there is no run this
 * cannot know about. If work ever starts on a schedule, this is the one place
 * that has to learn to keep looking.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SpoolWork } from "@telar/engine-client";

/** Fast enough that a step line reads as live, slow enough that a twenty-turn
 *  pass is not a thousand requests. The transcript tail next door uses 700. */
const TICK_MS = 900;
/** The idle beat. Slow enough to be free, fast enough that work started
 *  elsewhere shows up before you wonder whether anything is happening. */
const IDLE_TICK_MS = 4000;

export type SpoolWorkView = {
  /** Everything the daemon is holding: live first-class, settled as a short
   *  tail. Oldest to newest, which is the order it is read in. */
  all: SpoolWork[];
  running: SpoolWork[];
  /** The live entry for one item, when there is one. What a per-item control
   *  reads to know it must not offer to start a second pass. */
  runningFor: (itemId: string) => SpoolWork | undefined;
  /** The live entry for a whole SUBJECT — what a `threads` pass is addressed by,
   *  since it is about every capture at once rather than one item. Separate from
   *  `runningFor` so a subject cannot match an item that shares its string. */
  runningForSubject: (subject: string) => SpoolWork | undefined;
  /** The most recent SETTLED entry for one item — what just happened here, so a
   *  surface can report an outcome without the caller holding it in state. */
  settledFor: (itemId: string) => SpoolWork | undefined;
  /** Read once, now. */
  refresh: () => void;
  /** Tell the hook something was just started, so it resumes polling without
   *  waiting to discover it. */
  began: () => void;
  /** Stop one pass, then read. Safe on an id that has already settled — the
   *  route answers `{stopped: false}` rather than failing. */
  cancel: (id: string) => void;
};

export function useSpoolWork(): SpoolWorkView {
  const [all, setAll] = useState<SpoolWork[]>([]);
  /**
   * WHY A REF AND NOT STATE. It only decides whether the next tick fires, so
   * putting it in state would re-render every consumer to change a boolean
   * nothing draws. `began()` sets it without a render for the same reason.
   */
  const active = useRef(false);
  const [awake, setAwake] = useState(0);

  const read = useCallback(async () => {
    try {
      const res = await fetch("/api/spool/work");
      const data = res.ok ? await res.json() : { work: [] };
      const work: SpoolWork[] = data.work ?? [];
      active.current = work.some((entry) => entry.state === "running");
      setAll(work);
    } catch {
      // A dropped poll is not worth a banner. The next tick retries, and the
      // last good record stays on screen meanwhile — a pass that is still
      // running has not stopped just because one request did.
    }
  }, []);

  useEffect(() => {
    // Deferred to a task rather than run in the effect body: a synchronous
    // fetch-and-setState on mount is a cascading render, and this app has a
    // lint rule about it. NO "have I run yet" ref — the timeout pairing is
    // already double-invoke safe, and a ref here was the bug that once left the
    // master chat on its skeleton forever.
    const first = window.setTimeout(() => void read(), 0);
    return () => window.clearTimeout(first);
  }, [read, awake]);

  /**
   * TWO CADENCES, AND THE SLOW ONE IS WHY THE SURFACE FEELS ALIVE.
   *
   * This only ticked while something was ALREADY known to be running, which
   * meant a night or a pass started anywhere else — a cron, another window, the
   * daemon itself — was invisible until you happened to act. The brief looked
   * static because it WAS static: nothing on it ever changed by itself.
   *
   * So it idles at a slow beat and drops to the fast one the moment work
   * appears. The slow tick costs one small GET every few seconds against a
   * loopback daemon holding the record in memory.
   */
  useEffect(() => {
    const timer = window.setInterval(() => void read(), active.current ? TICK_MS : IDLE_TICK_MS);
    return () => window.clearInterval(timer);
  }, [read, awake]);

  return useMemo(
    () => ({
      all,
      running: all.filter((entry) => entry.state === "running"),
      runningFor: (itemId) => all.find((entry) => entry.state === "running" && entry.itemId === itemId),
      runningForSubject: (subject) => all.find((entry) => entry.state === "running" && entry.subject === subject),
      // LAST WINS. The registry is insertion-ordered, so the newest settled
      // entry for an item is the last one that matches.
      settledFor: (itemId) => all.filter((entry) => entry.state !== "running" && entry.itemId === itemId).at(-1),
      refresh: () => setAwake((n) => n + 1),
      began: () => {
        active.current = true;
        setAwake((n) => n + 1);
      },
      cancel: (id) => {
        void fetch(`/api/spool/work/${encodeURIComponent(id)}`, { method: "DELETE" })
          .catch(() => undefined)
          .finally(() => setAwake((n) => n + 1));
      },
    }),
    [all],
  );
}

/**
 * One line naming what a pass is doing, or what it did.
 *
 * PURE, so the vocabulary is testable without a provider or a browser — the
 * same reason `stepLabel` is pure on the engine side.
 *
 * ── "Starting…" WAS A LIE THAT LASTED A MINUTE ──────────────────────────────
 * The no-step fallback was written for the second or two between the click and
 * the first SDK message. Then `threads` landed — a ONE-SHOT structured call,
 * which by construction makes no intermediate tool calls and therefore emits no
 * steps at all. Driven live, mapping aurora sat on "Starting…" for the whole
 * pass while it was in fact most of the way through.
 *
 * So the fallback names the KIND instead. It is true for the entire run of a
 * pass that has nothing finer to report, and inventing motion it does not have
 * would be exactly the decorative progress this module refuses elsewhere.
 */
export function describeWork(entry: SpoolWork): string {
  if (entry.state === "running") return entry.step?.label ?? workKindLabel(entry);
  return entry.note ?? (entry.state === "done" ? "Done." : entry.state === "refused" ? "Refused." : "Failed.");
}

/**
 * What the work was, in the user's words rather than the schema's.
 *
 * A `switch` AND NOT A TERNARY CHAIN. The two-armed ternary this replaced made
 * every kind that was not `expert` say "drafting an approach", so the day
 * `threads` landed it would have described a subject-wide mapping pass as a
 * draft — silently, and with the suite green.
 */
export function workKindLabel(entry: SpoolWork): string {
  switch (entry.kind) {
    case "expert":
      return "reading it";
    case "draft":
      return "drafting an approach";
    case "threads":
      return "working out the questions";
    default:
      // A kind this build does not know is a newer daemon talking to an older
      // web — neutral rather than wrong.
      return "working on it";
  }
}
