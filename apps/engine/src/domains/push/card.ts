import crypto from "node:crypto";
import { ALERT_BODY, AUTOMATIC_ACTIVITY, CARD_LINGER_S, alertSound, turnIsOver, type Delivery, type MobileRegistration, type SessionSignal } from "./push";

export const ACTIVITY_STALE_S = 600;
export const CARD_ROWS = 4;
export const ROW_DONE_S = 900;
export const END_DISMISS_S = 300;
export const BARE_END_DISMISS_S = 15;
const ACTIVE_STATUS: Record<string, string> = { blocked: "Needs you", working: "Working", queued: "Queued", monitoring: "Background" };
const ROW_RANK: Record<string, number> = { "Needs you": 0, Working: 1, Queued: 2, Background: 3, Done: 4, Failed: 4 };
const FAMILY_RANK: Record<string, number> = { "Needs you": 0, Failed: 1, Working: 2, Queued: 3, Background: 4, Done: 5 };
const REFERENCE_EPOCH = 978307200;

export type CardRow = { id: string; status: string; title?: string; project?: string; workers?: number };
export type CardAlert = { title: string; body: string; sound?: string };
export type CardEvent = "start" | "update" | "end";

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

export function automaticSessions(sessions: SessionSignal[]): SessionSignal[] {
  return sessions.filter(s => s.activity in ACTIVE_STATUS);
}

function rowStatus(session: SessionSignal, now: number): string | undefined {
  if (session.activity in ACTIVE_STATUS) return ACTIVE_STATUS[session.activity];
  if (!turnIsOver(session.activity) || session.lastTurnEndedAt === undefined || now * 1000 - session.lastTurnEndedAt >= ROW_DONE_S * 1000) return;
  return session.lastTurnFailed ? "Failed" : "Done";
}

function families(sessions: SessionSignal[]): SessionSignal[][] {
  const byId = new Map(sessions.map(s => [s.id, s]));
  const rootOf = (session: SessionSignal) => {
    const seen = new Set([session.id]);
    let root = session;
    for (let up = byId.get(root.parentId ?? ""); up; up = byId.get(root.parentId ?? "")) {
      if (seen.has(up.id)) return session;
      seen.add(up.id); root = up;
    }
    return root;
  };
  const groups = new Map<string, SessionSignal[]>();
  for (const session of sessions) { const root = rootOf(session); groups.set(root.id, [...(groups.get(root.id) ?? []), session]); }
  return [...groups].map(([id, members]) => [byId.get(id)!, ...members.filter(m => m.id !== id)]);
}

export function activeRoots(sessions: SessionSignal[]): SessionSignal[] {
  return families(sessions).filter(family => automaticSessions(family).length).map(([root]) => root!);
}

export function cardRows(sessions: SessionSignal[], now: number, previews: boolean): CardRow[] {
  const at = (s: SessionSignal) => Math.max(s.activityAt ?? 0, s.lastTurnEndedAt ?? 0);
  return families(sessions).flatMap(([root, ...children]) => {
    const shown = [root!, ...children].flatMap(session => { const status = rowStatus(session, now); return status ? [{ session, status }] : []; });
    if (!shown.length) return [];
    const status = shown.map(s => s.status).sort((a, b) => FAMILY_RANK[a]! - FAMILY_RANK[b]!)[0]!;
    const workers = shown.filter(s => s.session !== root).length;
    const project = root!.project ?? children.find(c => c.project)?.project;
    return [{ root: root!, status, at: Math.max(...shown.map(s => at(s.session))), workers, project }];
  }).sort((a, b) => ROW_RANK[a.status]! - ROW_RANK[b.status]! || b.at - a.at || a.root.id.localeCompare(b.root.id))
    .slice(0, CARD_ROWS)
    .map(({ root, status, workers, project }) => ({ id: root.id, status,
      ...(previews && root.title.trim() ? { title: clip(root.title, 60) } : {}), ...(project ? { project: clip(project, 40) } : {}),
      ...(workers ? { workers } : {}) }));
}

export function cardAlert(record: MobileRegistration, blocked: SessionSignal[]): CardAlert {
  const one = blocked.length === 1 ? blocked[0] : undefined;
  const sound = alertSound(record, "blocked");
  return { title: !one ? `${blocked.length} sessions need you` : record.previews ? clip(one.title, 160) : "Telar",
    body: one ? ALERT_BODY.blocked : "Open Telar to answer them.", ...(sound ? { sound } : {}) };
}

export function automaticActivityDelivery(record: MobileRegistration, sessions: SessionSignal[], token: string, startedAt: number, now: number, event: CardEvent = "update", alert?: CardAlert): Delivery {
  const start = event === "start";
  const active = record.liveActivities ? activeRoots(sessions) : [];
  const rows = record.liveActivities ? cardRows(sessions, now, record.previews) : [];
  const ended = !active.length;
  const focus = rows[0];
  const state = {
    title: record.previews && active.length === 1 && active[0]!.title.trim() ? clip(active[0]!.title, 160) : active.length > 1 ? `${active.length} active sessions` : ended ? "Work finished" : "Telar work",
    status: !ended ? focus!.status : focus?.status === "Failed" ? "Failed" : "Finished",
    startedAt: startedAt - REFERENCE_EPOCH, updatedAt: now - REFERENCE_EPOCH, ended,
    sessionId: focus?.id, activeCount: active.length, rows,
  };
  const dismissal = event === "end" ? { "dismissal-date": Math.floor(now + (rows.length ? END_DISMISS_S : BARE_END_DISMISS_S)) } : {};
  return { token, topic: `${record.topic}.push-type.liveactivity`, sandbox: record.sandbox, kind: "liveactivity", ...(start ? {} : { activityId: AUTOMATIC_ACTIVITY }),
    ...(alert && !start ? { urgent: true } : {}),
    collapseId: crypto.createHash("sha256").update(`automatic:${record.hostId}:${start ? startedAt : token}`).digest("hex"),
    payload: { aps: { timestamp: Math.floor(now), event, "content-state": state,
      "stale-date": Math.floor(now + ACTIVITY_STALE_S + (ended ? CARD_LINGER_S : 0)), ...dismissal,
      ...(start ? { "attributes-type": "SessionActivityAttributes", attributes: { hostId: record.hostId, sessionId: AUTOMATIC_ACTIVITY, hostName: record.hostName ?? "Mac" },
        "input-push-token": 1, alert: { title: "Telar", body: "Agent work in progress" } } : {}),
      ...(alert && !start ? { alert } : {}),
    } } };
}
