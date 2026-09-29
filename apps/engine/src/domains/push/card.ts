import crypto from "node:crypto";
import { ALERT_BODY, AUTOMATIC_ACTIVITY, CARD_LINGER_S, alertSound, turnIsOver, type Delivery, type MobileRegistration, type SessionSignal } from "./push";

export const ACTIVITY_STALE_S = 600;
export const CARD_ROWS = 4;
export const ROW_DONE_S = 900;
export const END_DISMISS_S = 300;
export const BARE_END_DISMISS_S = 15;
const ACTIVE_STATUS: Record<string, string> = { blocked: "Needs you", working: "Working", queued: "Queued", monitoring: "Background" };
const ROW_RANK: Record<string, number> = { "Needs you": 0, Working: 1, Queued: 2, Background: 3, Done: 4, Failed: 4 };
const REFERENCE_EPOCH = 978307200;

export type CardRow = { id: string; status: string; title?: string; project?: string };
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

export function cardRows(sessions: SessionSignal[], now: number, previews: boolean): CardRow[] {
  const at = (s: SessionSignal) => Math.max(s.activityAt ?? 0, s.lastTurnEndedAt ?? 0);
  return sessions.flatMap(session => { const status = rowStatus(session, now); return status ? [{ session, status }] : []; })
    .sort((a, b) => ROW_RANK[a.status]! - ROW_RANK[b.status]! || at(b.session) - at(a.session) || a.session.id.localeCompare(b.session.id))
    .slice(0, CARD_ROWS)
    .map(({ session, status }) => ({ id: session.id, status,
      ...(previews ? { title: clip(session.title, 60) } : {}), ...(session.project ? { project: clip(session.project, 40) } : {}) }));
}

export function cardAlert(record: MobileRegistration, blocked: SessionSignal[]): CardAlert {
  const one = blocked.length === 1 ? blocked[0] : undefined;
  const sound = alertSound(record, "blocked");
  return { title: !one ? `${blocked.length} sessions need you` : record.previews ? clip(one.title, 160) : "Telar",
    body: one ? ALERT_BODY.blocked : "Open Telar to answer them.", ...(sound ? { sound } : {}) };
}

export function automaticActivityDelivery(record: MobileRegistration, sessions: SessionSignal[], token: string, startedAt: number, now: number, event: CardEvent = "update", alert?: CardAlert): Delivery {
  const start = event === "start";
  const active = record.liveActivities ? automaticSessions(sessions) : [];
  const rows = record.liveActivities ? cardRows(sessions, now, record.previews) : [];
  const ended = !active.length;
  const focus = rows[0];
  const state = {
    title: record.previews && active.length === 1 ? clip(active[0]!.title, 160) : active.length > 1 ? `${active.length} active sessions` : ended ? "Work finished" : "Telar work",
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
