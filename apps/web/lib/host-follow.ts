"use client";

/**
 * FOLLOWING THE HOST'S LOOK — the read side of appearance-publisher.tsx.
 *
 * WHY A REMOTE WINDOW FOLLOWS AT ALL. A browser reached over the tailnet is
 * the same app with its own localStorage, so it opens with the default
 * palette while the machine it is driving wears something deliberate. The
 * host publishes its resolved look to the engine (`/api/appearance`); until
 * now the only thing that read it was a Settings card that had to be opened
 * and applied by hand. A remote window now WEARS it, and keeps wearing it as
 * the host changes.
 *
 * UNTIL YOU CUSTOMISE. The moment this window's person changes anything on the
 * Appearance pane — wears a look, picks a theme, moves the scheme — the window
 * DETACHES and keeps its own taste from then on. Somebody else's look is a
 * default, not a command; the Settings row offers "follow again" for when that
 * is wanted. Detached is the sticky state, spelled explicitly, because a store
 * that only remembered "following" could not tell a fresh window (follow) from
 * one that had chosen (leave alone).
 *
 * THE HOST NEVER FOLLOWS. A host window following its own publication would be
 * a loop with a two-second delay, and the packaged desktop shell browsing
 * another Mac's sessions is still a host — nothing here is ever forced onto
 * another desktop app. lib/host-window.ts is the one gate, shared with the
 * publisher, so the two can never disagree about which window is which.
 *
 * THE STAMP is the engine's `updatedAt` for the last publication this window
 * applied. Comparing stamps rather than content keeps the poll cheap and keeps
 * an unchanged publication from re-applying on every tick — an apply writes
 * four stores and rebuilds the theme stylesheet, which is not free.
 */

import { useCallback, useMemo, useSyncExternalStore } from "react";

export type FollowMode = "follow" | "detached";

const MODE_KEY = "telar-follow-host";
const STAMP_KEY = "telar-host-look-applied";

const listeners = new Set<() => void>();

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  window.addEventListener("storage", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

function notify(): void {
  for (const listener of listeners) listener();
}

export function parseFollowMode(raw: string | null): FollowMode {
  return raw === "detached" ? "detached" : "follow";
}

export function readFollowMode(): FollowMode {
  try {
    return parseFollowMode(window.localStorage.getItem(MODE_KEY));
  } catch {
    return "follow";
  }
}

function writeFollowMode(mode: FollowMode): void {
  try {
    window.localStorage.setItem(MODE_KEY, mode);
  } catch {
    // Private browsing: the choice holds for this session via the listeners.
  }
  notify();
}

/**
 * Called by every USER-DRIVEN appearance write — Apply, Wear, a theme picked
 * from the library, the scheme control, the translucency toggles. Not by the
 * follower's own writes, which would detach the window from itself.
 *
 * A no-op on the host, so the host's Settings pane never accumulates a
 * "detached" it has no way to see or clear.
 */
export function detachFromHost(): void {
  if (readFollowMode() === "detached") return;
  writeFollowMode("detached");
}

export function followHostAgain(): void {
  // Forget the stamp too: "follow again" must wear the current publication
  // even when it is the same one this window applied before detaching.
  writeAppliedStamp(null);
  writeFollowMode("follow");
}

export function readAppliedStamp(): number | null {
  try {
    const raw = window.localStorage.getItem(STAMP_KEY);
    const stamp = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(stamp) ? stamp : null;
  } catch {
    return null;
  }
}

export function writeAppliedStamp(stamp: number | null): void {
  try {
    if (stamp === null) window.localStorage.removeItem(STAMP_KEY);
    else window.localStorage.setItem(STAMP_KEY, String(stamp));
  } catch {
    // Lost persistence means one redundant apply after reload. Harmless.
  }
}

/**
 * THE DECISION, PURE. Whether a fetched publication should be worn by this
 * window right now. Kept free of React and of the window so the rules are a
 * unit test rather than a manual one on a second machine.
 */
export function decideFollow(input: {
  mode: FollowMode;
  isHost: boolean;
  applied: number | null;
  /** The engine's answer: `updatedAt` is null when nothing is published, and
   *  `appearance` is null when what was published did not parse. */
  answer: { updatedAt: number | null; appearance: unknown | null };
}): "apply" | "skip" {
  if (input.isHost) return "skip";
  if (input.mode !== "follow") return "skip";
  if (input.answer.updatedAt === null || input.answer.appearance === null) return "skip";
  if (input.applied === input.answer.updatedAt) return "skip";
  return "apply";
}

export function useFollowHost(): { mode: FollowMode; detach: () => void; follow: () => void } {
  const mode = useSyncExternalStore(subscribe, readFollowMode, () => "follow" as const);
  const detach = useCallback(() => detachFromHost(), []);
  const follow = useCallback(() => followHostAgain(), []);
  return useMemo(() => ({ mode, detach, follow }), [mode, detach, follow]);
}
