"use client";

/**
 * The host's look, worn by a remote window — the counterpart of
 * appearance-publisher.tsx, and like it headless and silent. The rules are in
 * lib/host-follow.ts; this is the loop that asks the engine and puts the
 * answer on.
 *
 * IT WEARS THROUGH `wearPublication`, which is `applyLook` — the one function
 * that puts an appearance on (lib/looks.ts) — plus the one thing this loop
 * cannot do for itself: keep what the wear cost, for a window with nobody
 * watching it (#705). Same path Apply and Wear take on the Settings pane, so
 * what a remote window ends up wearing is exactly what opening the host's
 * card and pressing Apply would have produced. Then the scheme: a Look carries
 * both halves and the publication says which one the host is looking at.
 *
 * `translucent` and `frost` are NOT worn. They are properties of a macOS
 * desktop window (lib/looks.ts refuses to put them in a Look for the same
 * reason), and a browser tab has no vibrancy to set.
 *
 * TEN SECONDS, AND ON RETURN. The publisher debounces two seconds; a phone
 * opened right after a change on the Mac sees it within the next tick, and a
 * tab that was in the background catches up the moment it is looked at
 * rather than on the timer.
 */

import { useEffect } from "react";
import { createEngineApi } from "@/lib/engine/client";
import { useAppearance } from "@/lib/appearance";
import { decideFollow, readAppliedStamp, useFollowHost, wearPublication, writeAppliedStamp } from "@/lib/host-follow";
import { isHostWindow } from "@/lib/host-window";
import { useTheme } from "@/components/theme-provider";

const api = createEngineApi();

const POLL_MS = 10_000;

export function HostLookFollower(): null {
  const { mode } = useFollowHost();
  const { setAppearance } = useAppearance();
  const { setTheme } = useTheme();

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (mode !== "follow" || isHostWindow()) return;

    let live = true;
    let inFlight = false;

    const ask = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const answer = await api.appearance();
        if (!live) return;
        if (decideFollow({ mode: "follow", isHost: false, applied: readAppliedStamp(), answer }) !== "apply") return;
        const published = answer.appearance!;
        // WHAT THE WEAR COST IS PARKED, NOT DROPPED (#705). This line used to
        // be a bare `applyLook(...)` that discarded the return value, on the
        // grounds that a remote window has nobody to tell — which made an
        // automatically-worn Look the one path where "this look's card leaves
        // the tints unreadable" could happen with nothing anywhere saying so.
        // `wearPublication` is that wear plus the parking, and it lives in
        // lib/host-follow.ts with the rest of the follow protocol so the rule
        // is a unit test rather than a second machine.
        wearPublication(published.look, setAppearance);
        setTheme(published.scheme);
        writeAppliedStamp(answer.updatedAt);
      } catch {
        // An engine that is down, locked, or unpaired costs this window
        // nothing. The next tick asks again.
      } finally {
        inFlight = false;
      }
    };

    void ask();
    const timer = window.setInterval(() => void ask(), POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void ask();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      live = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // The effect re-arms only when following starts or stops: the wear writes
    // the composition store directly rather than through anything this
    // component renders, so there is nothing else here that could go stale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  return null;
}
