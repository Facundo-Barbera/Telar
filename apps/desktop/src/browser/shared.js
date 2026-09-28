const CURSOR_MOVE_MS = 160;
const CURSOR_CLICK_LEAD_MS = 40;
const RPC_TIMEOUT_MS = 30_000;

const CAPTURE_TIMEOUT_MS = 8_000;
const CAPTURE_TIMEOUT_MESSAGE = "Screenshot timed out — the page has no frame to capture.";

const FREEZE_TIMEOUT_MS = 150;
const FREEZE_TIMEOUT_MESSAGE = "The page did not produce a frame in time to freeze.";

const BOUNDS_SETTLE_MS = 120;
const HIBERNATE_GRACE_MS = RPC_TIMEOUT_MS;

const MAX_LIVE_VIEWS = 6;

const MAX_TABS_PER_SCOPE = 12;

const CLOSED_BY_PERSON_MESSAGE =
  "The person closed the browser for this session, which closed the pages you had open in it. If you still need a browser, open it again with browser_tabs new.";

const HUMAN_ATTRIBUTION_GRACE_MS = 400;

const SYNTHETIC_REPORT_TTL_MS = 2_000;

const HUMAN_ACTIVE_MS = 1_500;

const DEFER_MAX_MS = 5_000;
const DEFER_POLL_MS = 100;

function humanActiveOn(tab, index) {
  return `The human is interacting with tab ${index} — ${tab.title || tab.url || "untitled"} — right now. Wait a moment and look again (snapshot or screenshot), or work in another tab.`;
}
function staleView(tab, index, why) {
  return `Tab ${index} — ${tab.title || tab.url || "untitled"} — changed since you last looked (${why}). Take a fresh snapshot or screenshot before acting on it.`;
}

const READ_TOOLS = new Set([
  "browser_snapshot",
  "browser_take_screenshot",
  "browser_console_messages",
  "browser_network_requests",
]);

function isReadTool(name, args) {
  return READ_TOOLS.has(name) || (name === "browser_tabs" && args?.action === "list");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, message) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

function createElectronView(options) {
  const { WebContentsView } = require("electron");
  return new WebContentsView(options);
}

function electronSessionFor(partition) {
  let session;
  try {
    ({ session } = require("electron"));
  } catch {
    return null;
  }
  return session?.fromPartition ? session.fromPartition(partition) : null;
}

function okText(text) {
  return { content: [{ type: "text", text }] };
}

function textOfResult(result) {
  return (result?.content || []).filter((part) => part.type === "text").map((part) => part.text).join(" ");
}

function errorResult(error) {
  return {
    content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
    isError: true,
  };
}

function navigationFlag(webContents, method) {
  const history = webContents.navigationHistory;
  return Boolean(history && typeof history[method] === "function" && history[method]());
}

const TAB_SELECT_CHORDS = Array.from({ length: 9 }, (_, index) => `CommandOrControl+${index + 1}`);

// Class methods are non-enumerable; mixed-in ones must be too.
function mixin(target, ...sources) {
  for (const source of sources) {
    for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(source))) {
      if (Object.hasOwn(target, name)) throw new Error(`mixin would replace ${name}`);
      Object.defineProperty(target, name, { ...descriptor, enumerable: false });
    }
  }
}

module.exports = { mixin, CURSOR_MOVE_MS, CURSOR_CLICK_LEAD_MS, RPC_TIMEOUT_MS, CAPTURE_TIMEOUT_MS, CAPTURE_TIMEOUT_MESSAGE, FREEZE_TIMEOUT_MS, FREEZE_TIMEOUT_MESSAGE, BOUNDS_SETTLE_MS, HIBERNATE_GRACE_MS, MAX_LIVE_VIEWS, MAX_TABS_PER_SCOPE, CLOSED_BY_PERSON_MESSAGE, HUMAN_ATTRIBUTION_GRACE_MS, SYNTHETIC_REPORT_TTL_MS, HUMAN_ACTIVE_MS, DEFER_MAX_MS, DEFER_POLL_MS, humanActiveOn, staleView, isReadTool, sleep, withTimeout, createElectronView, electronSessionFor, okText, textOfResult, errorResult, navigationFlag, TAB_SELECT_CHORDS };
