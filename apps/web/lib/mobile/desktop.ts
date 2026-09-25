import { ALERT_BODY, alertKind, signalKey, type AlertKind, type SessionSignal } from "./push";
import { sessionHref } from "../session-list";

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
 * Mutes and Live Activities are the phone's. PR 2b ("Notify on") gates here.
 */
export type DesktopPrefs = { completions: boolean; previews: boolean };
export const DESKTOP_PREFS: DesktopPrefs = { completions: true, previews: true };

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

const desktopGlobal = globalThis as typeof globalThis & { telarDesktopNotify?: DesktopState; telarDesktopListening?: true };

export function desktopAttached(channel: Channel = process, env: Record<string, string | undefined> = process.env): boolean {
  return env[DESKTOP_NOTIFICATIONS_ENV] === "1" && typeof channel.send === "function" && channel.connected === true;
}

/** Run one pass for the Mac. Nothing is logged: a notice carries a title. */
export function notifyDesktop(sessions: readonly SessionSignal[], changed: ReadonlySet<string> | undefined, channel: Channel = process): void {
  const { notices, state } = desktopNotices(desktopGlobal.telarDesktopNotify ?? emptyDesktopState(), sessions, changed);
  desktopGlobal.telarDesktopNotify = state;
  for (const notice of notices) {
    try { channel.send?.(notice); } catch { /* The shell is going away; so is this process. */ }
  }
}

const validId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256;
/**
 * THE SHELL ASKS TO APPROVE — and gets exactly what this process offered. The
 * pair must match `offered`, so a notification that has since been superseded,
 * or a message naming any other request, resolves nothing.
 */
export async function handleDesktopMessage(message: unknown, resolve: Resolve, channel: Channel = process, state = desktopGlobal.telarDesktopNotify): Promise<void> {
  if (!message || typeof message !== "object") return;
  const { type, sessionId, requestId } = message as Record<string, unknown>;
  if (type !== DESKTOP_APPROVE || !validId(sessionId) || !validId(requestId)) return;
  let ok = false;
  if (state && state.offered[sessionId] === requestId) {
    delete state.offered[sessionId];
    try { await resolve(sessionId, requestId, { decision: "accept" }); ok = true; } catch { /* Answered as not ok: the shell opens the session. */ }
  }
  try { channel.send?.({ type: DESKTOP_APPROVED, sessionId, requestId, ok }); } catch { /* shell gone */ }
}

export function listenForDesktop(resolve: Resolve, channel: Channel = process): void {
  if (desktopGlobal.telarDesktopListening || !desktopAttached(channel)) return;
  desktopGlobal.telarDesktopListening = true;
  channel.on("message", (message: unknown) => { void handleDesktopMessage(message, resolve, channel); });
}
