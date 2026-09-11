/**
 * SINGLE SOURCE FOR THE PER-SESSION ACTION MENU.
 *
 * The rail row's `⋯`, the rail row's right-click menu and the cockpit header's
 * title menu all render exactly this list, so labels, ordering and capability
 * gating cannot drift between the three surfaces. Ported in spirit from t3
 * code's `threadActionMenu.logic.ts`, whose own comment says the same thing
 * about two surfaces; Telar has three, which is the argument rather than
 * against it.
 *
 * WHY A DEFINITION AND NOT A COMPONENT. The menu is a list of decisions —
 * which verbs exist, in what order, and when each one is refused — and every
 * one of those is answerable without a DOM. Keeping them here means the rules
 * are testable in a file that imports no React, and it means the header menu
 * could not quietly grow a verb the row menu lacks: there is one array, and
 * both surfaces map over it.
 *
 * ══ WHAT A SURFACE STILL OWNS ══
 *
 * Chrome, not content. Which primitive draws it (a dropdown, a context menu),
 * which icon a token maps to, and what "busy" looks like while a verb is in
 * flight. `run` is a plain callback the caller supplied — this module never
 * fetches, never navigates and never touches `window`, which is what keeps it
 * pure.
 *
 * ══ FIVE DECISIONS WORTH NAMING ══
 *
 *   - CAPABILITY-GATED, AND DISABLED-WITH-A-REASON BEATS FAILING LATER. Delete
 *     is refused by the engine on a session with a turn in flight
 *     (`EngineStore.deleteSession`: "session has an active turn; stop it before
 *     deleting"), so it is disabled HERE with that reason rather than offered
 *     and then rejected. Same for settling a session that is waiting on you —
 *     `canSettle` already refuses it, so the button would appear to do nothing.
 *   - TOGGLES SWAP IN PLACE. Pin/Unpin, Settle/Un-settle and Snooze/Wake are
 *     ONE row each that knows the current state, never both. `kind: "toggle"`
 *     marks them so a surface can style the pair consistently.
 *   - ONLY `delete` IS `destructive`. The eye should land on it last and on
 *     purpose.
 *   - ARCHIVE AND MARK-UNREAD ARE NOT HERE, and their absence is a decision
 *     rather than an omission — see the header of
 *     `components/session/session-inbox-menu.tsx` for both arguments. Nothing
 *     in this file should be read as a place to put them back.
 *   - `Regenerate title` IS NOT HERE EITHER, for a duller reason: the engine
 *     re-titles a session from inside `maybeRetitleSession`, called when a turn
 *     is accepted, and exposes no route to ask for another one. There is
 *     nothing for a menu item to call. The survey lists it as its own change
 *     (#11), behind an engine endpoint.
 *
 * ══ WHAT "CAPABILITY" MEANS HERE ══
 *
 * The row menu this replaces gated on `session.archived`, on `canSnooze` and
 * on which way `settledOverride` points — and on nothing else. It did not read
 * the driver, the env mode or the host, because no verb it offered differed by
 * any of them. The new items do: a branch is a worktree session's own
 * (`SessionWorkspace`), and per-project settings have no `/hosts/:id/…` route,
 * so a remote session cannot open them from this Mac. Those are the two
 * capabilities that earned a field; `driver` did not, and inventing a flag no
 * item reads would be a gate that documents nothing.
 */

import { canSettle, canSnooze, isSnoozed, snoozePresets, wakeLabel, type SettlingActivity } from "@/lib/session-settling";

/**
 * An icon TOKEN rather than a component, so this module stays free of React
 * and of lucide. Each surface maps the token to whatever it already draws.
 */
export type SessionActionIcon =
  | "new-session"
  | "pin"
  | "unpin"
  | "settle"
  | "unsettle"
  | "snooze"
  | "wake"
  | "rename"
  | "copy"
  | "project-settings"
  | "delete";

export type SessionActionItem = {
  /** Stable across the toggle: `pin` is `pin` whether it reads Pin or Unpin,
   *  so a test — and a surface's `key` — can follow one row through a swap. */
  id: string;
  label: string;
  /** Draw a hairline above this item. The groups are separator-delimited
   *  rather than nested, because a menu is a list and a surface should not
   *  have to flatten one to render it. */
  separatorBefore?: boolean;
  destructive?: boolean;
  /** WHY it cannot be done, or `false` when it can. A reason rather than a
   *  boolean: a disabled row that does not say why is a dead end, and the
   *  surface can put this in a title attribute for nothing. */
  disabled?: string | false;
  /** One row that swaps in place with its opposite — see the header. */
  kind?: "toggle";
  icon?: SessionActionIcon;
  /** The right-hand column: a resolved snooze time, a wake countdown. It
   *  COMPLEMENTS the label rather than repeating it — see `SnoozePreset`. */
  detail?: string;
  /** A submenu. An item has children or a `run`, never both. */
  children?: readonly SessionActionItem[];
  run?: () => void;
};

/**
 * ONLY WHAT THE MENU READS, rather than the engine's `Session` or the rail's
 * `SidebarSession`. The two surfaces hold different shapes — the cockpit has
 * the record, the rail has a flattened projection — and naming the nine fields
 * this actually needs lets both satisfy it without a conversion. The same
 * argument `SettleableSession` makes in `session-settling.ts`, for the same
 * reason.
 */
export type SessionActionTarget = {
  id: string;
  title: string;
  /** Absent on the Spool's master chat, which belongs to no project — so the
   *  two items that need one say so rather than building a `/projects/undefined`
   *  URL. */
  projectId?: string;
  /** For the label. Falls back to "this project" when the project list has not
   *  landed: an opaque `project_1a16…` is addressing, not a name. */
  projectName?: string;
  /** Which Mac. Absent for the local engine. */
  hostId?: string;
  workspacePath: string;
  /**
   * THE SESSION'S OWN BRANCH, which only a worktree session has. A local
   * session runs on the project's checkout, where the branch is a property of
   * the checkout rather than of the conversation (see `Project.branch`) — so
   * naming it here would attribute somebody else's HEAD to this session.
   */
  branch?: string;
  settledOverride?: "settled" | "active";
  snoozedUntil?: number;
  snoozedAt?: number;
  /** The conversation is over — `Session.state === "archived"`. */
  archived: boolean;
  /** Not read by any item. It is here because `isSnoozed` takes a whole
   *  `SettleableSession`, and satisfying that contract with the caller's own
   *  record is cheaper than minting a second projection to hide one field. */
  updatedAt: number;
};

export type SessionActionCapabilities = {
  /** On another Mac. Per-project settings are a local-only route. */
  remote?: boolean;
  /** Observe mode: the title is a fact, not a field, and nothing here writes. */
  readOnly?: boolean;
};

/**
 * What each verb actually does, injected. Every one of these is a side effect
 * — a PATCH, a navigation, a clipboard write — and none of them belongs in a
 * module whose whole value is that it can be tested without a browser.
 */
export type SessionActionHandlers = {
  /** `baseRef` is this session's branch, so the new worktree is cut from where
   *  this one works. Absent for a local session, which has none. */
  newSession: (input: { projectId: string; hostId?: string; baseRef?: string }) => void;
  /** `true` pins the session to the list (`settledOverride: "active"`),
   *  `false` clears the pin. */
  pin: (pinned: boolean) => void;
  settle: (settled: boolean) => void;
  /** `null` wakes it now. */
  snooze: (until: number | null) => void;
  rename: () => void;
  copy: (text: string) => void;
  projectSettings: (input: { projectId: string }) => void;
  /** The two-step confirmation lives in the surface, where the person is. */
  remove: () => void;
};

export type SessionActionMenuState = {
  session: SessionActionTarget;
  /** What the list knows this session is doing right now — see
   *  `settlingActivity` in `lib/session-list.ts`, which folds it once. */
  activity: SettlingActivity;
  /** ONE STAMP FOR THE WHOLE MENU, passed in rather than read here. Two items
   *  reading their own `Date.now()` would resolve "In 1 hour" and the wake
   *  countdown against different clocks in the same paint. */
  now: number;
  capabilities?: SessionActionCapabilities;
  actions: SessionActionHandlers;
};

/** Kept as prose in one place so two items cannot word the same refusal twice. */
const NO_PROJECT = "This session belongs to no project.";
const OBSERVING = "This session is being observed, not driven.";
const ARCHIVED = "This conversation is over.";
const WAITING = "Something here is waiting on you.";
const RUNNING_DELETE = "A turn is running. Stop it before deleting.";
const WAITING_DELETE = "A request here is waiting on you. Answer or stop it first.";
const REMOTE_SETTINGS = "Project settings open on the Mac that owns the project.";

/**
 * THE MENU, IN FIVE SEPARATOR-DELIMITED GROUPS.
 *
 * Pure: same state in, same list out, no clocks and no globals. The order is
 * the decision this function exists to hold, so read it top to bottom —
 * everything below is the same five groups in the same order the survey names
 * them.
 */
export function buildSessionActionMenuItems(state: SessionActionMenuState): SessionActionItem[] {
  const { session, activity, now, actions } = state;
  const { remote = false, readOnly = false } = state.capabilities ?? {};
  const items: SessionActionItem[] = [];

  /* ── 1. Another one of these ──────────────────────────────────────────── */

  /**
   * THE LABEL NAMES WHERE IT WILL RUN. t3's crumb is "another one of these"
   * rather than navigation, and the branch in the label is what makes that
   * claim checkable: a worktree session's new sibling is cut from this
   * session's branch, a local one's simply opens the project's canvas.
   */
  const projectId = session.projectId;
  const newSessionLabel = session.branch
    ? `New session on ${session.branch}`
    : `New session in ${session.projectName ?? "this project"}`;
  items.push({
    id: "new-session",
    label: newSessionLabel,
    icon: "new-session",
    disabled: !projectId && NO_PROJECT,
    run: () =>
      projectId &&
      actions.newSession({
        projectId,
        ...(session.hostId ? { hostId: session.hostId } : {}),
        ...(session.branch ? { baseRef: session.branch } : {}),
      }),
  });

  /* ── 2. The inbox verbs ───────────────────────────────────────────────── */

  /**
   * THE WHOLE GROUP IS ABSENT ON AN ARCHIVED SESSION, which is what the row
   * menu already did. Pinning, settling and snoozing are all about the LIST,
   * and an archived session is off it by a decision that outranks every one of
   * them (`isSettled` returns true for one before it reads any override). Three
   * rows that could only ever be inert are worse than none.
   */
  if (!session.archived) {
    const pinned = session.settledOverride === "active";
    items.push({
      id: "pin",
      /**
       * THE PIN, WHICH IS THE HALF PEOPLE FORGET TO BUILD. Settling gets a row
       * out of the way; this keeps one the clock would otherwise take away.
       */
      label: pinned ? "Unpin" : "Pin to the list",
      icon: pinned ? "unpin" : "pin",
      kind: "toggle",
      separatorBefore: true,
      disabled: readOnly && OBSERVING,
      run: () => actions.pin(!pinned),
    });

    const settled = session.settledOverride === "settled";
    items.push({
      id: "settle",
      label: settled ? "Un-settle" : "Settle",
      icon: settled ? "unsettle" : "settle",
      kind: "toggle",
      /**
       * ONLY THE SETTLING DIRECTION IS GATED. `canSettle` refuses a session
       * that is working or waiting on you — deliberately the same list
       * `isSettled` refuses to classify on, so offering it would produce a
       * button that appears broken. Coming BACK from settled is always allowed:
       * the refusal is about shelving a session someone still needs.
       */
      disabled: (readOnly && OBSERVING) || (settled ? false : settleRefusal(activity)),
      run: () => actions.settle(!settled),
    });

    const snoozing = isSnoozed(session, activity, { now });
    if (snoozing) {
      items.push({
        id: "snooze",
        label: "Wake now",
        icon: "wake",
        kind: "toggle",
        detail: wakeLabel(session.snoozedUntil!, now),
        disabled: readOnly && OBSERVING,
        run: () => actions.snooze(null),
      });
    } else {
      /**
       * THE REFUSAL SITS ON THE PARENT, not on each preset. A submenu whose
       * five rows are all inert for one reason should not be opened to learn
       * it; disabling the row that would open it says the same thing one
       * gesture earlier. `canSnooze` is the looser guard of the two — a RUNNING
       * session is snoozable, because snoozing only changes what you are shown.
       */
      items.push({
        id: "snooze",
        label: "Snooze",
        icon: "snooze",
        kind: "toggle",
        disabled: (readOnly && OBSERVING) || (!canSnooze(activity) && WAITING),
        // Presets rather than a picker: the point of a snooze is that it costs
        // one gesture. Resolved against `now`, so "In 1 hour" is an hour from
        // the paint that built this list.
        children: snoozePresets(new Date(now)).map((preset) => ({
          id: `snooze-${preset.id}`,
          label: preset.label,
          icon: "snooze" as const,
          detail: preset.when,
          run: () => actions.snooze(preset.until),
        })),
      });
    }
  }

  /* ── 3. The name ──────────────────────────────────────────────────────── */

  items.push({
    id: "rename",
    label: "Rename",
    icon: "rename",
    separatorBefore: true,
    disabled: (readOnly && OBSERVING) || (session.archived && ARCHIVED),
    run: actions.rename,
  });

  /* ── 4. Facts about it, and where it is configured ────────────────────── */

  /**
   * COPY IS A SUBMENU BECAUSE THREE ROWS OF "Copy X" IS THE MENU. The path and
   * the id are always there; the branch only when the session has one of its
   * own, for the reason `SessionActionTarget.branch` states.
   */
  const copies: SessionActionItem[] = [
    { id: "copy-path", label: "Path", icon: "copy", run: () => actions.copy(session.workspacePath) },
    ...(session.branch ? [{ id: "copy-branch", label: "Branch", icon: "copy" as const, run: () => actions.copy(session.branch!) }] : []),
    { id: "copy-id", label: "Session ID", icon: "copy", run: () => actions.copy(session.id) },
  ];
  items.push({ id: "copy", label: "Copy", icon: "copy", separatorBefore: true, children: copies });

  /**
   * ONE CONSISTENT GESTURE FOR "this also has a per-project override", instead
   * of duplicating the setting in two places. Local-only: there is no
   * `/hosts/:id/projects/:id/settings` route, and sending someone to this
   * Mac's page for another Mac's project would show them the wrong project's
   * settings rather than nothing.
   */
  items.push({
    id: "project-settings",
    label: "Project settings",
    icon: "project-settings",
    disabled: (!projectId && NO_PROJECT) || (remote && REMOTE_SETTINGS),
    run: () => projectId && actions.projectSettings({ projectId }),
  });

  /* ── 5. The end of the lifecycle ──────────────────────────────────────── */

  /**
   * DELETE IS DISABLED WHILE A TURN IS IN FLIGHT, because the engine refuses
   * it there — `EngineStore.deleteSession` throws a conflict on any turn that
   * is queued, claimed or running, since deleting under one also removes the
   * journal a live provider process is still appending to. A blocked session
   * counts: an open request only blocks while its turn can still take the
   * answer, so a session reporting `waitingOnYou` has exactly such a turn.
   * Both are stated as their own reason rather than folded into one, because
   * "stop it" and "answer it" are different things to go and do.
   */
  items.push({
    id: "delete",
    label: "Delete session",
    icon: "delete",
    separatorBefore: true,
    destructive: true,
    disabled:
      (readOnly && OBSERVING) || (activity.working && RUNNING_DELETE) || (activity.waitingOnYou && WAITING_DELETE),
    run: actions.remove,
  });

  return items;
}

/**
 * `canSettle` with its refusal spelled out. The rule itself stays in
 * `session-settling.ts` — this only decides which of its two clauses to say,
 * so a reader learns whether to stop the work or answer the question.
 */
function settleRefusal(activity: SettlingActivity): string | false {
  // `canSettle` stays authoritative rather than being restated as two clauses
  // here: a rule copied into a label is a rule that drifts from the one the
  // list actually applies.
  if (canSettle(activity)) return false;
  return activity.waitingOnYou ? WAITING : "A turn is running here.";
}
