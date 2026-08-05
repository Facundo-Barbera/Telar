"use client";

// The mini-dock's client store — sessions that follow you across every route
// (spec: lib/demo-gallery/chat/mini-dock.tsx). Mounted ONCE in the root layout
// so its state survives route changes.
//
// CLIENT-BUNDLE RULE: this store reaches session state ONLY through the app's
// existing HTTP surface (GET /api/chats/[id] for the tail, the SSE tail at
// /api/chat/[sessionId]/events for live working/streaming, POST /api/chat to
// send, GET /api/looms/[id] for park state). It imports NO server-only module —
// there is no shared in-memory session store to consume (each session page owns
// its own live state), so the dock independently tails the same server the
// session page tails. See the runtime host for the fetch/SSE wiring.
//
// PERSISTENCE: the docked set + its order + each session's last-viewed marker
// live in localStorage under the same `telar:*` convention the sidebar/projects
// use (useStoredList). Expanded panels are ephemeral (in-memory).

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

const ENTRIES_KEY = "telar:dock-entries"; // persisted: docked set + order
const VIEWED_KEY = "telar:dock-viewed"; // persisted: assistant-count at last view
const MAX_EXPANDED = 2;

// The durable identity of a docked session (persisted). Everything live —
// messages, working, cost, park — is refetched into Runtime, never stored.
export interface DockEntry {
  id: string;
  title: string;
  project: string;
  initial: string;
  // Marks a head the client parked automatically (item 3 auto-dock): the user
  // navigated away from the standalone session while its turn was still
  // running. Re-entering that session standalone removes ITS auto-docked head
  // (clearAutoDock), while a manually-docked head (autoDocked falsy) is never
  // touched by re-entry. Persisted like any other field.
  autoDocked?: boolean;
}

export type CompactMsg =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string }
  | { role: "tools"; steps: { tool: string; target: string }[] };

// Live per-session state the runtime host writes; read by heads + panels.
export interface Runtime {
  title: string;
  project: string;
  messages: CompactMsg[];
  assistantCount: number; // # of assistant messages (unread = this − lastViewed)
  working: boolean;
  parked: boolean;
  cost: number;
  loaded: boolean;
  // The session's own config, so the dock composer can POST a turn with the same
  // model/account it was created under (the route requires them). Absent until
  // the first detail fetch lands.
  model?: string;
  account?: string;
  runtimeMode?: string;
  // The session's reasoning effort, carried for the same reason model is: the
  // dock composer's POST has to restate it or the turn silently drops it (and,
  // since an absent effort means Auto on the wire, erases it from the row).
  effort?: string;
  // 1.5 queue-capable composer: messages typed while the session is working wait
  // here in order; the runtime host drains the head the moment it goes idle.
  queued: string[];
  // The last turn's PRE-STREAM rejection, if any — a plain JSON 4xx from
  // POST /api/chat, before an SSE stream ever existed (see the runtime host's
  // sendTurn). It needs a field of its own because nothing else here can carry a
  // sentence: `messages` is CompactMsg, whose three variants are all transcript
  // content, and pushing a rejection through as `{ role: "assistant" }` would
  // disguise a turn that never ran as a model reply. Cleared the moment THIS
  // SESSION's next turn begins — by `sendTurn` for a dock-initiated send, and by
  // the live tail's first event for a turn started anywhere else (both in
  // session-runtime-host.tsx). It deliberately survives an idle session, because
  // a sentence about a turn that never ran has to outlive the click that
  // provoked it.
  error?: string;
  // Story 4.2 / AC7 (FR-UW-6) — this session's LIVE ULTRA RUN summary, as one
  // already-rendered line: `name · state · spend` for a single run, or
  // "N runs live" with the summed spend. Written by
  // `components/common/ultra-dock-signal.tsx` (the app-wide poller, mounted once
  // in the root layout) and read by the head in `dock.tsx`.
  //
  // A STRING AND NOT A STRUCTURE, deliberately. The projection that decides it
  // is `summarizeRuns` in `@/lib/ultra-runs`, which is pure and tested; the dock
  // renders what it is given. A shape here would put the 1-vs-N rule and the
  // spend unit inside a component with no test harness.
  //
  // Absent/empty ⇒ the head renders exactly what it renders today. Note this is
  // the FIRST spend the dock has ever rendered: `cost` above is declared,
  // defaulted twice, written once and read NOWHERE.
  ultraSummary?: string;
  // The run to focus on arrival, appended to the tap's URL as `?run=`. Absent
  // when several runs are live — there is no single one to focus.
  ultraFocusRunId?: string;
}

interface DockCtx {
  entries: DockEntry[];
  expanded: string[];
  runtime: Record<string, Runtime | undefined>;
  viewed: Record<string, number>;
  dockSession: (entry: DockEntry) => void;
  // Item 3 auto-dock: park a session as a minimized head (no auto-expand) when
  // the user leaves the standalone view mid-turn. No-ops if the id is already
  // docked (manual OR auto) — never a duplicate head.
  autoDock: (entry: DockEntry) => void;
  // Remove an id's head ONLY if it was auto-docked; manual heads are left in
  // place. Called when the standalone session view for that id (re)mounts.
  clearAutoDock: (id: string) => void;
  undock: (id: string) => void;
  toggleExpand: (id: string) => void;
  minimize: (id: string) => void;
  isDocked: (id: string) => boolean;
  setRuntime: (id: string, patch: Partial<Runtime>) => void;
  markViewed: (id: string) => void;
  // 1.5: append a message to a session's send queue (drained by the runtime host
  // once idle). Kept in the store, not panel-local, so it survives minimize.
  enqueue: (id: string, text: string) => void;
  // Pop the head of the queue for sending — returns it and removes it atomically
  // so the runtime host never double-sends. Undefined when the queue is empty.
  dequeue: (id: string) => string | undefined;
  // Stop an active turn (session view parity: POST /api/chat/stop + local
  // teardown). The runtime host registers the actual handler (it owns the
  // fetch/abort refs); this is a no-op if no host is mounted for the id.
  registerStopHandler: (id: string, fn: (() => void) | null) => void;
  requestStop: (id: string) => void;
}

const Ctx = createContext<DockCtx | null>(null);

function readJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function DockProvider({ children }: { children: React.ReactNode }) {
  const [entries, setEntries] = useState<DockEntry[]>([]);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [runtime, setRuntimeState] = useState<Record<string, Runtime | undefined>>({});
  const [viewed, setViewed] = useState<Record<string, number>>({});
  const hydrated = useRef(false);

  // Hydrate after mount (SSR + first paint agree on empty), then persist on change.
  useEffect(() => {
    setEntries(readJSON<DockEntry[]>(ENTRIES_KEY, []));
    setViewed(readJSON<Record<string, number>>(VIEWED_KEY, {}));
    hydrated.current = true;
  }, []);

  useEffect(() => {
    if (!hydrated.current) return;
    try {
      localStorage.setItem(ENTRIES_KEY, JSON.stringify(entries));
    } catch {
      /* private mode — dock just won't be remembered */
    }
  }, [entries]);

  useEffect(() => {
    if (!hydrated.current) return;
    try {
      localStorage.setItem(VIEWED_KEY, JSON.stringify(viewed));
    } catch {
      /* best effort */
    }
  }, [viewed]);

  // markViewed needs the live assistant count — resolve it against runtime.
  const runtimeRef = useRef(runtime);
  runtimeRef.current = runtime;
  // Latest entries for clearAutoDock's read-then-decide (avoids re-creating the
  // callback and lets it check the autoDocked flag before mutating).
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const markViewedNow = useCallback((id: string) => {
    const count = runtimeRef.current[id]?.assistantCount ?? 0;
    setViewed((prev) => ({ ...prev, [id]: count }));
  }, []);

  const dockSession = useCallback((entry: DockEntry) => {
    setEntries((prev) =>
      prev.some((e) => e.id === entry.id) ? prev : [...prev, entry],
    );
    // Docking the current session is the natural entry point — expand it at once.
    setExpanded((prev) => {
      if (prev.includes(entry.id)) return prev;
      return [...prev, entry.id].slice(-MAX_EXPANDED);
    });
    markViewedNow(entry.id);
  }, [markViewedNow]);

  // Auto-dock lands as a minimized head only — no auto-expand (the user didn't
  // ask for a panel; they just walked away from a running turn). No-op if the
  // id is already docked either way, so re-navigations never stack heads. Unread
  // is NOT seeded here: the baseline effect below sets it once the runtime host
  // loads, so pre-existing (already-seen) turns don't flash as unread.
  const autoDock = useCallback((entry: DockEntry) => {
    setEntries((prev) =>
      prev.some((e) => e.id === entry.id)
        ? prev
        : [...prev, { ...entry, autoDocked: true }],
    );
  }, []);

  const clearAutoDock = useCallback((id: string) => {
    const existing = entriesRef.current.find((e) => e.id === id);
    if (!existing || !existing.autoDocked) return; // manual heads untouched
    setEntries((prev) => prev.filter((e) => e.id !== id));
    setExpanded((prev) => prev.filter((x) => x !== id));
    setRuntimeState((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const undock = useCallback((id: string) => {
    setEntries((prev) => prev.filter((e) => e.id !== id));
    setExpanded((prev) => prev.filter((x) => x !== id));
    setRuntimeState((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const toggleExpand = useCallback((id: string) => {
    setExpanded((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      return [...prev, id].slice(-MAX_EXPANDED); // a third opens by folding the oldest
    });
    markViewedNow(id);
  }, [markViewedNow]);

  const minimize = useCallback((id: string) => {
    setExpanded((prev) => prev.filter((x) => x !== id));
  }, []);

  const isDocked = useCallback(
    (id: string) => entries.some((e) => e.id === id),
    [entries],
  );

  const setRuntime = useCallback((id: string, patch: Partial<Runtime>) => {
    setRuntimeState((prev) => {
      const cur = prev[id];
      const base: Runtime = cur ?? {
        title: "",
        project: "",
        messages: [],
        assistantCount: 0,
        working: false,
        parked: false,
        cost: 0,
        loaded: false,
        queued: [],
      };
      return { ...prev, [id]: { ...base, ...patch } };
    });
  }, []);

  const baseRuntime = (cur: Runtime | undefined): Runtime =>
    cur ?? {
      title: "",
      project: "",
      messages: [],
      assistantCount: 0,
      working: false,
      parked: false,
      cost: 0,
      loaded: false,
      queued: [],
    };

  const enqueue = useCallback((id: string, text: string) => {
    setRuntimeState((prev) => {
      const base = baseRuntime(prev[id]);
      return { ...prev, [id]: { ...base, queued: [...base.queued, text] } };
    });
  }, []);

  // Atomic pop: reads the ref for the head, then removes it via a functional
  // update. The ref read + the update run in the same tick, and the host guards
  // sends behind its own in-flight flag, so a head is never sent twice.
  const dequeue = useCallback((id: string): string | undefined => {
    const q = runtimeRef.current[id]?.queued ?? [];
    if (q.length === 0) return undefined;
    const [head, ...rest] = q;
    setRuntimeState((prev) => {
      const base = baseRuntime(prev[id]);
      return { ...prev, [id]: { ...base, queued: rest } };
    });
    return head;
  }, []);

  // Imperative side-channel (mirrors the chat-runs.ts registry pattern
  // server-side): the runtime host is the only thing holding the live
  // AbortControllers, so it registers a stop closure here; the panel's Stop
  // button calls it by id without reaching into the host directly. A plain
  // ref (not state) — invoking it is a side effect, not a render input.
  const stopHandlersRef = useRef<Record<string, () => void>>({});
  const registerStopHandler = useCallback((id: string, fn: (() => void) | null) => {
    if (fn) stopHandlersRef.current[id] = fn;
    else delete stopHandlersRef.current[id];
  }, []);
  const requestStop = useCallback((id: string) => {
    stopHandlersRef.current[id]?.();
  }, []);

  // Auto-docked heads get their unread baseline the moment the runtime host
  // finishes its first load: viewed := the assistant-count already persisted at
  // that point (the turns the user had seen before leaving). The current, still
  // in-flight reply isn't persisted yet, so it lands ABOVE this baseline and
  // shows as the unread badge once the turn finishes — matching "keeps the head
  // with the unread badge". While viewed stays undefined (pre-load), unreadOf
  // reads 0, so nothing flashes before the baseline is set.
  useEffect(() => {
    setViewed((prev) => {
      let next = prev;
      for (const e of entries) {
        if (!e.autoDocked || prev[e.id] !== undefined) continue;
        const rt = runtime[e.id];
        if (rt?.loaded) {
          if (next === prev) next = { ...prev };
          next[e.id] = rt.assistantCount;
        }
      }
      return next;
    });
  }, [entries, runtime]);

  // Expanding an already-open session should also refresh its viewed marker as
  // new messages land — handled at open time (toggleExpand/dockSession) and by
  // the panel calling markViewed when the tail grows while it's open.
  const value = useMemo<DockCtx>(
    () => ({
      entries,
      expanded,
      runtime,
      viewed,
      dockSession,
      autoDock,
      clearAutoDock,
      undock,
      toggleExpand,
      minimize,
      isDocked,
      setRuntime,
      markViewed: markViewedNow,
      enqueue,
      dequeue,
      registerStopHandler,
      requestStop,
    }),
    [entries, expanded, runtime, viewed, dockSession, autoDock, clearAutoDock, undock, toggleExpand, minimize, isDocked, setRuntime, markViewedNow, enqueue, dequeue, registerStopHandler, requestStop],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useDock(): DockCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useDock must be used within a DockProvider");
  return ctx;
}

/** Non-throwing variant for surfaces that may render outside the provider (e.g.
 *  the dev gallery mounting SessionView in isolation) — degrades to no dock. */
export function useDockOptional(): DockCtx | null {
  return useContext(Ctx);
}

/** Unread agent messages for a docked session since it was last viewed. */
export function unreadOf(rt: Runtime | undefined, viewed: number | undefined): number {
  if (!rt) return 0;
  return Math.max(0, rt.assistantCount - (viewed ?? rt.assistantCount));
}
