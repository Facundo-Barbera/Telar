"use client";

/**
 * THE RAIL'S REMOTE CONTROL — `docs/spool-loops.md` §13.2's floor plan.
 *
 * WHY THIS FILE EXISTS AND IS NOT A REACT CONTEXT. The Spool's left rail is
 * the app sidebar's body when the pathname says so (see
 * `components/spool/warehouse-nav.tsx`), which makes it a SIBLING of
 * `SpoolStance` in the tree, not a descendant: `AppSidebar` sits beside
 * `{children}` in `AppShell`, never inside it. A context provider mounted by
 * either one could not reach the other.
 *
 * §13's re-entry machine has ONE navigation fact — which ROOM is open — and
 * this file is where `SpoolStance` (which owns it) publishes it for the
 * rail to read and drive. The rail is FLOOR PLAN ONLY now: every click GOES
 * to a room, never sets a filter or a lane or a tag — those live inside a
 * subject's room, transient and local to its Tasks tab, and never ride this
 * shared slot.
 *
 * `useSyncExternalStore`, not `useState` here: the store's true home is the
 * module scope (so it survives the sidebar and the room mounting and
 * unmounting independently across a navigation), and this hook is React's
 * own sanctioned way to subscribe a component to state that lives outside
 * it — no polling, no `localStorage`, the same fork-ban the aperture slot's
 * law already spells.
 */
import { useSyncExternalStore } from "react";
import type { SpoolSearchHit } from "@telar/engine-client";

/** The floor plan's five destinations — §13.2. Navigation IS state here
 *  (the room never has its own route; `/spool` is the only URL), and this
 *  is the one shape every surface — rail, room, chat's context line —
 *  agrees on. */
export type SpoolRoomState =
  | { kind: "lobby" }
  | { kind: "today" }
  | { kind: "scheduled" }
  | { kind: "subject"; key: string }
  /**
   * THE ASSISTANT'S ROOM — `docs/spool-loops.md` §13.6, "the assistant's two
   * doors." The conversation's other home: full-width, wide-scoped, reached
   * by its own rail entry or by expanding the summoned layer. Not a subject
   * and not a day — it carries no `key`, the same shape `lobby` has.
   */
  | { kind: "assistant" }
  /**
   * AN AREA PAGE — `docs/spool-loops.md` §13.8, 2026-08-19: "the map is
   * content, not chrome." Walking into a container from the lobby (or
   * another area page's own children) opens that subtree here, with a
   * breadcrumb back out. `path` is the SAME joined-path string
   * `lib/spool-area-tree.ts` already builds nodes from — no second area
   * identity, just which node this screen is scoped to.
   *
   * THE WAREHOUSE IS GONE (§13.8). It used to sit here as a sixth room —
   * hand-management, distinct from the Lobby and a subject's room — but the
   * Lobby's own structure gestures (drag, rename, ceiling) already covered
   * Areas, and Subjects duplicated each room's own About tab. Its Lanes and
   * Tags tabs, and its Done archive, have no wave-1 replacement — named
   * omissions, not silent drops; see the room's own report. Its Connections
   * card moved to the Assistant room's own foot (`master-chat.tsx`).
   */
  | { kind: "area"; path: string };

/** One subject's line in the rail's Areas tree — identity (area, color)
 *  plus the one honest count the tree is allowed: what needs the user, on
 *  this subject alone. Never an urgency computation. */
export type SpoolRoomAreaLine = {
  subject: string;
  needs: number;
  area?: string;
  color?: string;
  /**
   * THE USER'S HAND-ORDER WITHIN AN AREA — the rail's drag-to-reorder pass
   * (2026-08-18). Absent means "no order stated yet"; the rail sorts ranked
   * subjects ascending and lets unranked ones trail after, never inventing a
   * position for a subject nobody has dragged. Joined from `SpoolSubject.rank`
   * the same way `area`/`color` already are — identity the human placed by
   * hand, never a computed urgency.
   */
  rank?: number;
};

export type SpoolRoomSnapshot = {
  /** False until `SpoolStance` has mounted and published at least once. The
   *  rail renders its quiet unopened shape until then — never a spinner,
   *  never a badge, an absence like every other Spool surface's. */
  ready: boolean;
  room: SpoolRoomState;
  areas: SpoolRoomAreaLine[];
};

export type SpoolRoomControls = {
  goLobby: () => void;
  goToday: () => void;
  goScheduled: () => void;
  goSubject: (key: string) => void;
  /** §13.6's other door into the same room the layer's expand control opens. */
  goAssistant: () => void;
  /** WALK INTO A CONTAINER — §13.8. The rail no longer carries the tree
   *  (it lives in the Lobby's own content pane now), so the rail itself
   *  never calls this; it exists on the published controls so any future
   *  rail affordance (or a search hit naming an area) could reach it without
   *  a second store. */
  goArea: (path: string) => void;
  openSearchHit: (hit: SpoolSearchHit) => void;
  /**
   * REFETCH THE ROOM'S ONE SNAPSHOT — added for the rail's drag-to-file pass
   * (assigning a subject's area by dropping it on an Areas header). The rail
   * writes through the SAME identity route `tray.tsx`'s subject face does,
   * but it holds no copy of the snapshot to patch optimistically — `areas`
   * above is derived data `SpoolStance` computes from its own read, and the
   * rail is a SIBLING that cannot reach into that component's state. This is
   * `SpoolStance`'s own `load`, republished so a write anywhere the rail can
   * reach — not just inside the stance's descendants — can ask for the same
   * reload every other mutation in the room already triggers via `onChanged`.
   */
  refresh: () => void;
};

const EMPTY_SNAPSHOT: SpoolRoomSnapshot = {
  ready: false,
  room: { kind: "lobby" },
  areas: [],
};

const noop = () => undefined;
const EMPTY_CONTROLS: SpoolRoomControls = {
  goLobby: noop,
  goToday: noop,
  goScheduled: noop,
  goSubject: noop,
  goAssistant: noop,
  goArea: noop,
  openSearchHit: noop,
  refresh: noop,
};

let snapshot: SpoolRoomSnapshot = EMPTY_SNAPSHOT;
let controls: SpoolRoomControls = EMPTY_CONTROLS;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Called by `SpoolStance` itself, once per render, after the derivation the
 *  room already computes — never a second fetch, never a second `useState`. */
export function publishSpoolRoom(next: SpoolRoomSnapshot, nextControls: SpoolRoomControls) {
  snapshot = next;
  controls = nextControls;
  emit();
}

/** Reset to the unopened shape — called when the room unmounts, so a stale
 *  room from a PREVIOUS visit to `/spool` never outlives it. */
export function clearSpoolRoom() {
  snapshot = EMPTY_SNAPSHOT;
  controls = EMPTY_CONTROLS;
  emit();
}

/** Stable getter functions, not inline closures: `useSyncExternalStore`
 *  compares the SNAPSHOT they return by reference on every render, so the
 *  getter itself being a fresh arrow each call is fine, but the value it
 *  returns must be referentially stable when nothing published — otherwise
 *  React sees a "changed" snapshot on every render and loops. `snapshot` and
 *  `controls` are already module-scope lets that only change inside
 *  `publishSpoolRoom`/`clearSpoolRoom`, so reading them fresh each call is
 *  safe. The third argument below is `getServerSnapshot`: on the server
 *  there is no subscription and no `SpoolStance` to publish, so this must
 *  return the SAME `EMPTY_SNAPSHOT`/`EMPTY_CONTROLS` constant every call
 *  (not a freshly-built object) or hydration sees a snapshot mismatch. */
export function useSpoolRoom(): SpoolRoomSnapshot {
  return useSyncExternalStore(subscribe, () => snapshot, () => EMPTY_SNAPSHOT);
}

export function useSpoolRoomControls(): SpoolRoomControls {
  return useSyncExternalStore(subscribe, () => controls, () => EMPTY_CONTROLS);
}
