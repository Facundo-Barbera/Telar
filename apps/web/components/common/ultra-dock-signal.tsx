"use client";

// Story 4.2 / AC7 (FR-UW-6) — THE APP-WIDE ULTRA RUN SIGNAL.
//
// "Given the user is on another page with a run live, that session's dock bubble
// shows name · state · spend updating live, and tapping it navigates back and
// focuses the run." Mounted ONCE in the root layout, INSIDE `<DockProvider>` (it
// calls `useDock()`; `LoomNotifications` sits outside because it does not), so
// the signal is alive on the dashboard, on project pages, in settings — anywhere.
// Renders nothing.
//
// TWO MEASURED FACTS KILL THE OBVIOUS DESIGN, and they are why this file exists
// rather than a change to `session-runtime-host.tsx`:
//   `<Dock>` returns `null` when `entries.length === 0`, and `SessionRuntimeHost`
//   MOUNTS ONLY FOR ENTRIES — so a session with a live run that the user never
//   docked has no host, no poll and no bubble at all.
//   And today's auto-dock fires only when the CHAT TURN is `busy`, while an Ultra
//   run is DETACHED and routinely outlives its turn.
// So the mechanism that would carry the signal does not run in the exact case the
// AC describes. (`session-view.tsx`'s unmount guard was widened for the other
// direction — LEAVING a session with a live run.)
//
// IT POLLS `GET /api/ultra` UNFILTERED, AND THAT IS DELIBERATE. `?sessionId=`
// exists for `use-ultra-runs.ts`, which knows its own id. Here the only sessions
// a component inside the provider can enumerate are `useDock()`'s `entries`, and
// AC7's whole case is a session that is NOT an entry: FILTERING BY THE SESSIONS
// YOU ALREADY KNOW ABOUT CAN NEVER DISCOVER THE ONE YOU DO NOT. One request,
// every run, newest-first.
//
// ZERO BACKGROUND WORK WHEN THERE IS NOTHING TO WATCH — `loom-notifications.tsx`'s
// disarmed property, which is the shipped precedent for exactly this trade (it
// polls an equally unfiltered `/api/looms` on a 30s cadence). Here the poll runs
// always but the SLOW cadence is the whole cost, and the fast path costs nothing
// once the list comes back empty: no autoDock, no setRuntime, no chat lookup.
//
// CLIENT-BUNDLE RULE: the only `@telar/core` edge is `import type`, erased at
// build time. Every decision — the 1-vs-N summary, the spend sum, the unit — is
// `summarizeRuns` in `@/lib/ultra-runs`, which is pure and tested.

import { useCallback, useEffect, useRef } from "react";
import type { UltraManifest } from "@telar/core";
import { useDockOptional } from "@/components/dock/dock-provider";
import {
  isSessionRoute,
  runSnapshot,
  summarizeRuns,
  unwrapManifests,
  type RunSnapshot,
} from "@/lib/ultra-runs";

// The house cadence for a background list poll. `loom-notifications.tsx` uses
// 30s for the same shape of question; a dock bubble that lags a finished run by
// a few seconds is fine, and a run that STARTS is what the user is waiting to
// see, so this sits between that and the session's own 4s.
const POLL_MS = 8000;

type ChatRow = { id: string; title?: string; project?: string };

export function UltraDockSignal() {
  // OPTIONAL, so this component is safe if it is ever mounted outside the
  // provider — the alternative is a throw in the root layout, which would take
  // the whole app down for a polish-tier feature.
  const dock = useDockOptional();
  const autoDock = dock?.autoDock;
  const setRuntime = dock?.setRuntime;
  // Sessions this component has already docked, so re-docking is not attempted
  // every tick. (`autoDock` itself no-ops on a known id; this saves the churn.)
  const seeded = useRef<Set<string>>(new Set());
  // Session ids whose summary is currently non-empty, so a run going terminal
  // clears the head's line instead of leaving a stale one.
  const showing = useRef<Set<string>>(new Set());

  const poll = useCallback(async () => {
    if (!autoDock || !setRuntime) return;
    let manifests: UltraManifest[];
    try {
      const res = await fetch("/api/ultra");
      if (!res.ok) return;
      // ONE envelope adapter (§5.6-T16) — `{ runs }` here, a bare manifest on
      // the SSE frames, `{ run }` on the detail route.
      manifests = unwrapManifests(await res.json());
    } catch {
      return; // offline / route down — try again next tick
    }

    // Group RUNNING runs by their owning session. A run with no `sessionId` was
    // launched outside a chat and has no dock bubble to belong to.
    const bySession = new Map<string, RunSnapshot[]>();
    for (const m of manifests) {
      if (m.state !== "running" || typeof m.sessionId !== "string" || m.sessionId === "") continue;
      const list = bySession.get(m.sessionId) ?? [];
      // The list route already rendered `name` server-side; `runSnapshot` falls
      // back to its own copy of the label rule when it has not.
      const withName = m as UltraManifest & { name?: string };
      // `null`, NOT `[]` — this poller never reads a journal, and `[]` would
      // claim it had (B1). Nothing the dock renders comes from one; passing the
      // truth here is what keeps `agentsDone` from being a fabricated `0` if
      // anyone ever puts it on the head.
      const snap = runSnapshot(m, null);
      list.push(withName.name ? { ...snap, name: withName.name } : snap);
      bySession.set(m.sessionId, list);
    }

    // FAST PATH: nothing live. Clear any summary this component set and stop —
    // no `/api/chats` fetch, no dock writes.
    if (bySession.size === 0) {
      for (const id of showing.current) {
        setRuntime(id, { ultraSummary: undefined, ultraFocusRunId: undefined });
      }
      showing.current.clear();
      return;
    }

    // A `DockEntry` needs `{ id, title, project, initial }` and A MANIFEST
    // SUPPLIES NONE OF THEM. `title` and the project SLUG come from
    // `GET /api/chats`, keyed by chat id.
    //
    // NEVER `manifest.project` (§5.6-T15): that field is a filesystem ROOT PATH,
    // and `dock.tsx` interpolates the entry's `project` straight into
    // `/projects/<project>/sessions/<id>` — a path there produces a dead URL.
    let chats = new Map<string, ChatRow>();
    try {
      const res = await fetch("/api/chats");
      if (res.ok) {
        const d: unknown = await res.json();
        const rows = (d as { chats?: unknown }).chats;
        if (Array.isArray(rows)) {
          for (const c of rows as ChatRow[]) {
            if (c && typeof c.id === "string") chats.set(c.id, c);
          }
        }
      }
    } catch {
      chats = new Map();
    }

    const stillShowing = new Set<string>();
    for (const [sessionId, runs] of bySession) {
      const chat = chats.get(sessionId);
      // A session id with no matching chat row is SKIPPED, never docked with a
      // placeholder title: a head reading "Untitled" that navigates to a project
      // slug we guessed is worse than no head.
      if (!chat || typeof chat.project !== "string" || chat.project === "") continue;
      const title = typeof chat.title === "string" && chat.title !== "" ? chat.title : sessionId;

      // NEVER DOCK THE SESSION THE USER IS LOOKING AT (review round 1, SF-4).
      // Read from `location` inside the poll rather than through
      // `usePathname()`: this component renders nothing, so it needs no reactive
      // value — and `usePathname` in a root-layout component carries a
      // prerender/`Suspense` constraint under `cacheComponents` that Next's own
      // reference states ("routes with dynamic params not covered by
      // generateStaticParams … otherwise the build fails"), which is the same
      // class of constraint §5.5-G5 weighed for `useSearchParams`. Nothing here
      // is worth buying that with.
      const watching =
        typeof window !== "undefined" && isSessionRoute(window.location.pathname, sessionId);
      if (!seeded.current.has(sessionId) && !watching) {
        seeded.current.add(sessionId);
        autoDock({
          id: sessionId,
          title,
          project: chat.project,
          // As `session-view.tsx`'s own auto-dock mints it, EXCEPT BY CODE POINT
          // (review NH-1). `String.prototype[0]` indexes UTF-16 code units, so a
          // title beginning with an emoji — a chat titled from a first message
          // that starts with one — renders half a surrogate pair as a
          // replacement glyph, and `.toUpperCase()` does not repair it.
          // §5.6-T19 item 9 is the repo rule and this story already followed it
          // in `agents/route.ts`; this site had missed it.
          initial: (
            Array.from(title.trim())[0] ??
            Array.from(chat.project.trim())[0] ??
            "·"
          ).toUpperCase(),
        });
      }

      // ALWAYS THE CLAUDE VALUE (D6a): the ultra MCP server is constructed only
      // on the Claude branch of the chat route and NFR-UW-8 fixes Ultra as
      // Claude-first, so the Codex arm of `spendReadout` is unreachable here.
      // `Runtime` carries no provider, which is exactly why `summarizeRuns`
      // takes it as an argument rather than defaulting it — a default would hide
      // the decision.
      const summary = summarizeRuns(runs, "claude");
      if (!summary) continue;
      stillShowing.add(sessionId);
      setRuntime(sessionId, {
        // `name · state · spend` for one run; "N runs live · $x" for several.
        // Rendered by the pure projection, not composed here.
        ultraSummary: [summary.text, summary.state, summary.spend.text]
          .filter((p): p is string => typeof p === "string" && p !== "")
          .join(" · "),
        ultraFocusRunId: summary.focusRunId,
      });
    }

    // A session whose runs all went terminal since the last tick: clear its line.
    for (const id of showing.current) {
      if (!stillShowing.has(id)) {
        setRuntime(id, { ultraSummary: undefined, ultraFocusRunId: undefined });
      }
    }
    showing.current = stillShowing;
  }, [autoDock, setRuntime]);

  useEffect(() => {
    if (!autoDock || !setRuntime) return;
    let cancelled = false;
    const tick = () => {
      if (!cancelled) void poll();
    };
    tick();
    const t = setInterval(tick, POLL_MS);
    // The app-wide refresh signal every other client surface listens to.
    const onRefresh = () => tick();
    window.addEventListener("telar:refresh", onRefresh);
    return () => {
      cancelled = true;
      clearInterval(t);
      window.removeEventListener("telar:refresh", onRefresh);
    };
  }, [poll, autoDock, setRuntime]);

  return null;
}
