"use strict";

/**
 * THE MAC'S OWN NOTIFICATIONS — the shell half.
 *
 * The cockpit server decides WHICH transitions deserve an alert, with the very
 * rule the phone uses (apps/web/lib/mobile/desktop.ts), and sends each one up
 * the fork IPC channel main.js opened when it started that server. Only this
 * process holds the other end of that pipe, so there is no route to
 * authenticate and nothing a paired phone or a tailnet peer can dial. This file
 * checks the shape anyway, because a notice becomes a native banner and a path
 * the cockpit navigates to.
 *
 * PRESENCE GOES THE OTHER WAY DOWN THE SAME PIPE. Whether the person is at this
 * Mac lives here, in the main process; whether the phone is pushed is decided
 * in the server's worker. So the shell reports it (`createPresenceReporter`)
 * and the server makes the one decision for both devices.
 *
 * Pure and Electron-free, like window-target.js: main.js hands in the
 * Notification class, so the test drives a fake one.
 */

/** Declared twice on purpose — see apps/web/lib/mobile/desktop.ts. The test
 *  pins that both halves spell them the same. */
const DESKTOP_NOTIFICATIONS_ENV = "TELAR_DESKTOP_NOTIFICATIONS";
const DESKTOP_NOTICE = "telar:desktop-notification";
const DESKTOP_APPROVE = "telar:desktop-notification:approve";
const DESKTOP_APPROVED = "telar:desktop-notification:approved";
const DESKTOP_PRESENCE = "telar:desktop-presence";
const KINDS = new Set(["blocked", "finished", "failed"]);

const text = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max;
/** A path inside the app and nothing else — the same shape rule as window-target.js. */
const appPath = (value) =>
  text(value, 1024) && value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\");

/** A notice from the server, or null. */
function parseNotice(message) {
  if (!message || typeof message !== "object" || message.type !== DESKTOP_NOTICE) return null;
  const { kind, sessionId, title, body, path, request } = message;
  if (!KINDS.has(kind) || !text(sessionId, 256) || !text(title, 160) || !text(body, 200) || !appPath(path)) return null;
  if (request !== undefined && !text(request, 256)) return null;
  return { kind, sessionId, title, body, path, ...(request === undefined ? {} : { request }) };
}

/** The cockpit route a window is showing, or null. */
function routeOf(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

/**
 * THE LAST LOOK BEFORE A BANNER, NOT A SECOND RULE.
 *
 * WHETHER the Mac or the phone gets an alert is decided once, on the server, by
 * `notifyRoute` (apps/web/lib/mobile/desktop.ts), from the presence this shell
 * reports below and the "Notify on" setting — a notice arrives here only when
 * that answer included the Mac. What remains is the one clause of that rule
 * this process can see fresher than the last presence beat: the session is on
 * screen in the focused window right now, so nobody needs telling.
 *
 * @param {{ path: string }} notice
 * @param {{ focused?: boolean, viewingPath?: string | null }} context
 */
function shouldNotifyDesktop(notice, context = {}) {
  if (context.focused && context.viewingPath === notice.path) return false;
  return true;
}

/**
 * ACTIVE MEANS INPUT IN THE LAST TWO MINUTES AND THE SCREEN UNLOCKED. Long
 * enough to read a diff without touching anything; short enough that a person
 * who walked away gets the phone alert rather than a banner on an empty desk.
 */
const ACTIVE_IDLE_SECONDS = 120;
/**
 * A BEAT, NOT JUST EDGES. Idle has no event — input resuming says nothing — so
 * the shell re-reads and resends on a timer. The server treats presence older
 * than three beats as absent (`PRESENCE_STALE_MS`), which is what makes a hung
 * or departed shell fall back to the phone instead of swallowing its alerts.
 */
const PRESENCE_BEAT_MS = 15_000;

/**
 * What this Mac tells the server about the person in front of it. `viewingPath`
 * only while active: a window left focused on a session when somebody walked
 * away is not them looking at it, and must not silence the phone.
 *
 * @param {{ idleState?: string, locked?: boolean, focused?: boolean, viewingPath?: string | null }} sample
 */
function presenceMessage({ idleState, locked, focused, viewingPath }) {
  const active = !locked && idleState === "active";
  return { type: DESKTOP_PRESENCE, active, viewingPath: active && focused && appPath(viewingPath) ? viewingPath : null };
}

/**
 * @param {object} deps
 * @param {() => object} deps.sample - the live idle/lock/focus reading (main.js).
 * @param {(message: object) => void} deps.send - to the server child.
 */
function createPresenceReporter({ sample, send, setInterval: every = setInterval, clearInterval: stopEvery = clearInterval }) {
  let timer = null;
  const report = () => send(presenceMessage(sample()));
  return {
    report,
    start() {
      if (timer) return;
      report();
      timer = every(report, PRESENCE_BEAT_MS);
      timer?.unref?.();
    },
    stop() {
      if (timer) stopEvery(timer);
      timer = null;
    },
  };
}

/**
 * @param {object} deps
 * @param {new (options: object) => any} deps.Notification - Electron's, or a fake.
 * @param {(message: object) => void} deps.send - to the server child.
 * @param {() => { focused?: boolean, viewingPath?: string | null }} deps.context
 * @param {(path: string) => void} deps.open - show that route in the cockpit window.
 */
function createDesktopNotifier({ Notification, send, context, open }) {
  /** One banner per session, like the phone's collapse id — and a reference
   *  held, because a collected Notification stops delivering its clicks. */
  const live = new Map();
  /** Approvals in flight: requestId → the path to open if it does not land. */
  const pending = new Map();

  function show(notice) {
    live.get(notice.sessionId)?.close();
    const approvable = notice.request !== undefined;
    const banner = new Notification({
      title: notice.title,
      body: notice.body,
      // Approve + Open when exactly one approval is open; Open alone otherwise —
      // the phone's two categories (CATEGORY_REQUEST / CATEGORY_SESSION).
      actions: approvable ? [{ type: "button", text: "Approve" }, { type: "button", text: "Open" }] : [{ type: "button", text: "Open" }],
    });
    const forget = () => {
      if (live.get(notice.sessionId) === banner) live.delete(notice.sessionId);
    };
    banner.on("click", () => {
      forget();
      open(notice.path);
    });
    banner.on("action", (details, legacyIndex) => {
      forget();
      const index = typeof details?.actionIndex === "number" ? details.actionIndex : legacyIndex;
      if (approvable && index === 0) {
        // EXACTLY the request this banner was raised for, never whatever is open by now.
        pending.set(notice.request, notice.path);
        send({ type: DESKTOP_APPROVE, sessionId: notice.sessionId, requestId: notice.request });
      } else open(notice.path);
    });
    banner.on("close", forget);
    live.set(notice.sessionId, banner);
    banner.show();
  }

  return {
    /** Everything the server child sends arrives here; anything else is ignored. */
    handleServerMessage(message) {
      if (message?.type === DESKTOP_APPROVED) {
        const path = pending.get(message.requestId);
        pending.delete(message.requestId);
        // It did not land (already answered, superseded, engine refused): show
        // the session, so the person sees why instead of nothing.
        if (path && message.ok !== true) open(path);
        return;
      }
      const notice = parseNotice(message);
      if (!notice || !shouldNotifyDesktop(notice, context())) return;
      show(notice);
    },
    liveCount: () => live.size,
  };
}

module.exports = {
  DESKTOP_NOTIFICATIONS_ENV,
  DESKTOP_NOTICE,
  DESKTOP_APPROVE,
  DESKTOP_APPROVED,
  DESKTOP_PRESENCE,
  ACTIVE_IDLE_SECONDS,
  PRESENCE_BEAT_MS,
  presenceMessage,
  createPresenceReporter,
  parseNotice,
  routeOf,
  shouldNotifyDesktop,
  createDesktopNotifier,
};
