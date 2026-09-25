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
 * Pure and Electron-free, like window-target.js: main.js hands in the
 * Notification class, so the test drives a fake one.
 */

/** Declared twice on purpose — see apps/web/lib/mobile/desktop.ts. The test
 *  pins that both halves spell them the same. */
const DESKTOP_NOTIFICATIONS_ENV = "TELAR_DESKTOP_NOTIFICATIONS";
const DESKTOP_NOTICE = "telar:desktop-notification";
const DESKTOP_APPROVE = "telar:desktop-notification:approve";
const DESKTOP_APPROVED = "telar:desktop-notification:approved";
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
 * THE ONE PLACE THAT DECIDES WHETHER THIS MAC SHOWS A NOTICE.
 *
 * Today: not for the session on screen in the window the person is looking at
 * — they are already there. PR 2b ("Notify on: This Mac when active / iPhone
 * only / Both") extends `context` and adds its rule here, and nowhere else.
 *
 * @param {{ path: string }} notice
 * @param {{ focused?: boolean, viewingPath?: string | null }} context
 */
function shouldNotifyDesktop(notice, context = {}) {
  if (context.focused && context.viewingPath === notice.path) return false;
  return true;
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
  parseNotice,
  routeOf,
  shouldNotifyDesktop,
  createDesktopNotifier,
};
