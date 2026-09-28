import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ALERT_BODY, alertKind, signalKey, type AlertKind, type SessionSignal } from "./push";
import { sessionHref } from "../session-list";
import { remoteHome } from "../remote/store";
import { onSessionRead } from "../session-read-events";

/**
 * THE MAC'S OWN NOTIFICATIONS — fed by the push worker's pass, spoken over the
 * fork IPC channel the shell already opened to this process.
 *
 * ── WHY THE FORK CHANNEL AND NOT A ROUTE ────────────────────────────────────
 * main.js forks this server with `stdio: [..., "ipc"]` (server-preload.js rides
 * it to die with the shell). Only the process that forked us holds the other
 * end, so the channel is authenticated by construction: nothing a paired phone,
 * a tailnet peer or a page can reach. An SSE route would need the host header,
 * a reconnect loop and a subscriber to exist at the moment of a transition;
 * this needs none of them and cannot be dialled from outside.
 *
 * ── AND ONLY WHEN THE SHELL SAYS SO ─────────────────────────────────────────
 * `next dev` also runs with a `process.send` — to Next's own CLI. The shell sets
 * `TELAR_DESKTOP_NOTIFICATIONS=1` on the child it forks; without it this is off,
 * so a message never lands in a parent that is not Telar.
 *
 * THE MESSAGE NAMES ARE DECLARED TWICE ON PURPOSE (this file and
 * apps/desktop/desktop-notifications.js); the shell's test pins that they agree.
 */
export const DESKTOP_NOTIFICATIONS_ENV = "TELAR_DESKTOP_NOTIFICATIONS";
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
  /** The cockpit route (`sessionHref`) — a PATH, never a URL; see window-target.js. */
  path: string;
  /** The one request Approve resolves: this one, never whatever is open by then. */
  request?: string;
};

/**
 * THE MOBILE PREFS THAT MEAN SOMETHING ON A MAC, and their Mac defaults.
 * `previews` ON: this is the person's own machine, so the title is shown — the
 * phone defaults the other way because a lock screen is read by anyone nearby.
 * Mutes and Live Activities are the phone's. Which DEVICE is told is
 * `notifyRoute`'s question, below.
 */
export type DesktopPrefs = { completions: boolean; previews: boolean };
export const DESKTOP_PREFS: DesktopPrefs = { completions: true, previews: true };

/**
 * "NOTIFY ON" — ONE ALERT, ONE DEVICE. With both the Mac's banners and the
 * phone's pushes on, every transition arrived twice, and the one on the device
 * the person was not using was noise. `mac` is "This Mac when active": the
 * banner while they are at the Mac, the phone push once they are not.
 */
export type NotifyOn = "mac" | "iphone" | "both";
export const NOTIFY_ON_VALUES: readonly NotifyOn[] = ["mac", "iphone", "both"];
export const DEFAULT_NOTIFY_ON: NotifyOn = "mac";
export const isNotifyOn = (value: unknown): value is NotifyOn => NOTIFY_ON_VALUES.includes(value as NotifyOn);

/**
 * WHAT THE SHELL LAST SAID ABOUT THE PERSON AT THIS MAC, stamped with when this
 * process heard it. `viewingPath` is the session route in the focused cockpit
 * window, and only while active (desktop-notifications.js `presenceMessage`).
 */
export type Presence = { active: boolean; viewingPath: string | null; at: number };
/**
 * THREE OF THE SHELL'S 15s BEATS. Older than this is ABSENT, not "active as of
 * a while ago": a shell that hung, quit or was never attached (dev mode, a
 * browser tab) must never be the reason a phone alert did not go.
 */
export const PRESENCE_STALE_MS = 45_000;

/**
 * THE ONE DECISION, for both devices. The worker's phone skip and the Mac's
 * banner both come from this; the shell only re-checks its viewing clause with
 * a fresher look (`shouldNotifyDesktop`), which can never make it disagree.
 *
 *   - viewing that session, while active: neither — they are already there.
 *   - `iphone`: the phone, always; never the Mac.
 *   - `both`:   both.
 *   - `mac`:    the Mac while active, otherwise the phone.
 */
export function notifyRoute(notifyOn: NotifyOn, presence: Presence | undefined, path: string, now = Date.now()): { desktop: boolean; phone: boolean } {
  if (notifyOn === "iphone") return { desktop: false, phone: true };
  const active = presence !== undefined && presence.active && now - presence.at >= 0 && now - presence.at <= PRESENCE_STALE_MS;
  if (active && presence.viewingPath === path) return { desktop: false, phone: false };
  if (notifyOn === "both") return { desktop: true, phone: true };
  return { desktop: active, phone: !active };
}

/**
 * WHERE "NOTIFY ON" IS KEPT — `<TELAR_HOME>/remote/notify-on.json`, beside
 * `mobile-push.json`. Cockpit-owned, not an engine setting: the only reader is
 * this process's push worker, and the phones' own records already live here.
 * A missing or unreadable file is the default, never an error on the push path.
 */
export function notifyOnFile(): string { return path.join(remoteHome(), "notify-on.json"); }
export function readNotifyOn(file?: string): NotifyOn {
  try {
    const value = (JSON.parse(fs.readFileSync(file ?? notifyOnFile(), "utf8")) as { notifyOn?: unknown }).notifyOn;
    return isNotifyOn(value) ? value : DEFAULT_NOTIFY_ON;
  } catch { return DEFAULT_NOTIFY_ON; }
}
export function writeNotifyOn(notifyOn: NotifyOn, file = notifyOnFile()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ notifyOn }), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * THE MAC'S "SEEN", kept like a phone record's: first pass baselines, so a
 * launch never replays history. `offered` is the request each session's live
 * notification carries — the only thing an Approve may resolve.
 */
export type DesktopState = { seen: Record<string, string>; baselined: boolean; offered: Record<string, string> };
export const emptyDesktopState = (): DesktopState => ({ seen: {}, baselined: false, offered: {} });

/** Pure: which notices a pass produces, and the state after it. Same shape as
 *  `deliverRecord`'s loop — only what moved, plus sessions never seen. */
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
    // Anything that moved retires the old offer; a fresh blocked notice makes a new one.
    if (state.seen[session.id] !== signalKey(session)) delete next.offered[session.id];
    if (!kind) continue;
    const request = kind === "blocked" ? session.approvable : undefined;
    if (request) next.offered[session.id] = request;
    notices.push({
      type: DESKTOP_NOTICE, kind, sessionId: session.id,
      title: prefs.previews ? session.title.slice(0, 160) : "Telar",
      body: ALERT_BODY[kind],
      path: sessionHref({ id: session.id, projectId: session.projectId, hostId: undefined }),
      ...(request ? { request } : {}),
    });
  }
  const ids = new Set(sessions.map((s) => s.id));
  for (const id of Object.keys(next.seen)) if (!ids.has(id)) delete next.seen[id];
  for (const id of Object.keys(next.offered)) if (!ids.has(id)) delete next.offered[id];
  return { notices, state: next };
}

/** The slice of `process` this uses, so a test can hand it a fake. */
type Channel = { on(event: "message", listener: (message: unknown) => void): unknown; send?: (message: unknown) => boolean; connected?: boolean };
type Resolve = (sessionId: string, requestId: string, input: { decision: "accept" }) => Promise<unknown>;

const desktopGlobal = globalThis as typeof globalThis & {
  telarDesktopNotify?: DesktopState; telarDesktopListening?: true;
  telarDesktopPresence?: Presence;
  /** Session id → the signal whose alert the Mac took (shown, or the person was
   *  already looking). The phone skips exactly that signal — see `macTookAlert`. */
  telarDesktopTook?: Record<string, string>;
};

export function desktopAttached(channel: Channel = process, env: Record<string, string | undefined> = process.env): boolean {
  return env[DESKTOP_NOTIFICATIONS_ENV] === "1" && typeof channel.send === "function" && channel.connected === true;
}

/**
 * Run one pass for the Mac. Nothing is logged: a notice carries a title.
 *
 * EVERY NOTICE IS ROUTED HERE, in the same pass as the phones', so the worker
 * can skip a phone alert only for a transition this Mac actually took. A
 * transition the Mac never produced a notice for (its launch baseline, say)
 * is never claimed, and the phone keeps it.
 */
export function notifyDesktop(
  sessions: readonly SessionSignal[],
  changed: ReadonlySet<string> | undefined,
  { channel = process, notifyOn = readNotifyOn(), now = Date.now() }: { channel?: Channel; notifyOn?: NotifyOn; now?: number } = {},
): void {
  const { notices, state } = desktopNotices(desktopGlobal.telarDesktopNotify ?? emptyDesktopState(), sessions, changed);
  desktopGlobal.telarDesktopNotify = state;
  const took: Record<string, string> = {};
  for (const [id, key] of Object.entries(desktopGlobal.telarDesktopTook ?? {})) if (id in state.seen) took[id] = key;
  for (const notice of notices) {
    const route = notifyRoute(notifyOn, desktopGlobal.telarDesktopPresence, notice.path, now);
    if (route.phone) delete took[notice.sessionId]; else took[notice.sessionId] = state.seen[notice.sessionId];
    if (!route.desktop) continue;
    try { channel.send?.(notice); } catch { /* The shell is going away; so is this process. */ }
  }
  desktopGlobal.telarDesktopTook = took;
}

/**
 * WHETHER THE PHONE SHOULD STAY QUIET ABOUT THIS SESSION'S CURRENT SIGNAL
 * because the Mac took it. Keyed by the signal, not the session: the next
 * transition is a new question. The phone record still advances its `seen`,
 * so the alert does not surface later, stale, once the Mac goes idle.
 */
export function macTookAlert(session: SessionSignal): boolean {
  return desktopGlobal.telarDesktopTook?.[session.id] === signalKey(session);
}

const validId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256;
/**
 * THE SHELL ASKS TO APPROVE — and gets exactly what this process offered. The
 * pair must match `offered`, so a notification that has since been superseded,
 * or a message naming any other request, resolves nothing.
 */
export async function handleDesktopMessage(message: unknown, resolve: Resolve, channel: Channel = process, state = desktopGlobal.telarDesktopNotify, now = Date.now()): Promise<void> {
  if (!message || typeof message !== "object") return;
  const { type, sessionId, requestId, active, viewingPath } = message as Record<string, unknown>;
  if (type === DESKTOP_PRESENCE) {
    // Stamped with THIS process's clock on arrival, so staleness never depends
    // on the shell's. A malformed beat is ignored and the last one ages out.
    const viewing = viewingPath === null || (typeof viewingPath === "string" && viewingPath.startsWith("/") && viewingPath.length <= 1024) ? viewingPath : undefined;
    if (typeof active === "boolean" && viewing !== undefined) desktopGlobal.telarDesktopPresence = { active, viewingPath: viewing, at: now };
    return;
  }
  if (type !== DESKTOP_APPROVE || !validId(sessionId) || !validId(requestId)) return;
  let ok = false;
  if (state && state.offered[sessionId] === requestId) {
    delete state.offered[sessionId];
    try { await resolve(sessionId, requestId, { decision: "accept" }); ok = true; } catch { /* Answered as not ok: the shell opens the session. */ }
  }
  try { channel.send?.({ type: DESKTOP_APPROVED, sessionId, requestId, ok }); } catch { /* shell gone */ }
}

/**
 * READ ANYWHERE, GONE FROM THE MAC. A receipt accepted from the cockpit or the
 * phone (`session-read-events.ts`) takes that session's banner down: the Mac's
 * half of read sync. Ids only; a session with no banner up is a no-op there.
 */
export function dismissDesktop(sessionId: string, channel: Channel = process): void {
  if (!validId(sessionId) || !desktopAttached(channel)) return;
  try { channel.send?.({ type: DESKTOP_DISMISS, sessionId }); } catch { /* shell gone */ }
}

export function listenForDesktop(resolve: Resolve, channel: Channel = process): void {
  if (desktopGlobal.telarDesktopListening || !desktopAttached(channel)) return;
  desktopGlobal.telarDesktopListening = true;
  channel.on("message", (message: unknown) => { void handleDesktopMessage(message, resolve, channel); });
  onSessionRead(sessionId => dismissDesktop(sessionId, channel));
}
