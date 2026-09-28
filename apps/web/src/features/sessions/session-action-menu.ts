
import { sessionHref } from "./session-list";
import { canSettle, canSnooze, isSnoozed, settleClosesText, snoozePresets, wakeLabel, type SettlingActivity } from "./session-settling";

export type SessionActionIcon =
  | "open"
  | "new-window"
  | "new-session"
  | "pin"
  | "unpin"
  | "settle"
  | "unsettle"
  | "terminal"
  | "snooze"
  | "wake"
  | "rename"
  | "regenerate"
  | "copy"
  | "project-settings"
  | "delete";

export type SessionActionItem = {
  id: string;
  label: string;
  separatorBefore?: boolean;
  destructive?: boolean;
  disabled?: string | false;
  kind?: "toggle";
  icon?: SessionActionIcon;
  detail?: string;
  children?: readonly SessionActionItem[];
  run?: () => void;
};

export type SessionActionTarget = {
  id: string;
  title: string;
  projectId?: string;
  projectName?: string;
  hostId?: string;
  workspacePath?: string;
  branch?: string;
  settledOverride?: "settled" | "active";
  settled?: boolean;
  snoozedUntil?: number;
  snoozedAt?: number;
  terminals?: number;
  archived: boolean;
  updatedAt: number;
};

type SessionActionCapabilities = {
  remote?: boolean;
  current?: boolean;
};

export type SessionActionHandlers = {
  open: (href: string) => void;
  copyLink: (href: string) => void;
  openWindow?: (href: string) => void;
  newSession: (input: { projectId: string; hostId?: string; baseRef?: string }) => void;
  pin: (pinned: boolean) => void;
  settle: (settled: boolean) => void;
  closeTerminals?: () => void;
  snooze: (until: number | null) => void;
  rename: () => void;
  regenerateTitle: () => void;
  copy: (text: string) => void;
  projectSettings: (input: { projectId: string }) => void;
  remove: () => void;
};

export type SessionActionMenuState = {
  session: SessionActionTarget;
  activity: SettlingActivity;
  now: number;
  capabilities?: SessionActionCapabilities;
  actions: SessionActionHandlers;
};

const NO_PROJECT = "This session belongs to no project.";
const ARCHIVED = "This conversation is over.";
const WAITING = "Something here is waiting on you.";
const RUNNING_DELETE = "A turn is running. Stop it before deleting.";
const WAITING_DELETE = "A request here is waiting on you. Answer or stop it first.";
const REMOTE_SETTINGS = "Project settings open on the Mac that owns the project.";
const ALREADY_OPEN = "You are already reading this one.";

function titleItems(session: SessionActionTarget, actions: SessionActionHandlers): SessionActionItem[] {
  const disabled = session.archived && ARCHIVED;
  return [
    { id: "rename", label: "Rename", icon: "rename", separatorBefore: true, disabled, run: actions.rename },
    { id: "regenerate-title", label: "Regenerate title", icon: "regenerate", disabled, run: actions.regenerateTitle },
  ];
}

export function buildSessionActionMenuItems(state: SessionActionMenuState): SessionActionItem[] {
  const { session, activity, now, actions } = state;
  const { remote = false, current = false } = state.capabilities ?? {};
  const items: SessionActionItem[] = [];

  const href = sessionHref(session);
  items.push({
    id: "open",
    label: "Open",
    icon: "open",
    disabled: current && ALREADY_OPEN,
    run: () => !current && actions.open(href),
  });

  if (actions.openWindow) {
    const openWindow = actions.openWindow;
    items.push({
      id: "open-window",
      label: "Open in a new window",
      icon: "new-window",
      run: () => openWindow(href),
    });
  }

  const projectId = session.projectId;
  const newSessionLabel = session.branch
    ? `New session on ${session.branch}`
    : `New session in ${session.projectName ?? "this project"}`;
  items.push({
    id: "new-session",
    label: newSessionLabel,
    icon: "new-session",
    separatorBefore: true,
    disabled: !projectId && NO_PROJECT,
    run: () =>
      projectId &&
      actions.newSession({
        projectId,
        ...(session.hostId ? { hostId: session.hostId } : {}),
        ...(session.branch ? { baseRef: session.branch } : {}),
      }),
  });

  if (!session.archived) {
    const pinned = session.settledOverride === "active";
    items.push({
      id: "pin",
      label: pinned ? "Unpin" : "Pin to the list",
      icon: pinned ? "unpin" : "pin",
      kind: "toggle",
      separatorBefore: true,
      run: () => actions.pin(!pinned),
    });

    const settled = session.settled ?? session.settledOverride === "settled";
    const closes = settled ? undefined : settleClosesText(session.terminals);
    items.push({
      id: "settle",
      label: settled ? "Un-settle" : "Settle",
      icon: settled ? "unsettle" : "settle",
      kind: "toggle",
      disabled: settled ? false : settleRefusal(activity),
      ...(closes ? { detail: closes } : {}),
      run: () => actions.settle(!settled),
    });

    const terminals = session.terminals ?? 0;
    if (settled && terminals > 0 && actions.closeTerminals) {
      const closeTerminals = actions.closeTerminals;
      items.push({
        id: "close-terminals",
        label: terminals === 1 ? "Close its terminal" : `Close its ${terminals} terminals`,
        icon: "terminal",
        run: closeTerminals,
      });
    }

    const snoozing = isSnoozed(session, activity, { now });
    if (snoozing) {
      items.push({
        id: "snooze",
        label: "Wake now",
        icon: "wake",
        kind: "toggle",
        detail: wakeLabel(session.snoozedUntil!, now),
        run: () => actions.snooze(null),
      });
    } else {
      items.push({
        id: "snooze",
        label: "Snooze",
        icon: "snooze",
        kind: "toggle",
        disabled: !canSnooze(activity) && WAITING,
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

  items.push(...titleItems(session, actions));

  const copies: SessionActionItem[] = [
    { id: "copy-link", label: "Link", icon: "copy", run: () => actions.copyLink(href) },
    ...(session.workspacePath
      ? [{ id: "copy-path", label: "Path", icon: "copy" as const, run: () => actions.copy(session.workspacePath!) }]
      : []),
    ...(session.branch ? [{ id: "copy-branch", label: "Branch", icon: "copy" as const, run: () => actions.copy(session.branch!) }] : []),
    { id: "copy-id", label: "Session ID", icon: "copy", run: () => actions.copy(session.id) },
  ];
  items.push({ id: "copy", label: "Copy", icon: "copy", separatorBefore: true, children: copies });

  items.push({
    id: "project-settings",
    label: "Project settings",
    icon: "project-settings",
    disabled: (!projectId && NO_PROJECT) || (remote && REMOTE_SETTINGS),
    run: () => projectId && actions.projectSettings({ projectId }),
  });

  items.push({
    id: "delete",
    label: "Delete session",
    icon: "delete",
    separatorBefore: true,
    destructive: true,
    disabled: (activity.working && RUNNING_DELETE) || (activity.waitingOnYou && WAITING_DELETE),
    run: actions.remove,
  });

  return items;
}

function settleRefusal(activity: SettlingActivity): string | false {
  if (canSettle(activity)) return false;
  return activity.waitingOnYou ? WAITING : "A turn is running here.";
}
