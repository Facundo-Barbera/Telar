import type { NotificationSounds, NotifyOn } from "@telar/engine-client";
import { readNotifyOn, readSounds, soundFor } from "./prefs";
import { ALERT_BODY, alertKind, signalKey, type AlertKind, type SessionSignal } from "./push";

const sessionHref = (session: { id: string; projectId?: string }) =>
  session.projectId ? `/projects/${encodeURIComponent(session.projectId)}/sessions/${encodeURIComponent(session.id)}` : "/main";

export const DESKTOP_NOTICE = "telar:desktop-notification";
export const DESKTOP_APPROVE = "telar:desktop-notification:approve";
export const DESKTOP_APPROVED = "telar:desktop-notification:approved";
export const DESKTOP_PRESENCE = "telar:desktop-presence";
export const DESKTOP_DISMISS = "telar:desktop-notification:dismiss";

export type DesktopNotice = {
  type: typeof DESKTOP_NOTICE;
  kind: AlertKind;
  sessionId: string;
  title: string;
  body: string;
  path: string;
  request?: string;
  sound?: string;
};

export type DesktopPrefs = { completions: boolean; previews: boolean };
const DESKTOP_PREFS: DesktopPrefs = { completions: true, previews: true };

export type Presence = { active: boolean; viewingPath: string | null; at: number };
export const PRESENCE_STALE_MS = 45_000;

export function notifyRoute(notifyOn: NotifyOn, presence: Presence | undefined, path: string, now = Date.now()): { desktop: boolean; phone: boolean } {
  if (notifyOn === "iphone") return { desktop: false, phone: true };
  const active = presence !== undefined && presence.active && now - presence.at >= 0 && now - presence.at <= PRESENCE_STALE_MS;
  if (active && presence.viewingPath === path) return { desktop: false, phone: false };
  if (notifyOn === "both") return { desktop: true, phone: true };
  return { desktop: active, phone: !active };
}

export type DesktopState = { seen: Record<string, string>; baselined: boolean; offered: Record<string, string> };
export const emptyDesktopState = (): DesktopState => ({ seen: {}, baselined: false, offered: {} });

export function desktopNotices(
  state: DesktopState,
  sessions: readonly SessionSignal[],
  changed: ReadonlySet<string> | undefined,
  prefs: DesktopPrefs = DESKTOP_PREFS,
): { notices: DesktopNotice[]; state: DesktopState } {
  const next: DesktopState = { seen: { ...state.seen }, baselined: true, offered: { ...state.offered } };
  const notices: DesktopNotice[] = [];
  for (const session of sessions) {
    if (changed && !changed.has(session.id) && session.id in state.seen) continue;
    const kind = alertKind(session, state.seen[session.id] ?? (state.baselined ? "new:0:0:false" : undefined), prefs.completions);
    next.seen[session.id] = signalKey(session);
    if (state.seen[session.id] !== signalKey(session)) delete next.offered[session.id];
    if (!kind) continue;
    const request = kind === "blocked" ? session.approvable : undefined;
    if (request) next.offered[session.id] = request;
    notices.push({
      type: DESKTOP_NOTICE, kind, sessionId: session.id,
      title: prefs.previews ? session.title.slice(0, 160) : "Telar",
      body: ALERT_BODY[kind],
      path: sessionHref(session),
      ...(request ? { request } : {}),
    });
  }
  const ids = new Set(sessions.map((s) => s.id));
  for (const id of Object.keys(next.seen)) if (!ids.has(id)) delete next.seen[id];
  for (const id of Object.keys(next.offered)) if (!ids.has(id)) delete next.offered[id];
  return { notices, state: next };
}

export type Channel = { send(message: unknown): void; readonly connected: boolean };

export function createDesktopStream() {
  const subscribers = new Set<{ write(chunk: string): unknown }>();
  return {
    get connected() {
      return subscribers.size > 0;
    },
    send(message: unknown) {
      const frame = `data: ${JSON.stringify(message)}\n\n`;
      for (const subscriber of subscribers) subscriber.write(frame);
    },
    subscribe(subscriber: { write(chunk: string): unknown }): () => void {
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    },
  };
}
export const desktopStream = createDesktopStream();
type Resolve = (sessionId: string, requestId: string, input: { decision: "accept" }) => Promise<unknown>;

const desktopGlobal = globalThis as typeof globalThis & {
  telarDesktopNotify?: DesktopState;
  telarDesktopPresence?: Presence;
  telarDesktopTook?: Record<string, string>;
};

export function desktopAttached(channel: Channel = desktopStream): boolean {
  return channel.connected;
}

export function notifyDesktop(
  sessions: readonly SessionSignal[],
  changed: ReadonlySet<string> | undefined,
  { channel = desktopStream, notifyOn = readNotifyOn(), sounds = readSounds(), now = Date.now() }: { channel?: Channel; notifyOn?: NotifyOn; sounds?: NotificationSounds; now?: number } = {},
): void {
  const { notices, state } = desktopNotices(desktopGlobal.telarDesktopNotify ?? emptyDesktopState(), sessions, changed);
  desktopGlobal.telarDesktopNotify = state;
  const took: Record<string, string> = {};
  for (const [id, key] of Object.entries(desktopGlobal.telarDesktopTook ?? {})) if (id in state.seen) took[id] = key;
  for (const notice of notices) {
    const route = notifyRoute(notifyOn, desktopGlobal.telarDesktopPresence, notice.path, now);
    if (route.phone) delete took[notice.sessionId]; else took[notice.sessionId] = state.seen[notice.sessionId];
    if (!route.desktop) continue;
    const sound = soundFor(sounds, notice.kind);
    channel.send(sound ? { ...notice, sound } : notice);
  }
  desktopGlobal.telarDesktopTook = took;
}

export function macTookAlert(session: SessionSignal): boolean {
  return desktopGlobal.telarDesktopTook?.[session.id] === signalKey(session);
}

const validId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256;
export async function handleDesktopMessage(message: unknown, resolve: Resolve, channel: Channel = desktopStream, state = desktopGlobal.telarDesktopNotify, now = Date.now()): Promise<void> {
  if (!message || typeof message !== "object") return;
  const { type, sessionId, requestId, active, viewingPath } = message as Record<string, unknown>;
  if (type === DESKTOP_PRESENCE) {
    const viewing = viewingPath === null || (typeof viewingPath === "string" && viewingPath.startsWith("/") && viewingPath.length <= 1024) ? viewingPath : undefined;
    if (typeof active === "boolean" && viewing !== undefined) desktopGlobal.telarDesktopPresence = { active, viewingPath: viewing, at: now };
    return;
  }
  if (type !== DESKTOP_APPROVE || !validId(sessionId) || !validId(requestId)) return;
  let ok = false;
  if (state && state.offered[sessionId] === requestId) {
    delete state.offered[sessionId];
    try { await resolve(sessionId, requestId, { decision: "accept" }); ok = true; } catch { }
  }
  channel.send({ type: DESKTOP_APPROVED, sessionId, requestId, ok });
}

export function dismissDesktop(sessionId: string, channel: Channel = desktopStream): void {
  if (!validId(sessionId) || !desktopAttached(channel)) return;
  channel.send({ type: DESKTOP_DISMISS, sessionId });
}
