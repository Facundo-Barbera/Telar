"use strict";

const { SOUND } = require("./notification-sound");

const DESKTOP_NOTICE = "telar:desktop-notification";
const DESKTOP_APPROVE = "telar:desktop-notification:approve";
const DESKTOP_APPROVED = "telar:desktop-notification:approved";
const DESKTOP_PRESENCE = "telar:desktop-presence";
const DESKTOP_DISMISS = "telar:desktop-notification:dismiss";
const KINDS = new Set(["blocked", "finished", "failed"]);

const text = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max;

const appPath = (value) =>
  text(value, 1024) && value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\");

function parseNotice(message) {
  if (!message || typeof message !== "object" || message.type !== DESKTOP_NOTICE) return null;
  const { kind, sessionId, title, body, path, request, sound } = message;
  if (!KINDS.has(kind) || !text(sessionId, 256) || !text(title, 160) || !text(body, 200) || !appPath(path)) return null;
  if (request !== undefined && !text(request, 256)) return null;
  return { kind, sessionId, title, body, path, ...(request === undefined ? {} : { request }), ...(SOUND.test(sound) ? { sound } : {}) };
}

function routeOf(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

function shouldNotifyDesktop(notice, context = {}) {
  if (context.focused && context.viewingPath === notice.path) return false;
  return true;
}

const ACTIVE_IDLE_SECONDS = 120;

const PRESENCE_BEAT_MS = 15_000;

function presenceMessage({ idleState, locked, focused, viewingPath }) {
  const active = !locked && idleState === "active";
  return { type: DESKTOP_PRESENCE, active, viewingPath: active && focused && appPath(viewingPath) ? viewingPath : null };
}

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

function createDesktopNotifier({ Notification, send, context, open, chime }) {
  const live = new Map();

  const pending = new Map();

  function show(notice) {
    live.get(notice.sessionId)?.close();
    const approvable = notice.request !== undefined;
    const banner = new Notification({
      title: notice.title,
      body: notice.body,
      ...chime.options(notice.sound),
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
        pending.set(notice.request, notice.path);
        send({ type: DESKTOP_APPROVE, sessionId: notice.sessionId, requestId: notice.request });
      } else open(notice.path);
    });
    banner.on("close", forget);
    banner.on("show", () => chime.shown(notice.sound));
    live.set(notice.sessionId, banner);
    banner.show();
  }

  return {
    handleServerMessage(message) {
      if (message?.type === DESKTOP_DISMISS) {
        if (text(message.sessionId, 256)) live.get(message.sessionId)?.close();
        return;
      }
      if (message?.type === DESKTOP_APPROVED) {
        const path = pending.get(message.requestId);
        pending.delete(message.requestId);

        if (path && message.ok !== true) open(path);
        return;
      }
      const notice = parseNotice(message);
      if (!notice || !shouldNotifyDesktop(notice, context())) return;
      show(notice);
    },
    test(sounds) {
      const sound = `telar-${sounds}-done`;
      if (!SOUND.test(sound)) return { ok: false };
      const banner = new Notification({ title: "Telar", body: "This is how your alerts sound on this computer.", ...chime.options(sound) });
      banner.on("show", () => chime.shown(sound));
      banner.show();
      return { ok: true };
    },
    liveCount: () => live.size,
  };
}

module.exports = {
  DESKTOP_NOTICE,
  DESKTOP_APPROVE,
  DESKTOP_APPROVED,
  DESKTOP_PRESENCE,
  DESKTOP_DISMISS,
  ACTIVE_IDLE_SECONDS,
  PRESENCE_BEAT_MS,
  presenceMessage,
  createPresenceReporter,
  parseNotice,
  routeOf,
  shouldNotifyDesktop,
  createDesktopNotifier,
};
