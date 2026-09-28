import type { LiveSessionRow } from "@telar/engine-client";
import { createEngineApi } from "@/platform/engine";
import { hostFetcher, LOCAL_HOST_ID } from "@/platform/engine/host-client";
import { sessionKey, toSidebarSession, type SidebarSession } from "./session-list";

export type SessionRowChange =
  | { row: SidebarSession }
  | { removed: string };

export type SessionRowChanged = (change: SessionRowChange) => void;

export function patchedRow(row: SidebarSession, answered: LiveSessionRow): SidebarSession {
  return toSidebarSession(
    answered,
    row.projectName,
    row.projectBranch,
    row.projectIcon,
    row.hostId === undefined ? undefined : { id: row.hostId, name: row.hostName ?? row.hostId },
    row.assignments,
    row.projectRemote,
    row.projectIconName,
    row.settledForTitle,
    row.projectAvailability,
    row.terminals,
  );
}

export function applyRowChange(rows: readonly SidebarSession[], change: SessionRowChange): SidebarSession[] {
  if ("removed" in change) return rows.filter((row) => sessionKey(row) !== change.removed);
  const key = sessionKey(change.row);
  let found = false;
  const next = rows.map((row) => {
    if (sessionKey(row) !== key) return row;
    found = true;
    return change.row;
  });
  return found ? next : rows.slice();
}

export function withSettling(row: SidebarSession, override: "settled" | "active" | null, at: number = Date.now()): SidebarSession {
  return {
    ...without(row, ["settledOverride", "settledAt", "settledBy", "settledForTitle", ...(override === "settled" ? (["terminals"] as const) : [])]),
    updatedAt: at,
    ...(override === null ? {} : { settledOverride: override }),
    ...(override === "settled" ? { settledAt: at } : {}),
  };
}

export type SnoozableRow = { updatedAt: number; snoozedUntil?: number; snoozedAt?: number };

export function withSnooze<T extends SnoozableRow>(row: T, until: number | null, at: number = Date.now()): T {
  const next: T & SnoozableRow = { ...row, updatedAt: at };
  delete next.snoozedUntil;
  delete next.snoozedAt;
  return until === null ? next : { ...next, snoozedUntil: until, snoozedAt: at };
}

type ClearableField = "settledOverride" | "settledAt" | "settledBy" | "settledForTitle" | "terminals";

function without(row: SidebarSession, fields: readonly ClearableField[]): SidebarSession {
  const next = { ...row };
  for (const field of fields) delete next[field];
  return next;
}

export function withTitle(row: SidebarSession, title: string, at: number = Date.now()): SidebarSession {
  return { ...row, title, updatedAt: at };
}

export function newSessionId(): string {
  return `session_${crypto.randomUUID().replaceAll("-", "")}`;
}

const engineFor = (session: Pick<SidebarSession, "hostId">) => createEngineApi(hostFetcher(session.hostId ?? LOCAL_HOST_ID));

export async function patchSession(
  session: Pick<SidebarSession, "id" | "hostId">,
  patch: { settledOverride?: "settled" | "active" | null; snoozedUntil?: number | null; title?: string },
): Promise<LiveSessionRow> {
  const answer = (await engineFor(session).updateSession(session.id, patch)) as { session?: LiveSessionRow } | null;
  if (!answer?.session) throw new Error("The engine answered that change without a session.");
  return answer.session;
}

export async function deleteSession(session: Pick<SidebarSession, "id" | "hostId">): Promise<undefined> {
  await engineFor(session).deleteSession(session.id);
  return undefined;
}

export async function closeRowTerminals({
  row,
  onRowChanged,
  report = alertReporter,
}: {
  row: SidebarSession;
  onRowChanged: SessionRowChanged;
  report?: MutationReporter;
}): Promise<void> {
  onRowChanged({ row: without(row, ["terminals"]) });
  try {
    await engineFor(row).closeSessionTerminals(row.id);
  } catch (cause) {
    onRowChanged({ row });
    report(cause instanceof Error ? cause.message : "The engine could not close those terminals.");
  }
}

export type MutationReporter = (message: string) => void;

const alertReporter: MutationReporter = (message) => {
  if (typeof window !== "undefined") window.alert(message);
};

export async function mutateRow({
  before,
  after,
  send,
  onRowChanged,
  report = alertReporter,
}: {
  before: SidebarSession;
  after: SessionRowChange;
  send: () => Promise<LiveSessionRow | undefined>;
  onRowChanged: SessionRowChanged;
  report?: MutationReporter;
}): Promise<void> {
  onRowChanged(after);
  try {
    const answered = await send();
    onRowChanged(answered ? { row: patchedRow(before, answered) } : { removed: sessionKey(before) });
  } catch (cause) {
    onRowChanged({ row: before });
    report(cause instanceof Error ? cause.message : "The engine refused that change.");
  }
}
