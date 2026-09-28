"use client";

/**
 * A remote window wears the host's published look until its person customises anything, then
 * detaches. The host never follows (lib/host-window.ts is the gate). Stamps, not content, decide.
 */

import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { Look } from "@telar/engine-client";
import { applyLook, type LookAppearance } from "./looks";

export type FollowMode = "follow" | "detached";

const MODE_KEY = "telar-follow-host";
const STAMP_KEY = "telar-host-look-applied";
const NOTICE_KEY = "telar-host-look-notice";

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

function readFollowMode(): FollowMode {
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
 /** Call from every user-driven appearance write, never the follower's own. */
export function detachFromHost(): void {
  if (readFollowMode() === "detached") return;
  writeFollowMode("detached");
}

function followHostAgain(): void {
  // Forget the stamp so "follow again" re-wears the current publication.
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
 * What the last automatic wear could not apply, parked for the Appearance pane rather than
 * toasted. Cleared when a wear reports nothing.
 */
export function readFollowNotice(): string | undefined {
  try {
    return window.localStorage.getItem(NOTICE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function writeFollowNotice(notice: string | undefined): void {
  if (readFollowNotice() === notice) return;
  try {
    if (notice === undefined) window.localStorage.removeItem(NOTICE_KEY);
    else window.localStorage.setItem(NOTICE_KEY, notice);
  } catch {
    // Private browsing: the listeners still carry it for this session.
  }
  notify();
}

export function useFollowNotice(): string | undefined {
  return useSyncExternalStore(subscribe, readFollowNotice, () => undefined);
}

/** `applyLook` exactly as Apply would, parking its message; `undefined` clears the last one. */
export function wearPublication(look: Look, setAppearance: (patch: LookAppearance) => void): void {
  writeFollowNotice(applyLook(look, setAppearance));
}

/** Whether a fetched publication should be worn now. Pure, so it is unit-testable. */
export function decideFollow(input: {
  mode: FollowMode;
  isHost: boolean;
  applied: number | null;
  /** `updatedAt` is null when nothing is published; `appearance` is null when it did not parse. */
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
