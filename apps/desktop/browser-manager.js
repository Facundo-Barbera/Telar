const { randomUUID } = require("node:crypto");
const { pathToFileURL } = require("node:url");
const { isProtectedUrl } = require("./protected-urls");
const { ProfileRegistry, requireProjectKey } = require("./browser-profiles");
const { serializeInventory, parseInventory } = require("./browser-tab-store");
const { captureEntry } = require("./login-offer");
const {
  SitePermissionStore,
  PermissionPrompts,
  installSitePermissions,
  desktopCaptureSources,
  PERMISSION_KINDS,
} = require("./site-permissions");
const { browserContextMenuTemplate } = require("./browser-context-menu");

const CURSOR_MOVE_MS = 160;
const CURSOR_CLICK_LEAD_MS = 40;
const RPC_TIMEOUT_MS = 30_000;
/**
 * THE STANDARD VIEWPORT — what every tab lays out for unless a person or the
 * agent asks for another size. The same size the engine hands its headless
 * Chromium (browser/transport.ts), so an agent sees the same page in both.
 * It is the tab's INTRINSIC size: the panel's column width never changes it
 * (a narrower column scales the presentation — see `syncViewport`), so the
 * agent's snapshot, its click coordinates and what the human sees agree.
 */
const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
/** Kept under its old name for the callers/tests that speak of the
 *  unmounted case; it is the same standard size. */
const UNMOUNTED_VIEWPORT = DEFAULT_VIEWPORT;
/** Named sizes the toolbar and `browser_resize {preset}` offer. */
const VIEWPORT_PRESETS = {
  default: { width: 1280, height: 800, label: "Default" },
  laptop: { width: 1440, height: 900, label: "Laptop" },
  tablet: { width: 768, height: 1024, label: "Tablet" },
  phone: { width: 390, height: 844, label: "Phone" },
};
const VIEWPORT_MIN = 200;
const VIEWPORT_MAX = 5_000;
/** A rendered size is CSS width×height×scale²; bounded so a resize cannot
 *  ask the compositor for a wall of pixels. */
const VIEWPORT_MAX_AREA = 5_000 * 3_000;

/** A requested viewport → the clamped one, or a thrown reason. */
function resolveViewport(input) {
  if (input && typeof input === "object" && typeof input.preset === "string") {
    const preset = VIEWPORT_PRESETS[input.preset];
    if (!preset) throw new Error(`Unknown viewport preset ${JSON.stringify(input.preset)}. Presets: ${Object.keys(VIEWPORT_PRESETS).join(", ")}.`);
    return { width: preset.width, height: preset.height };
  }
  const width = Math.round(Number(input?.width));
  const height = Math.round(Number(input?.height));
  if (!Number.isFinite(width) || !Number.isFinite(height)) throw new Error("A viewport needs a numeric width and height, or a preset.");
  const clamp = (value) => Math.min(VIEWPORT_MAX, Math.max(VIEWPORT_MIN, value));
  let w = clamp(width);
  let h = clamp(height);
  if (w * h > VIEWPORT_MAX_AREA) h = Math.max(VIEWPORT_MIN, Math.floor(VIEWPORT_MAX_AREA / w));
  return { width: w, height: h };
}

/**
 * THE ZOOM LADDER — Chromium's own steps, so − and + land where a person who
 * has used a browser expects them to. The manager owns the ladder rather than
 * the panel: a factor is a page-level fact, and two surfaces stepping it with
 * two ladders would drift.
 */
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];

/** The next rung in `direction` from `factor`, clamped at both ends. `reset`
 *  is 1 whatever the current factor is. */
function zoomStep(factor, direction) {
  if (direction === "reset") return 1;
  const current = Number.isFinite(factor) && factor > 0 ? factor : 1;
  if (direction === "in") return ZOOM_STEPS.find((step) => step > current + 1e-6) ?? ZOOM_STEPS.at(-1);
  if (direction === "out") return [...ZOOM_STEPS].reverse().find((step) => step < current - 1e-6) ?? ZOOM_STEPS[0];
  throw new Error(`Unknown zoom direction ${JSON.stringify(direction)}. Use in, out or reset.`);
}

/** The colour scheme a tab is emulating, normalized. "system" is no override. */
function resolveColorScheme(value) {
  if (value === "light" || value === "dark" || value === "system") return value;
  throw new Error(`Unknown appearance ${JSON.stringify(value)}. Use light, dark or system.`);
}

/** Which preset (if any) a size is — the toolbar shows a name over numbers. */
function presetOf(viewport) {
  for (const [key, preset] of Object.entries(VIEWPORT_PRESETS)) {
    if (preset.width === viewport.width && preset.height === viewport.height) return key;
  }
  return null;
}

/**
 * PRESENTATION-ONLY FIT. The page keeps its intrinsic CSS viewport; when the
 * panel is narrower than that, the native view is scaled down to fit (never
 * up — a small page in a wide panel is shown at 1:1, centred). Returns the
 * scale and the native rect the view should occupy inside `bounds`.
 * Measured in a real Electron (Astra's probe, 2026-09-06): bounds 640×400
 * with `Emulation.setDeviceMetricsOverride {1280×800, scale: 0.5}` keeps
 * innerWidth/innerHeight at 1280×800, native input maps through the scale on
 * its own, and CDP `Input.dispatch*` takes NATIVE (scaled) coordinates.
 */
function fitViewport(viewport, bounds) {
  const scale = Math.min(1, bounds.width / viewport.width, bounds.height / viewport.height);
  const width = Math.max(1, Math.round(viewport.width * scale));
  const height = Math.max(1, Math.round(viewport.height * scale));
  return {
    scale,
    rect: {
      x: bounds.x + Math.max(0, Math.floor((bounds.width - width) / 2)),
      y: bounds.y + Math.max(0, Math.floor((bounds.height - height) / 2)),
      width,
      height,
    },
  };
}

/**
 * THE RECORDED EMULATION, AS ONE STRING. `tab.viewportOverride` holds this for
 * whatever was last sent (or the literal "native" when nothing is emulated),
 * and both the sender (`syncViewport`) and the geometry fast path's gate
 * (`emulationSettled`) format it HERE — two spellings of the same target would
 * let the gate skip a pass the sender still owed, or the sender re-send one the
 * gate already believed settled.
 */
function emulationKey(target) {
  return `${target.width}x${target.height}@${target.scale}`;
}

/** How long a capture of a hidden view may take before it is an error rather
 *  than a hang. A frame from a live compositor is milliseconds; anything
 *  approaching this means there is no frame coming. */
const CAPTURE_TIMEOUT_MS = 8_000;
const CAPTURE_TIMEOUT_MESSAGE = "Screenshot timed out — the page has no frame to capture.";
/**
 * THE FROZEN FRAME'S CEILING (#475). A menu appears on a click, and the
 * capture that has to land before the view goes down is spent out of that
 * same moment — so this is a budget, not a timeout for a hung page. Past it
 * the view is hidden plainly, exactly as it was before the frame existed.
 */
const FREEZE_TIMEOUT_MS = 150;
const FREEZE_TIMEOUT_MESSAGE = "The page did not produce a frame in time to freeze.";
const HIBERNATE_GRACE_MS = RPC_TIMEOUT_MS;
const MAX_LOG_ITEMS = 200;
/**
 * AND A CAP ON EACH ENTRY, NOT ONLY ON HOW MANY THERE ARE (issue #296).
 *
 * A console entry holds `arg.value ?? arg.description` — a whole large string,
 * or a whole large object's CDP preview — and a network entry holds
 * `request.url`, which for a `data:` or `blob:` request is the payload itself.
 * Two hundred uncapped entries is gigabytes per tab, and every tab in every
 * session has the debugger attached with Network/Runtime/Log enabled for the
 * life of the page, whether or not an agent ever asks for the logs.
 *
 * These are read back as plain text lines by an agent, where two thousand
 * characters is already more than anyone reads; a truncated line says so
 * rather than pretending it is whole.
 */
const MAX_LOG_TEXT = 2_000;

/** A captured log line, bounded. */
function logText(value) {
  const text = typeof value === "string" ? value : String(value ?? "");
  return text.length > MAX_LOG_TEXT ? `${text.slice(0, MAX_LOG_TEXT)}… (truncated, ${text.length} characters)` : text;
}

/**
 * Append and drop the oldest IN PLACE. The old `list = list.slice(-200)`
 * allocated a fresh two-hundred-element array on EVERY debugger message, on
 * the main thread, for every request and console line of every open page —
 * which is exactly the continuous main-thread JS #296's sample caught.
 */
function pushCapped(list, entry) {
  list.push(entry);
  if (list.length > MAX_LOG_ITEMS) list.shift();
}
const MAX_LIVE_VIEWS = 6;
// A human's browser rarely wants more; an agent's never should. Past the cap
// browser_tabs{new} answers an error naming the limit. t3code caps profiles
// at 24; tabs churn faster, so half that.
const MAX_TABS_PER_SCOPE = 12;

// --- The shared-browser interaction model ----------------------------------
// One tab, two hands, no owner. Direct human input WINS: while a human is
// actively interacting with a tab, an agent mutation on that tab DEFERS
// (briefly — it waits for the hands to lift, bounded), and once it may go it
// must have OBSERVED the page since the human's last input or since the last
// navigation. Anything the agent decided from a stale view is refused with the
// reason, never replayed. Conflicting actions on one tab are serialized;
// other tabs are independent. Nothing here is a lock that a human has to
// release: attention decays on its own.
//
// ATTRIBUTION IS STILL TEMPORAL. Agent-synthesized CDP input raises the same
// DOM events a human's hands do, so in-page input seen while an agent call is
// in flight, or within the grace of agent-dispatched input, belongs to the
// agent. The cockpit's own chrome (URL bar, tab strip) is human by construction.
const HUMAN_ATTRIBUTION_GRACE_MS = 400;
/** While an agent call is IN FLIGHT the coarse grace above would swallow a
 *  real human click. So every synthetic input the agent dispatches that will
 *  raise a preload report (a click's pointerdown, a key's keydown) is
 *  EXPECTED on the tab; the next report consumes one expectation and is the
 *  agent's. A report with nothing expected is a human interrupting, and the
 *  action is told so before its next mutation. Expectations expire: a hidden
 *  view delivers its echo late (measured ~1.1 s in the Electron regression),
 *  so the TTL clears that, and a dropped echo cannot swallow a real hand for
 *  longer than it. The preload's report throttle is short for the same
 *  reason — an echo it drops is an expectation that lingers. */
const SYNTHETIC_REPORT_TTL_MS = 2_000;
/** How long after the last human input a tab counts as "in the human's hands"
 *  for the purpose of deferring an agent mutation. */
const HUMAN_ACTIVE_MS = 1_500;
/** The most an agent mutation waits for the hands to lift before it is
 *  answered with "the human is still interacting" — never an indefinite lock. */
const DEFER_MAX_MS = 5_000;
const DEFER_POLL_MS = 100;

function humanActiveOn(tab, index) {
  return `The human is interacting with tab ${index} — ${tab.title || tab.url || "untitled"} — right now. Wait a moment and look again (snapshot or screenshot), or work in another tab.`;
}
function staleView(tab, index, why) {
  return `Tab ${index} — ${tab.title || tab.url || "untitled"} — changed since you last looked (${why}). Take a fresh snapshot or screenshot before acting on it.`;
}

// Reads never conflict with a human and never need a fresh view — they ARE
// the fresh view. Everything else changes the page or the tab set.
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

/** The promise, or `message` as an error once `ms` has passed. The timer is
 *  cleared either way so a settled capture leaves nothing behind. */
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

/** A partition's Chromium session, or null where there is no Electron to ask
 *  (the unit layer, which injects its own views and never opens one). */
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

/** Where words that are not an address go. Google for now; a setting can
 *  choose another engine later. */
const SEARCH_URL = "https://www.google.com/search?q=";

/** An IPv4 address, or a bracketed IPv6 one — a host with no dot in it
 *  (`[::1]`) still has to read as an address rather than as words. */
const IP_HOST = /^(\d{1,3}(?:\.\d{1,3}){3}|\[[\da-fA-F:]+\])$/;

/**
 * IS THIS AN ADDRESS, OR WORDS TO SEARCH FOR? The bar takes both, the way
 * every browser's does — "hello world" used to be normalized to
 * `http://hello world`, which throws, and the panel surfaced "Invalid URL"
 * at somebody who had simply typed a question into it.
 *
 * An address is: an absolute path (which means the file), an explicit
 * scheme, or — with no whitespace anywhere in it — something that names a
 * host: it contains a dot, or it is `localhost`, or it is an IP, each with
 * an optional port. Everything else is a search.
 */
function looksLikeAddress(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("/")) return true;
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)) return true;
  if (/\s/.test(trimmed)) return false;
  if (trimmed.includes(".")) return true;
  const host = trimmed.split(/[/?#]/, 1)[0].replace(/:\d+$/, "");
  return host === "localhost" || IP_HOST.test(host);
}

/** What "View Page Source" opens a tab on (#423). Chromium's own scheme, and
 *  the ONE non-web scheme the tabs render: it wraps a page rather than naming a
 *  resource of its own. */
const VIEW_SOURCE_PREFIX = "view-source:";

function normalizeUrl(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed || trimmed === "about:blank") return "about:blank";
  /**
   * `view-source:https://…` — accepted only around an ORDINARY WEB PAGE, and
   * never around itself. Nesting is what turns one scheme into a ladder
   * (`view-source:view-source:file:///…`), and reading a local file's source is
   * a thing the tab would do without the address bar ever admitting to it.
   */
  if (trimmed.toLowerCase().startsWith(VIEW_SOURCE_PREFIX)) {
    const inner = parseUrl(trimmed.slice(VIEW_SOURCE_PREFIX.length));
    if (!inner || (inner.protocol !== "http:" && inner.protocol !== "https:")) {
      throw new Error("The integrated browser only views the source of http and https pages.");
    }
    return `${VIEW_SOURCE_PREFIX}${inner.href}`;
  }
  // Words rather than an address: search for them instead of failing.
  if (!looksLikeAddress(trimmed)) return `${SEARCH_URL}${encodeURIComponent(trimmed)}`;
  // A bare local path in the address bar means the file, the way every
  // browser reads it. Only absolute paths — a relative one has no base here.
  const candidate = trimmed.startsWith("/")
    ? pathToFileURL(trimmed).href
    : /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)
      ? trimmed
      : `http://${trimmed}`;
  const parsed = new URL(candidate);
  // file: renders IN the sandboxed tab — createExternalLinkPolicy below still
  // refuses to hand it to shell.openExternal, which is the dangerous half.
  // The agent-side fence (which files a session may name) is the engine
  // socket's `fileUrlViolation`; here a human typing a path into their own
  // browser on their own machine is the same act as `open <file>`.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:" && parsed.protocol !== "file:") {
    throw new Error("The integrated browser only opens http, https and file URLs.");
  }
  return parsed.href;
}

function normalizePopupUrl(value) {
  const raw = String(value || "").trim();
  if (!raw || raw === "about:blank") return "about:blank";
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (isProtectedUrl(parsed.href)) return null;
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed.href;
}

// --- External-link policy (issue #35) ---------------------------------------
// The tabs this file owns are a feature: agents drive those WebContentsView
// instances and they must keep rendering in-app. Every OTHER link is the
// opposite case — an in-app window has no password manager, no session the user
// is already signed into, and no address bar to check an origin against, which
// is what makes MCP OAuth a repeated chore and a login page unverifiable. So
// the shell needs a rule that separates the two, and it belongs beside
// normalizeUrl: this file already owns every URL-scheme rule the desktop
// applies, and both rules answer one question — what may render inside Telar.
//
// Pure on purpose. main.js wires it to the app window's webContents only;
// nothing here ever reaches the tabs above.

// A denied window.open returns null to the renderer, and the popup pattern
// Telar's own MCP OAuth connect uses falls back to assigning location.href —
// the same URL arriving a second time, through will-navigate. Without
// suppression one click opens two browser tabs.
const EXTERNAL_OPEN_DEDUPE_MS = 2_000;

function parseUrl(value) {
  try {
    return new URL(String(value ?? ""));
  } catch {
    return null;
  }
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * `localhost:3000` AND `127.0.0.1:3000` ARE THE SAME SERVER, and a string
 * comparison of origins says they are not.
 *
 * The shell loads the cockpit as `http://127.0.0.1:<port>/`, so a link, a
 * redirect or an automated navigation that spells the same server `localhost`
 * was read as the open web: the navigation was cancelled and the page handed to
 * the system browser. Every attempt opened another browser window while the app
 * itself sat on "This page couldn't load", which is precisely the pair of
 * symptoms that made this worth finding.
 *
 * THE PORT AND SCHEME STILL HAVE TO MATCH. A different port on loopback is a
 * different server — a Vite dev server, someone else's app — and that case must
 * keep leaving for the browser. This widens the app's own identity by exactly
 * the set of names that resolve to this machine, and by nothing else.
 */
function sameLoopbackServer(target, appUrl) {
  if (target.protocol !== appUrl.protocol) return false;
  if (target.port !== appUrl.port) return false;
  return LOOPBACK_HOSTS.has(target.hostname) && LOOPBACK_HOSTS.has(appUrl.hostname);
}

function createExternalLinkPolicy({ appUrl, now = Date.now, dedupeMs = EXTERNAL_OPEN_DEDUPE_MS } = {}) {
  const parsedAppUrl = parseUrl(appUrl);
  // AD-11: without a usable origin this policy cannot tell Telar's own UI from
  // the web, and the failure mode is not "fail closed" — it is the app handing
  // its own pages to the system browser and refusing to render itself. The
  // caller always has a real URL by construction; a mistyped TELAR_DESKTOP_URL
  // is the one way to get here, and it has to stop the launch, not survive it.
  if (!parsedAppUrl || (parsedAppUrl.protocol !== "http:" && parsedAppUrl.protocol !== "https:")) {
    throw new Error(
      `External-link policy needs an http(s) app URL to recognise Telar's own UI; got ${JSON.stringify(appUrl ?? null)}.`,
    );
  }
  const appOrigin = parsedAppUrl.origin;
  let lastHref = null;
  let lastAt = 0;
  return {
    decide(target) {
      const parsed = parseUrl(target);
      // about:blank is the app opening a surface it navigates itself; that
      // navigation returns through this same policy, so allowing the blank
      // window costs nothing and leaves ordinary popup code working.
      if (
        parsed &&
        (parsed.href === "about:blank" || parsed.origin === appOrigin || sameLoopbackServer(parsed, parsedAppUrl))
      ) {
        return { action: "allow", openExternal: null };
      }
      // shell.openExternal hands whatever it is given to the OS — file://,
      // smb:// and every registered handler included — and model output can
      // contain links, so only the two web schemes are ever passed on.
      if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
        return { action: "deny", openExternal: null };
      }
      const at = now();
      if (parsed.href === lastHref && at - lastAt < dedupeMs) {
        // Reported rather than dropped: a suppressed hand-off is
        // indistinguishable from a broken link to the user, so the caller has
        // somewhere to say so.
        return { action: "deny", openExternal: null, duplicateOf: parsed.href };
      }
      lastHref = parsed.href;
      lastAt = at;
      // The parsed href, not the raw string: the OS receives exactly what was
      // validated here.
      return { action: "deny", openExternal: parsed.href };
    },
  };
}

/**
 * WHAT MAY BE HANDED TO THE SYSTEM BROWSER, and it is the ONE decision behind
 * the tab strip's "Open in system browser".
 *
 * `shell.openExternal` gives whatever it is given to the operating system.
 * `file://` opens a file; `smb://` mounts a share; on macOS any registered
 * scheme launches whatever registered it. The URL on a browser tab came from
 * the web or from an agent — which is to say, from nowhere trustworthy — so
 * the two web schemes are the whole allowlist, exactly as
 * `createExternalLinkPolicy` already decides for a clicked link.
 *
 * PARSED, NOT PREFIX-TESTED. `"https:/evil"`, `"javascript:\nhttps://x"` and a
 * leading-whitespace `" https://x"` all pass a `startsWith` and are not what
 * they look like; and what comes back is the PARSED href, so the OS is handed
 * exactly the string that was validated rather than the caller's original.
 *
 * `null` means refused, and every caller has to say so rather than falling
 * back to opening it some other way.
 */
function externalOpenTarget(value) {
  const parsed = parseUrl(value);
  if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) return null;
  return parsed.href;
}

function axValue(node, key) {
  const value = node?.[key]?.value;
  return value === undefined || value === null ? "" : String(value);
}

// --- What an agent reads back: the tree, the console, the network -----------
// The three answers that are as big as the page rather than as big as the
// question. They are PURE FUNCTIONS out here, away from the tab and the
// debugger, for one reason: the only way to know what a heavy page costs a
// model is to run the renderer over a heavy fixture, and nothing that needs a
// live CDP session can be handed two thousand nodes in a unit test. The engine
// puts a byte ceiling on all three (`apps/engine/src/browser/bounds.ts`); the
// narrowing arguments below are what its marker tells a model to reach for, so
// they have to actually narrow something.

/** Roles a later call can address. An `img` is in because describing one is
 *  half of what a model asks a page for. */
const SNAPSHOT_TARGETABLE_ROLES = new Set([
  "button", "checkbox", "combobox", "link", "menuitem", "radio", "searchbox",
  "slider", "spinbutton", "switch", "tab", "textbox", "treeitem",
]);
/** Indentation stops nesting here; the tree keeps going. Twelve levels of two
 *  spaces is already a quarter of a line spent on whitespace. */
const SNAPSHOT_MAX_INDENT = 12;
const SNAPSHOT_MAX_LINES = 500;

/** Every node's true depth, iteratively. Recursion here is a stack overflow on
 *  a page with a deep enough chain, which is a crash in the host process for
 *  the sake of a snapshot. */
function snapshotDepths(nodes, byId) {
  const depths = new Map();
  for (const node of nodes) {
    if (depths.has(node.nodeId)) continue;
    const chain = [];
    let walk = node;
    while (walk && !depths.has(walk.nodeId)) {
      chain.push(walk);
      walk = walk.parentId ? byId.get(walk.parentId) : undefined;
    }
    let depth = walk ? depths.get(walk.nodeId) : -1;
    for (let i = chain.length - 1; i >= 0; i--) depths.set(chain[i].nodeId, ++depth);
  }
  return depths;
}

/**
 * The accessibility tree, rendered.
 *
 * `rootNodeId` narrows to one subtree — what `browser_snapshot {target}` means
 * — and `maxDepth` cuts the tree off at a relative depth, which is what
 * `{depth}` means. Both are relative to the ROOT of what is being rendered, so
 * `{target: "e7", depth: 1}` reads "e7 and its children" whatever e7's
 * absolute depth in the document happens to be.
 *
 * Refs are minted fresh on every render, including a narrowed one: a ref is a
 * handle into the snapshot that produced it and was never portable between
 * two of them.
 */
function renderSnapshot(nodes, { title = "", url = "", rootNodeId = null, maxDepth = null } = {}) {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const depths = snapshotDepths(nodes, byId);
  const scoped = new Map();
  const inScope = (node) => {
    if (rootNodeId === null) return true;
    const chain = [];
    let walk = node;
    while (walk && !scoped.has(walk.nodeId)) {
      if (walk.nodeId === rootNodeId) break;
      chain.push(walk);
      walk = walk.parentId ? byId.get(walk.parentId) : undefined;
    }
    const answer = walk ? (walk.nodeId === rootNodeId ? true : scoped.get(walk.nodeId)) : false;
    for (const link of chain) scoped.set(link.nodeId, answer);
    return answer;
  };
  const rootDepth = rootNodeId === null ? 0 : depths.get(rootNodeId) ?? 0;
  const lines = [`Page: ${title}`, `URL: ${url}`, ""];
  const refs = new Map();
  let nextRef = 1;
  for (const node of nodes) {
    if (node.ignored) continue;
    if (!inScope(node)) continue;
    const relative = (depths.get(node.nodeId) ?? 0) - rootDepth;
    if (relative < 0) continue;
    if (maxDepth !== null && relative > maxDepth) continue;
    const role = axValue(node, "role");
    const name = axValue(node, "name").replace(/\s+/g, " ").trim();
    const value = axValue(node, "value").replace(/\s+/g, " ").trim();
    const backendNodeId = Number(node.backendDOMNodeId || 0);
    const canTarget = backendNodeId > 0 && (SNAPSHOT_TARGETABLE_ROLES.has(role) || role === "img");
    if (!name && !value && !canTarget) continue;
    let ref = "";
    if (canTarget) {
      ref = `e${nextRef++}`;
      refs.set(ref, backendNodeId);
    }
    const label = [role || "node", name ? `"${name}"` : "", value ? `value="${value}"` : "", ref ? `[ref=${ref}]` : ""]
      .filter(Boolean)
      .join(" ");
    lines.push(`${"  ".repeat(Math.min(SNAPSHOT_MAX_INDENT, relative))}- ${label}`);
    if (lines.length >= SNAPSHOT_MAX_LINES) {
      lines.push("- … snapshot truncated");
      break;
    }
  }
  return { text: lines.join("\n"), refs };
}

/**
 * How loud a console entry is. `level` on `browser_console_messages` is a
 * FLOOR — the schema has defaulted it to "info" since the tool shipped, and
 * until now the host ignored it and answered with everything, debug lines
 * included. Honouring it is what makes the engine's "narrow with `level`"
 * marker true rather than an instruction that changes nothing.
 *
 * `all: true` is the way back to everything.
 */
const CONSOLE_LEVEL_RANK = { debug: 0, verbose: 0, trace: 0, log: 1, info: 1, warning: 2, warn: 2, error: 3 };
const CONSOLE_DEFAULT_RANK = 1;

function consoleRank(level) {
  const rank = CONSOLE_LEVEL_RANK[String(level || "").toLowerCase()];
  return rank === undefined ? CONSOLE_DEFAULT_RANK : rank;
}

/** Console entries as text, oldest first — the order they happened in. The
 *  engine's bound keeps the TAIL, so the newest lines are the ones that get
 *  the budget without anything here having to reorder them. */
function renderConsole(entries, { level = "info", all = false } = {}) {
  const floor = all ? Number.NEGATIVE_INFINITY : consoleRank(level);
  const kept = entries.filter((entry) => consoleRank(entry.level) >= floor);
  if (kept.length === 0) {
    return entries.length === 0
      ? "No console messages captured."
      : `No console messages at ${level} or above (${entries.length} quieter ones captured — pass all: true for those).`;
  }
  return kept.map((entry) => `[${entry.level}] ${entry.text}`).join("\n");
}

/** Network rows as text, oldest first. `filter` is a plain substring over the
 *  URL, which is what the tool has always documented. */
function renderNetwork(entries, { filter = "" } = {}) {
  const needle = String(filter || "");
  const kept = entries.filter((entry) => !needle || entry.url.includes(needle));
  if (kept.length === 0) {
    return entries.length === 0
      ? "No network requests captured."
      : `No network requests matching "${needle}" (${entries.length} captured).`;
  }
  return kept.map((entry) => `${entry.method} ${entry.url}`).join("\n");
}

function navigationFlag(webContents, method) {
  const history = webContents.navigationHistory;
  return Boolean(history && typeof history[method] === "function" && history[method]());
}

/**
 * ⌘1..⌘9 WHILE A PAGE HAS THE KEYS (#660).
 *
 * The literal chords, not command ids, for the same reason the palette's
 * `QUICK_PICK_CHORDS` is a list of chords: this surface wants ⌘-and-a-digit and
 * has no opinion about which command is sitting on that chord today. Move the
 * rail's jumps to ⌥1..⌥9 in Settings and this claim suppresses nothing, while
 * the tab keys go on working.
 */
const TAB_SELECT_CHORDS = Array.from({ length: 9 }, (_, index) => `CommandOrControl+${index + 1}`);

class DesktopBrowserManager {
  constructor(window, dependencies = {}) {
    this.window = window;
    this.createView = dependencies.createView || createElectronView;
    this.createId = dependencies.createId || randomUUID;
    this.wait = dependencies.wait || sleep;
    /**
     * Electron's own module, reached LAZILY and through one seam — the page
     * context menu needs `Menu` and `clipboard`, and requiring either at load
     * time would put Electron in the import graph of every plain-`bun test`
     * that reads this file. A test hands in its own; nothing else does.
     */
    this.electron = dependencies.electron || (() => require("electron"));
    /**
     * THE HALF OF #660 THE RENDERER CANNOT DO: told which chords this browser's
     * pages have taken, so the shell can strip those accelerators.
     *
     * A claim from the cockpit renderer (`claimChords`) covers the panel's own
     * chrome, because that has DOM focus and a keydown to answer with. It cannot
     * cover a focused `WebContentsView`: the renderer gets no keydown at all
     * there, and the native focus is in another process. So this manager — which
     * is where that fact lives — publishes its own scope, and main UNIONS the
     * two rather than letting either overwrite the other.
     */
    this.onChordScope = dependencies.onChordScope || (() => {});
    /** The tab whose page currently holds the keys, or null. Id, not object, so
     *  a closed tab cannot keep a claim alive by being referenced. */
    this.keyFocusedTabId = null;
    this.tabs = [];
    /**
     * THE TAB THE HUMAN IS LOOKING AT. This drives visibility and the panel's
     * presentation, and NOTHING the agent does moves it — see `agentTabIds`.
     */
    this.activeTabIds = new Map();
    /**
     * THE TAB THE AGENT IS WORKING IN, which is a different question from the
     * one above and used to be answered by the same value.
     *
     * One pointer served both, so the two hands fought over it: clicking a tab
     * in the strip re-aimed the agent's next click at the tab you had just
     * opened, and an agent opening a page yanked your view away from whatever
     * you were reading. Neither is what either party asked for. Now the human's
     * view is `activeTabIds`, the agent's focus is here, and they are free to
     * be different tabs — which is what lets an agent work in the background
     * while you read something else in the same session.
     *
     * UNSET MEANS "WHEREVER THE HUMAN IS", so a session where the agent has
     * never opened a tab of its own still behaves as one shared tab — that is
     * the "look at this page" flow, and it must keep working. The agent takes
     * its own focus the moment it opens or selects a tab.
     *
     * NOT PERSISTED, deliberately: focus is a fact about a run, not about a
     * session, and an agent that comes back after a restart lists the tabs
     * before it does anything anyway.
     */
    this.agentTabIds = new Map();
    /**
     * A tab the agent was working in that somebody else closed, remembered
     * just long enough to say so once. Without this the agent's next call
     * would silently fall back to the human's tab — acting on a page nobody
     * asked it to touch. Read and cleared by `agentTab`.
     */
    this.agentTabClosed = new Map();
    this.visibleScopeKey = null;
    this.bounds = { x: 0, y: 0, width: 1, height: 1 };
    /**
     * BOUNDS ARE PER SCOPE. `this.bounds` is always the VISIBLE scope's;
     * every scope's last published rect is kept here, and becoming visible
     * adopts its own. Without this, a late `setBounds` for a session the
     * renderer had already left (an in-flight rAF/IPC during a route switch)
     * wrote the global rect and re-placed the OTHER session's view with it.
     */
    this.boundsByScope = new Map();
    /**
     * AND SO IS THE CORNER RADIUS (#475). The page fills the panel edge to
     * edge in fit mode, so the native view has to wear the panel's own
     * rounded corner or it overhangs it — and the panel's radius is a CSS
     * token the main process cannot read, so the renderer publishes it with
     * the rect it belongs to. Per scope for the same reason bounds are: a
     * late publish for a session the renderer has left must not round the
     * view another session is showing.
     */
    this.radiusByScope = new Map();
    this.version = 0;
    this.maxLiveViews = dependencies.maxLiveViews || MAX_LIVE_VIEWS;
    this.rpcTimeoutMs = dependencies.rpcTimeoutMs || RPC_TIMEOUT_MS;
    this.activeToolCalls = new Map();
    this.pendingPopupTabs = new Set();
    // Attribution is scope-level because agent input is dispatched per scope
    // call, whichever tab it lands in. Everything else lives ON THE TAB
    // (see createTab): the human's last input, the page generation the agent
    // last observed, and the per-tab action queue.
    this.lastAgentInputAt = new Map();
    this.now = dependencies.now || Date.now;
    // The shell forwards these to the engine journal (browser.control.changed)
    // and the renderer hears them through the ordinary state push.
    this.onControlChanged = dependencies.onControlChanged || null;
    /** `(scopeKey, url)` after a SUCCESSFUL top-level http(s) navigation —
     *  what feeds the start page's recent sites. Never an extension page,
     *  never a failed load. */
    this.onVisited = dependencies.onVisited || null;
    /** Extension surfaces that are open (popup, extension window), by id.
     *  Tracked for the leak diagnostics only: an open popup pauses nothing. */
    this.uiHolds = new Map(); // id → reason (popup, extension window)
    /**
     * THE LOGIN OFFER'S CAPTURE (AUTH-001, #195; login-offer.js). When a value
     * lands in a credential field, the page's ADDRESS, the tab's IDENTITY and
     * the moment are recorded here — metadata only, and IMMUTABLE: a redirect
     * after sign-in must not broaden what a later grant names, so nothing ever
     * rewrites a held capture. Handed to `onLoginEntryFinished` when the tab
     * that reported it navigates away; the offer flow re-checks it again at
     * confirmation time.
     */
    this.heldLoginCapture = null;
    this.onLoginEntryFinished = dependencies.onLoginEntryFinished || null;
    this._disposed = false;
    /** One inventory walk per turn of the event loop — see `persist`. */
    this._persistScheduled = false;
    /**
     * BROWSER PROFILES (browser-profiles.js). Each scope DECLARES the project
     * it belongs to — a project id, or the explicit `none` — before its first
     * tab, and the registry turns that into a NAMED PROFILE (an identity a
     * person labelled, which several projects may share). A scope nobody
     * declared gets NO tab: missing metadata fails closed instead of landing
     * every unlabelled session in one shared jar.
     *
     * THE PARTITION IS FIXED ON EACH TAB AT CREATION AND NEVER MOVES. Switching
     * a session's profile changes where the NEXT tab opens; the tabs already
     * open keep the identity they were signed into, and no live WebContents is
     * ever re-pointed at another partition (Chromium could not do it, and
     * silently doing it would put an agent on the wrong account).
     */
    this.profiles = dependencies.profiles || new ProfileRegistry(null);
    /** Told when the registry adopts a pre-profile cookie jar, so per-profile
     *  caches (recent sites) can follow the metadata. */
    this.onProfileMigrated = dependencies.onProfileMigrated || null;
    this.scopeProfiles = new Map(); // scopeKey → profile id
    this.scopeProjects = new Map(); // scopeKey → project key ("none" or a project id)
    /** A profile the PERSON chose for this session in the panel. It survives
     *  the engine re-declaring the same project every turn, and is dropped only
     *  when the session's project itself changes. */
    this.scopeProfileOverrides = new Map(); // scopeKey → profile id
    /** Extension hosts, ONE PER PARTITION: chrome.tabs of one project's
     *  1Password must not see another project's tabs, and the extension's
     *  own storage lives in the partition too. Created lazily by the shell
     *  through `createExtensionHost(partition)`; told about tabs of that
     *  partition only. */
    this.extensionHosts = new Map(); // partition → host
    this.createExtensionHost = dependencies.createExtensionHost || null;
    /**
     * SITE PERMISSIONS (site-permissions.js, #422). Camera, microphone,
     * notifications, location, clipboard and screen share, asked once per
     * origin per profile and remembered there.
     *
     * THE HANDLERS GO ON THE PARTITION, ONCE, the first time it gets a view —
     * `preparePartition` below. Without them Chromium's default applies, which
     * is to deny every request without asking, so a page's getUserMedia failed
     * with NotAllowedError as though a person had refused something they were
     * never shown.
     *
     * A manager with no store (a test, the smoke run) gets an EPHEMERAL one:
     * the prompts still work and nothing is written to disk.
     */
    this.sitePermissions = dependencies.sitePermissions || new SitePermissionStore(null);
    this.permissionPrompts =
      dependencies.permissionPrompts ||
      new PermissionPrompts({ deliver: (record) => this.deliverPermissionPrompt(record), now: this.now });
    /** Injected so the electron-free tests can seat stub handlers. */
    this.installSitePermissions = dependencies.installSitePermissions || installSitePermissions;
    /** The screen/window list a share picker draws, or null off Electron. */
    this.captureSources = dependencies.captureSources || desktopCaptureSources();
    /** The partition's Chromium session. Injected so nothing here imports
     *  electron at construction time; NULL outside a shell, which is a browser
     *  with no partitions to seat rather than an error worth logging. */
    this.sessionFor = dependencies.sessionFor || electronSessionFor;
    this.preparedPartitions = new Set();
    /**
     * THE PERSISTED TAB INVENTORY (browser-tab-store.js). The manager owns
     * every tab's lifetime — not the panel, not the renderer — so a session's
     * pages survive switching away, closing the panel, a renderer reload and
     * an app restart. Restored LAZILY: a remembered tab is a record with no
     * WebContents until something asks for it (the panel showing it, an agent
     * call), so a restart does not navigate every remembered page at once.
     * Only scoped metadata is written (see serializeInventory); the cookie
     * jar is the partition's, recomputed per profile at restore.
     */
    this.tabStore = dependencies.tabStore || null;
    this.restoreInventory(this.tabStore ? this.tabStore.load() : null);
    /**
     * THE COCKPIT ZOOMED, SO THE VIEW MOVES NOW (#895) — not on whatever the
     * renderer happens to publish next. A wheel zoom is the only one Electron
     * announces (`zoom-changed` is documented for exactly that); a View-menu
     * ⌘+/⌘− reaches us the other way, as the republished rect the renderer
     * sends when its own CSS viewport changes size. Both land on the same
     * placement, which reads the factor fresh, so neither path needs the
     * other to have fired.
     */
    this.window?.webContents?.on?.("zoom-changed", () => {
      if (this._disposed) return;
      this.applyVisibility();
    });
  }

  /** Seed remembered tabs as hibernated records. Nothing loads here. */
  restoreInventory(document) {
    for (const scope of parseInventory(document, this.profiles)) {
      if (this.scopeTabs(scope.scopeKey).length) continue;
      /**
       * A REMEMBERED SCOPE WHOSE PROFILE IS GONE IS DROPPED, NOT REHOMED. The
       * inventory names a profile id; if the registry no longer has it (a
       * hand-edited file), `parseInventory` already refused the scope rather
       * than opening its pages in whichever identity happened to be nearest.
       */
      const profile = scope.profile;
      this.scopeProfiles.set(scope.scopeKey, profile.id);
      if (scope.projectKey) this.scopeProjects.set(scope.scopeKey, scope.projectKey);
      if (scope.overridden) this.scopeProfileOverrides.set(scope.scopeKey, profile.id);
      for (const remembered of scope.tabs) {
        // A tab remembers ITS OWN profile: a session that switched profiles has
        // tabs of both, and each must come back in the jar it was signed into.
        const tabProfile = remembered.profileId ? this.profiles.get(remembered.profileId) : null;
        const tab = this.newTabRecord(scope.scopeKey, tabProfile || profile, remembered.openedBy);
        tab.id = remembered.id;
        tab.url = remembered.url;
        tab.title = remembered.title;
        if (remembered.viewport) tab.viewport = remembered.viewport;
        // LEGACY MIGRATION: inventories written before fit existed carry no
        // mode. A remembered NON-default size was an explicit choice and
        // stays fixed; a default/absent size was never chosen and becomes
        // fit, like every new tab.
        if (remembered.viewportMode === "fixed") tab.viewportMode = "fixed";
        else if (remembered.viewportMode === "fit") tab.viewportMode = "fit";
        else tab.viewportMode = remembered.viewport && presetOf(remembered.viewport) !== "default" ? "fixed" : "fit";
        tab.restored = true;
        this.tabs.push(tab);
      }
      this.activeTabIds.set(scope.scopeKey, scope.activeTabId);
    }
  }

  /** What the inventory file should say now. */
  inventory() {
    return serializeInventory({
      tabs: this.tabs.map((tab) => ({
        scopeKey: tab.scopeKey,
        id: tab.id,
        // A live view knows its URL better than the record (a redirect the
        // record has not caught up with); a hibernated tab IS the record.
        url: tab.view && !tab.view.webContents.isDestroyed() ? tab.view.webContents.getURL() || tab.url : tab.url,
        title: tab.title,
        openedBy: tab.openedBy,
        profileId: tab.profileId,
        ...(tab.viewport ? { viewport: tab.viewport } : {}),
        viewportMode: this.viewportModeOf(tab),
      })),
      profiles: this.scopeProfiles,
      projects: this.scopeProjects,
      overrides: this.scopeProfileOverrides,
      active: this.activeTabIds,
    });
  }

  /**
   * Schedule a write of the current inventory.
   *
   * COALESCED HERE, not only in the store (issue #296). `emitState` calls this
   * on every page event — a navigation, an in-page navigation, a title, a
   * favicon, a human's hands in the page — and `inventory()` walks EVERY tab
   * of EVERY scope, asking each live one for its URL across the Chromium
   * boundary. The store then throws all but the last document away within
   * 150 ms, so every walk but the last was work done for nothing, at a cost
   * proportional to the number of tabs the process has ever held. One walk
   * per turn of the event loop is enough, and the document it builds is the
   * newer one — which is what the store wanted anyway.
   */
  persist() {
    if (!this.tabStore || this._disposed || this._persistScheduled) return;
    this._persistScheduled = true;
    queueMicrotask(() => {
      this._persistScheduled = false;
      // Disposed, or the store taken away, while this was queued.
      if (!this.tabStore || this._disposed) return;
      this.tabStore.save(this.inventory());
    });
  }

  /**
   * Bind a scope to its PROJECT, and through the registry's ladder to a
   * profile. Idempotent for the same project key — the engine re-declares it
   * before every turn — and a change of PROJECT after tabs exist is refused:
   * the person closes the session's tabs first, which is what keeps a cookie
   * jar from following a session into another project.
   *
   * A change of PROFILE for the same project (an assignment made in the panel)
   * is allowed and is not a rebind: existing tabs keep their partition, the
   * next tab opens in the new identity.
   */
  declareProfile(scopeKey, projectKey) {
    const scope = this.requireScope(scopeKey);
    const key = requireProjectKey(projectKey);
    const current = this.scopeProjects.get(scope);
    if (current !== undefined && current !== key && this.scopeTabs(scope).length) {
      throw new Error(`Browser session ${scope} already has tabs in profile ${current}; close them before moving it to ${key}.`);
    }
    // A session's own profile choice belongs to the session it was made in. If
    // the project underneath it changed, the choice is not carried across.
    if (current !== undefined && current !== key) this.scopeProfileOverrides.delete(scope);
    this.scopeProjects.set(scope, key);
    const override = this.scopeProfileOverrides.get(scope);
    const profile = override ? this.profiles.require(override) : this.profiles.resolve(key);
    this.drainProfileMigrations();
    this.scopeProfiles.set(scope, profile.id);
    this.persist();
    return this.describeProfileBinding(scope, profile, key);
  }

  /**
   * THE PANEL'S PROFILE SWITCH. Chooses which identity this session's NEXT tab
   * opens in. Deliberately does NOT touch the tabs already open: their cookies
   * are the other profile's, their WebContents cannot change partition, and an
   * agent working in one of them stays exactly where it was.
   */
  setScopeProfile(scopeKey, profileId) {
    const scope = this.requireScope(scopeKey);
    const profile = this.profiles.require(profileId);
    this.scopeProfileOverrides.set(scope, profile.id);
    this.scopeProfiles.set(scope, profile.id);
    this.persist();
    this.emitState(scope);
    return this.describeProfileBinding(scope, profile, this.scopeProjects.get(scope) ?? null);
  }

  describeProfileBinding(scope, profile, projectKey) {
    return {
      scopeKey: scope,
      // The engine's own vocabulary: the key it declared. Unchanged on the wire.
      profileKey: projectKey,
      profileId: profile.id,
      label: profile.label,
      ...(profile.account ? { account: profile.account } : {}),
      partition: profile.partition,
    };
  }

  /** Replay the registry's metadata migrations onto whoever cares (recent
   *  sites), once each. Nothing on disk moves; only the key does. */
  drainProfileMigrations() {
    if (!this.profiles.migrations.length) return;
    const moves = this.profiles.migrations.splice(0, this.profiles.migrations.length);
    if (!this.onProfileMigrated) return;
    for (const move of moves) {
      try { this.onProfileMigrated(move.from, move.to); } catch { /* a cache is never worth a failed bind */ }
    }
  }

  /** The declared PROJECT key, or null: nothing is assumed for an unbound
   *  scope. (The identity it resolves to is `activeProfile`.) */
  profileOf(scopeKey) {
    return this.scopeProjects.get(this.requireScope(scopeKey)) || null;
  }

  /** The profile record a NEW tab in this scope would open in, or null. */
  activeProfile(scopeKey) {
    const id = this.scopeProfiles.get(this.requireScope(scopeKey));
    return id ? this.profiles.get(id) : null;
  }

  /** The partition a NEW tab in this scope would use. Throws for an unbound
   *  scope — the one place the fail-closed rule is enforced. */
  partitionOf(scopeKey) {
    const profile = this.activeProfile(scopeKey);
    if (!profile) throw new Error(`Browser session ${this.requireScope(scopeKey)} is not bound to a project profile yet; nothing can open until it is.`);
    return profile.partition;
  }

  /** Every profile a person may switch this session to, with the project
   *  assignments that make sharing visible. */
  listProfiles() {
    return this.profiles.list().map((profile) => ({ ...profile, projects: this.profiles.projectsOf(profile.id) }));
  }

  /**
   * WHY FORGETTING THIS PROFILE WOULD TAKE A PAGE WITH IT — the sentence to
   * refuse a delete with, or null when nothing this window holds is browsing
   * in it. Live state only the manager has: the registry knows about project
   * assignments and enforces those itself.
   *
   * A BINDING IS NOT A REASON; A TAB IS (#430). Delete used to refuse whenever
   * ANY scope in `scopeProfiles` named the profile — but a scope is bound the
   * moment it opens (`declareProfile`), and every remembered scope is bound
   * again at restore even with zero tabs, so on a machine that had been used
   * for a while every row refused and there was no way out. A bound scope with
   * nothing open loses nothing: its next tab walks the ladder again.
   *
   * WHAT WOULD ACTUALLY BREAK IS A TAB, and both kinds count. A tab signed
   * into this jar (`profileId`) is the obvious one; a tab of ANOTHER profile in
   * a session pointed at this one counts too, because `parseInventory` drops a
   * whole scope whose profile id the registry no longer has — so deleting under
   * it loses that session's remembered pages at the next restart. Hibernated
   * and restored tabs are tabs: the panel draws them in the strip, and they are
   * exactly what that restore would throw away.
   */
  whyProfileIsInUse(profileId) {
    const id = String(profileId || "").trim();
    if (!id) return null;
    const tabs = this.tabs.filter((tab) => tab.profileId === id || this.scopeProfiles.get(tab.scopeKey) === id);
    if (!tabs.length) return null;
    const sessions = new Set(tabs.map((tab) => tab.scopeKey)).size;
    const label = this.profiles.get(id)?.label || "that profile";
    return (
      `${sessions === 1 ? "A session has" : `${sessions} sessions have`} ` +
      `${tabs.length === 1 ? "a tab" : `${tabs.length} tabs`} open in “${label}”. ` +
      `Close ${tabs.length === 1 ? "it" : "them"}, or switch ${sessions === 1 ? "that session" : "those sessions"} to another profile, first.`
    );
  }

  /** The extension host for a partition, created on first use. */
  extensionHostFor(partition) {
    let host = this.extensionHosts.get(partition) || null;
    if (!host && this.createExtensionHost) {
      host = this.createExtensionHost(partition);
      if (host) this.extensionHosts.set(partition, host);
    }
    return host;
  }

  hostOfTab(tab) {
    return this.extensionHosts.get(tab.partition) || null;
  }

  /**
   * THE ORIGINS WITH A PAGE ON SCREEN, PER PARTITION — what the runaway-worker
   * watchdog asks so it can tell a service worker that is still serving
   * somebody from one whose pages all closed half an hour ago (#487).
   *
   * A LIVE VIEW, NOT A REMEMBERED TAB. A hibernated tab is a URL and no
   * renderer, and its origin's worker is exactly the kind that outlives its
   * pages — counting it would make every runaway look busy. The address is
   * read from the record rather than the WebContents when the view has not
   * committed one yet, so a tab mid-navigation still answers for where it is
   * going.
   */
  liveOriginsByPartition() {
    const byPartition = new Map();
    for (const tab of this.tabs) {
      const wc = tab.view && !tab.view.webContents?.isDestroyed?.() ? tab.view.webContents : null;
      if (!wc || !tab.partition) continue;
      let origin = null;
      try {
        origin = new URL(wc.getURL?.() || tab.url || "about:blank").origin;
      } catch {
        origin = null;
      }
      // "null" is what a URL with no host answers (about:blank, data:). A page
      // with no origin owns no service worker.
      if (!origin || origin === "null") continue;
      if (!byPartition.has(tab.partition)) byPartition.set(tab.partition, new Set());
      byPartition.get(tab.partition).add(origin);
    }
    return byPartition;
  }

  /** Every partition this manager has put a view in, plus any that got an
   *  extension host without one. What the watchdog walks to find workers. */
  activePartitions() {
    return new Set([
      ...this.preparedPartitions,
      ...this.extensionHosts.keys(),
      ...this.tabs.map((tab) => tab.partition).filter(Boolean),
    ]);
  }

  /** The extension host for a scope's profile, created on demand. Null when
   *  the scope is not bound yet or extensions are off — the caller then shows
   *  "unavailable" rather than throwing. */
  hostForScope(scopeKey) {
    let partition;
    try { partition = this.partitionOf(scopeKey); } catch { return null; }
    return this.extensionHostFor(partition);
  }

  /** Attach a host for ONE partition and tell it about that partition's live tabs. */
  attachExtensionHost(host, partition) {
    if (!partition) throw new Error("attachExtensionHost needs the partition the host serves.");
    this.extensionHosts.set(partition, host);
    for (const tab of this.tabs) if (tab.view && tab.partition === partition) host.addTab(tab.view.webContents, this.window);
  }

  // ── site permissions (site-permissions.js, #422) ─────────────────────────

  /**
   * SEAT THE PERMISSION HANDLERS ON A PARTITION, ONCE.
   *
   * Called before the first `WebContentsView` of a partition is created, which
   * is the only moment that matters: a session with no handler denies silently,
   * and a handler installed after a page has already asked is a page that has
   * already been refused. Idempotent per partition — every later tab in the
   * same jar finds them seated.
   *
   * A FAILURE HERE MUST NOT COST THE TAB. Without handlers the browser behaves
   * exactly as it did before this existed (Chromium's deny-by-default), which
   * is a browser missing a feature rather than a browser that will not open.
   */
  preparePartition(partition) {
    if (!partition || this.preparedPartitions.has(partition)) return;
    this.preparedPartitions.add(partition);
    let ses;
    try {
      ses = this.sessionFor(partition);
    } catch (error) {
      console.error(`[telar-desktop] could not reach the session for ${partition}: ${error && error.message ? error.message : error}`);
      return;
    }
    if (!ses) return;
    try {
      this.installSitePermissions(ses, {
        partition,
        store: this.sitePermissions,
        prompts: this.permissionPrompts,
        sources: this.captureSources,
        locate: (webContents) => this.locatePermission(webContents),
        onDenied: (context) => this.reportPermissionDenied(context),
      });
    } catch (error) {
      console.error(`[telar-desktop] could not install site permission handlers on ${partition}: ${error && error.message ? error.message : error}`);
    }
  }

  /**
   * Which session and tab a permission request belongs to. The handlers hand us
   * a WebContents (or, for a screen share, a WebFrameMain), and only the manager
   * knows which of its tabs that is — an unmatched one still gets a prompt, just
   * one the panel shows on whatever session is in front of the person.
   */
  locatePermission(source) {
    const id = source?.id ?? null;
    const url = typeof source?.url === "string" ? source.url : null;
    for (const tab of this.tabs) {
      if (!tab.view || tab.view.webContents.isDestroyed()) continue;
      const contents = tab.view.webContents;
      const matches = id !== null && contents.id === id;
      // A frame, not a WebContents: match by the page it is in.
      const sameFrame = !matches && url !== null && contents.getURL() === url;
      if (matches || sameFrame) return { scopeKey: tab.scopeKey, tabId: tab.id };
    }
    return { scopeKey: this.visibleScopeKey ?? null, tabId: null };
  }

  /** Push one question to the renderer. The panel draws it over the address
   *  bar of the session it names, and marks the tab if it is a background one. */
  deliverPermissionPrompt(record) {
    if (this.window.isDestroyed()) return;
    this.window.webContents.send("telar:browser:permission-request", record);
  }

  /** The human answered. Unknown ids are no-ops — see PermissionPrompts. */
  answerSitePermission(requestId, answer) {
    return { answered: this.permissionPrompts.answer(requestId, answer || {}) };
  }

  /** What is still being asked — everything, or one session's. The read a
   *  remounted panel makes so a reload does not strand a page on its prompt. */
  pendingPermissionPrompts(scopeKey) {
    return scopeKey ? this.permissionPrompts.pending(this.requireScope(scopeKey)) : this.permissionPrompts.pending();
  }

  /**
   * WHAT THIS SESSION'S PROFILE REMEMBERS — the lock popover's list. With an
   * `origin` it is that site's decisions; without one it is every site the
   * profile holds anything for.
   */
  scopeSitePermissions(scopeKey, origin) {
    const partition = this.partitionOf(scopeKey);
    return origin
      ? { partition, origin, kinds: this.sitePermissions.listOrigin(partition, origin) }
      : { partition, origins: this.sitePermissions.list(partition) };
  }

  /** Every decision this install holds, named by the profile that holds it —
   *  Settings ▸ Browser ▸ Site permissions. */
  listSitePermissions() {
    const labels = new Map(this.profiles.list().map((profile) => [profile.partition, profile]));
    return {
      kinds: PERMISSION_KINDS,
      profiles: this.sitePermissions.all().map((entry) => ({
        partition: entry.partition,
        // A jar whose profile record is gone is still listed, under its
        // partition: a decision you cannot see is a decision you cannot revoke.
        profileId: labels.get(entry.partition)?.id ?? null,
        label: labels.get(entry.partition)?.label ?? entry.partition,
        origins: entry.origins,
      })),
    };
  }

  /** Take one back. With no `kind`, the origin's whole row. */
  forgetSitePermission({ partition, scopeKey, origin, kind } = {}) {
    const jar = partition || this.partitionOf(scopeKey);
    if (!origin) throw new Error("Forgetting a site permission needs the origin it was given to.");
    this.sitePermissions.forget(jar, origin, kind === undefined || kind === null ? undefined : kind);
    return this.listSitePermissions();
  }

  /** macOS refused the device after the human allowed the site. Said on the
   *  panel's own error strip, because the page will only report NotAllowedError. */
  reportPermissionDenied(context) {
    if (this.window.isDestroyed()) return;
    this.window.webContents.send("telar:browser:permission-denied", { origin: context.origin, kinds: context.kinds, reason: context.reason });
  }

  /** Push fresh state to every scope with tabs — what a change to the profile
   *  REGISTRY (a rename, a new default) needs, since it is not scoped to one
   *  session but every panel shows it. */
  emitAllStates() {
    for (const scope of new Set([...this.tabs.map((tab) => tab.scopeKey), ...this.scopeProfiles.keys()])) this.emitState(scope);
  }

  /** An extension surface opened (popup, extension window). Tracked by id so
   *  the leak diagnostics can count them; nothing about the browser pauses. */
  addUiHold(id, reason) {
    const key = String(id);
    if (!this.uiHolds.has(key)) this.uiHolds.set(key, reason || "1Password");
  }

  /** That surface closed. */
  removeUiHold(id) {
    this.uiHolds.delete(String(id));
  }

  /** Whether a human has touched this tab within HUMAN_ACTIVE_MS. */
  humanActive(tab) {
    return tab.lastHumanInputAt !== undefined && this.now() - tab.lastHumanInputAt < HUMAN_ACTIVE_MS;
  }

  /** What a scope-level consumer means by "whose hands": the ACTIVE tab's
   *  recent activity — "human" while a human is interacting, "agent" while
   *  an agent call runs, else "idle". Advisory; nothing gates on it. */
  controllerOf(scopeKey) {
    const scope = this.requireScope(scopeKey);
    const tab = this.tabs.find((candidate) => candidate.scopeKey === scope && candidate.id === this.activeTabIds.get(scope));
    if (!tab) return "idle";
    return this.tabActivity(tab);
  }

  tabActivity(tab) {
    if (this.humanActive(tab)) return "human";
    if (tab.agentBusy > 0) return "agent";
    return "idle";
  }

  journalControl(tab, controller, options = {}) {
    if (tab.lastJournaled === controller) return;
    tab.lastJournaled = controller;
    if (this.onControlChanged) {
      try {
        this.onControlChanged({
          scopeKey: tab.scopeKey,
          tabId: tab.id,
          controller,
          // Only an interruption is worth a line in the conversation.
          ...(options.interrupted ? { interrupted: true } : {}),
          at: new Date(this.now()).toISOString(),
        });
      } catch {
        // The journal hook must never break the browser under it.
      }
    }
  }

  /**
   * A human's hands landed in ONE tab. `force` is for input that is human BY
   * CONSTRUCTION — the cockpit's URL bar and chrome — and skips the temporal
   * attribution in-page events need. Returns whether the input was attributed
   * to the human. Bumps the tab's generation: whatever the agent saw before
   * this is stale.
   */
  noteHumanInput(scopeKey, options = {}) {
    const scope = this.requireScope(scopeKey);
    const tab = options.tab ?? this.tabs.find((candidate) => candidate.scopeKey === scope && candidate.id === this.activeTabIds.get(scope));
    if (!tab) return false;
    if (!options.force) {
      const busy = (this.activeToolCalls.get(scope) || 0) > 0;
      // The agent's own echo: one expected report, consumed.
      const now = this.now();
      tab.expectedReports = tab.expectedReports.filter((at) => now - at < SYNTHETIC_REPORT_TTL_MS);
      if (tab.expectedReports.length) {
        tab.expectedReports.shift();
        return false;
      }
      if (!busy) {
        const recent = now - (this.lastAgentInputAt.get(scope) || 0) < HUMAN_ATTRIBUTION_GRACE_MS;
        if (recent) return false;
      }
    }
    // Human, by construction or by attribution. If an agent action is in
    // flight on this tab, it has been interrupted — whatever its source.
    const interrupted = tab.agentBusy > 0;
    if (interrupted) tab.interruptedAt = this.now();
    tab.lastHumanInputAt = this.now();
    tab.generation += 1;
    tab.staleReason = "the human interacted";
    this.journalControl(tab, "human", { interrupted });
    this.emitState(tab.scopeKey);
    return true;
  }

  /** The ipc path: a tab preload reported input — the sender IS the tab. */
  noteHumanInputFromWebContents(webContents) {
    const tab = this.tabs.find((candidate) => candidate.view && candidate.view.webContents === webContents);
    if (tab) this.noteHumanInput(tab.scopeKey, { tab });
  }

  /**
   * A VALUE LANDED IN A LOGIN FIELD — typed, pasted, or filled by the password
   * manager (browser-tab-preload.js). The ONLY thing this drives is the login
   * offer: nothing is paused, nothing is refused, and no agent tool notices.
   *
   * The origin is the TAB's top-level address at this moment — the same address
   * a fill's grant matching reads (secret-fill.ts uses originOf(tab.url)) —
   * captured now so a redirect cannot move it. `captureEntry` refuses non-web
   * schemes and missing identity.
   */
  noteLoginEntryFromWebContents(webContents, detail = {}) {
    const tab = this.tabs.find((candidate) => candidate.view && candidate.view.webContents === webContents);
    if (!tab) return;
    const capture = captureEntry({
      kind: detail.kind,
      origin: tab.url,
      profileId: tab.profileId,
      profileLabel: this.profiles.get(tab.profileId)?.label,
      tabUid: tab.id,
      at: this.now(),
    });
    if (!capture) return;
    this.heldLoginCapture = capture;
    // Which tab is mid-entry, so the navigation off it can close the entry.
    tab.loginEntryAt = this.now();
  }

  /**
   * THE ENTRY IS OVER (which is NOT proof the sign-in succeeded — the offer is
   * phrased as a permission question, login-offer.js). Leaving the page a
   * credential was typed into is what ends it: a form submit navigates, and a
   * page the person walked away from is not one to ask about any more.
   *
   * Consumed ONCE — the held capture is cleared here so the next entry starts
   * clean and one sign-in raises one question.
   */
  finishLoginEntry() {
    const capture = this.heldLoginCapture;
    this.heldLoginCapture = null;
    if (!capture || !this.onLoginEntryFinished) return;
    try {
      this.onLoginEntryFinished(capture);
    } catch {
      // The offer must never break the navigation path under it.
    }
  }

  /**
   * THE EXPLICIT OFFER'S CAPTURE — a person asking "remember the login on this
   * page" from the cockpit, with no automatic entry event to ride on. Built
   * from the scope's ACTIVE tab as it is NOW: the person is looking at the
   * page they mean, and their request IS the assertion an entry happened (the
   * `input` kind below is that assertion, not a page report). Null when the
   * page cannot carry a grant (non-web scheme, no tab).
   */
  loginCaptureForScope(scopeKey) {
    const scope = this.requireScope(scopeKey);
    const tab = this.tabs.find((candidate) => candidate.scopeKey === scope && candidate.id === this.activeTabIds.get(scope));
    if (!tab) return null;
    return captureEntry({
      kind: "input",
      origin: tab.url,
      profileId: tab.profileId,
      profileLabel: this.profiles.get(tab.profileId)?.label,
      tabUid: tab.id,
      at: this.now(),
    });
  }

  /** A navigation committed: the page the agent observed is gone. If a login
   *  value had landed in that page, leaving it is what ends the entry — the
   *  offer is asked here, once. The next document speaks for itself (an OTP
   *  step, a second factor) and raises its own entry if it has one. */
  noteNavigation(tab) {
    tab.generation += 1;
    tab.staleReason = "the page navigated";
    if (tab.loginEntryAt !== undefined) {
      tab.loginEntryAt = undefined;
      this.finishLoginEntry();
    }
  }

  /** A committed top-level navigation → `onVisited`, if it is one worth
   *  remembering: http(s), not an error page (status < 400; Electron reports
   *  0 for a non-HTTP/failed commit). */
  noteVisited(tab, url, httpResponseCode) {
    if (!this.onVisited) return;
    if (typeof httpResponseCode === "number" && (httpResponseCode === 0 || httpResponseCode >= 400)) return;
    let parsed;
    try { parsed = new URL(String(url || "")); } catch { return; }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
    if (isProtectedUrl(parsed.href)) return;
    try { this.onVisited(tab.scopeKey, parsed.href); } catch { /* a recorder's failure is not the page's */ }
  }

  /** A synthetic input is about to reach this tab's page. `reports` is how
   *  many preload reports it will raise (pointerdown/keydown: 1; insertText,
   *  a mouse move: 0). */
  stampAgentInput(tab, reports = 0) {
    const now = this.now();
    // EXPIRED HERE TOO, not only where one is CONSUMED. The TTL filter used to
    // live solely on `noteHumanInput`'s path, so an expectation whose echo
    // never arrived — a hidden view that dropped it, a page that reports
    // nothing, a subframe — sat in this array for the life of the tab and
    // grew with every agent click (#296). Pruning before the push keeps the
    // array to one TTL's worth of input, which is what it always meant.
    if (tab.expectedReports.length) {
      tab.expectedReports = tab.expectedReports.filter((at) => now - at < SYNTHETIC_REPORT_TTL_MS);
    }
    for (let i = 0; i < reports; i += 1) tab.expectedReports.push(now);
    this.lastAgentInputAt.set(tab.scopeKey, now);
  }

  /**
   * IMMEDIATELY BEFORE EACH MUTATION of a multi-step action: stop if this
   * action was cancelled (it timed out and a successor may have started), a
   * later action on the tab took the ticket, a human cut in, or the page
   * moved. `action` is the IMMUTABLE context minted for one invocation —
   * never read off the tab, so a stale continuation cannot see its
   * successor's values and pass. Throws so the step's caller unwinds.
   */
  checkpoint(action) {
    const { tab } = action;
    const index = () => Math.max(0, this.scopeTabs(tab.scopeKey).indexOf(tab));
    if (action.cancelled) throw new Error("Stopped: this action timed out.");
    if (!this.tabs.includes(tab)) throw new Error("The tab was closed.");
    if (action.ticket !== tab.ticket) throw new Error("Stopped: a later action on this tab has started.");
    if (tab.interruptedAt !== undefined && tab.interruptedAt >= action.startedAt) {
      throw new Error(`Stopped: ${humanActiveOn(tab, index())}`);
    }
    if (tab.generation !== action.generation) {
      throw new Error(`Stopped: ${staleView(tab, index(), tab.staleReason || "it changed")}`);
    }
  }

  /** An agent read saw the page as it is now. */
  noteObserved(tab) {
    tab.observedGeneration = tab.generation;
  }

  /** The tab's own ticket counter: a step still running after its successor
   *  started must not keep mutating the page. */
  nextTicket(tab) {
    tab.ticket = (tab.ticket || 0) + 1;
    return tab.ticket;
  }

  requireScope(scopeKey) {
    const value = String(scopeKey || "").trim();
    if (!value) throw new Error("A browser session scope is required.");
    return value;
  }

  scopeTabs(scopeKey) {
    const scope = this.requireScope(scopeKey);
    return this.tabs.filter((tab) => tab.scopeKey === scope);
  }

  /**
   * HOW SURELY THIS WINDOW'S BROWSER IS THE ONE A SESSION MEANS (issue #311).
   *
   * A panel request is answered by the window that sent it
   * (`requireBrowserManager(event)` in main.js), but the agent-facing control
   * server has no sender to resolve from: an agent names a SCOPE over HTTP. It
   * used to be answered from one global — the focused window's host — so a
   * session whose cockpit sits in a SECOND window had its `browser_*` tools
   * land on the first window's native views, silently and only ever with two
   * windows open.
   *
   * Three signals, strongest first, and each is a fact about THIS window rather
   * than about the scope: the scope is on screen here; a panel here published
   * bounds for it (the session's browser lives in this window even while
   * another panel tab is on top); this window holds live pages of it. Zero is
   * no claim, and the caller falls back to the window the human is in.
   *
   * A REMEMBERED TAB IS NOT A CLAIM. Every window's manager restores the same
   * inventory at construction (`restoreInventory`), so a hibernated record and
   * its profile binding say the scope EXISTED, not that it belongs here —
   * counting them would hand every scope to whichever window was built first,
   * which is the same bug wearing a different global.
   *
   * @param {string | null | undefined} scopeKey
   * @returns {number} 0 when this window has no claim; higher is surer.
   */
  scopeClaim(scopeKey) {
    const wanted = String(scopeKey ?? "").trim();
    if (!wanted || this._disposed || this.window?.isDestroyed?.()) return 0;
    /**
     * THE REQUEST NAMES A SESSION, THE WINDOW HOLDS ITS INSTANCES. Since #334 a
     * second Browser panel tab drives its own native browser under
     * `${sessionId}#${instanceId}` and only the first keeps the bare session id
     * — the one the engine drives. So a window holding `S#2` is the window
     * session S's browser is in, even before its first panel tab exists. The
     * scope key itself is never rewritten by this: it only locates the window.
     */
    const bySession = !wanted.includes("#");
    let best = 0;
    const consider = (scope, rank) => {
      if (typeof scope !== "string" || !scope) return;
      const exact = scope === wanted;
      if (!exact && !(bySession && scope.startsWith(`${wanted}#`))) return;
      const claim = exact ? EXACT_SCOPE_CLAIM + rank : rank;
      if (claim > best) best = claim;
    };
    consider(this.visibleScopeKey, SCOPE_CLAIM.visible);
    for (const scope of this.boundsByScope.keys()) consider(scope, SCOPE_CLAIM.panel);
    for (const tab of this.tabs) if (tab.view) consider(tab.scopeKey, SCOPE_CLAIM.pages);
    return best;
  }

  state(scopeKey) {
    const scope = this.requireScope(scopeKey);
    const tabs = this.scopeTabs(scope);
    const activeTabId = this.activeTabIds.get(scope) ?? null;
    const agentTabId = this.peekTarget(scope, {})?.id ?? null;
    return {
      scopeKey: scope,
      // The bound project key, or null until the engine/cockpit bind it.
      // Advisory in the state payload; binding happens before any tab opens.
      profileKey: this.profileOf(scope),
      /** The named identity new tabs open in, and every identity this session
       *  could be switched to — what the panel's profile menu renders. */
      profile: this.activeProfile(scope),
      profiles: this.listProfiles(),
      available: true,
      running: true,
      provider: "desktop",
      // Advisory only: what the ACTIVE tab is doing right now.
      controller: (() => { const tab = tabs.find((entry) => entry.id === activeTabId); return tab ? this.tabActivity(tab) : "idle"; })(),
      tabs: tabs.map((tab, index) => ({
        index,
        id: tab.id,
        title: tab.title || `Tab ${index + 1}`,
        url: tab.url || "about:blank",
        active: tab.id === activeTabId,
        /** The tab the agent's next un-addressed call acts on — which is not
         *  necessarily the one being shown. The strip marks it so you can see
         *  where the agent is working while you read something else. */
        agentFocus: tab.id === agentTabId,
        loading: tab.loading,
        controller: this.tabActivity(tab),
        openedBy: tab.openedBy || "agent",
        /** The identity THIS tab is signed into. Usually the session's active
         *  profile; different for a tab opened before a profile switch, and the
         *  strip says so rather than letting it look like the current one. */
        profileId: tab.profileId || null,
        favicon: tab.faviconUrl || null,
        // A remembered tab with no WebContents yet (restored from the
        // inventory, or hibernated): the panel shows it as a tab; the first
        // look at it loads the page.
        sleeping: !tab.view,
        /** DevTools are open on THIS tab — the strip's glyph, and what the
         *  ⌥⌘I toggle is toggling. Read live from the WebContents rather than
         *  tracked, so a window the person closed by its own button is not
         *  still being reported as open. */
        devtools: this.devToolsOpen(tab),
        viewport: this.viewportInfo(tab),
        /** The page zoom the options menu reads back (#473). */
        zoom: tab.zoom || 1,
        /** What this tab emulates for `prefers-color-scheme`. */
        colorScheme: tab.colorScheme || "system",
        /** This tab is in a window of its own right now, so the panel draws
         *  no page for it — see `openPreview`. */
        preview: this.previewing(tab),
        canGoBack: tab.view ? navigationFlag(tab.view.webContents, "canGoBack") : false,
        canGoForward: tab.view ? navigationFlag(tab.view.webContents, "canGoForward") : false,
      })),
      // How the ACTIVE tab is presented inside the panel's bounds: its
      // intrinsic size, the fit scale, and the native rect it occupies. The
      // renderer draws its device frame around that rect.
      presentation: (() => {
        const tab = tabs.find((entry) => entry.id === activeTabId);
        if (!tab) return null;
        const viewport = this.effectiveViewport(tab);
        const fit = this.isNativeFit(tab) ? { scale: 1, rect: { ...this.bounds } } : fitViewport(viewport, this.bounds);
        return { ...viewport, mode: this.viewportModeOf(tab), scale: fit.scale, rect: fit.rect, bounds: this.bounds, presets: VIEWPORT_PRESETS };
      })(),
      screenshot: null,
      error: null,
      version: this.version,
    };
  }

  /**
   * `extra` rides ONE PUSH and is not part of `state()`, deliberately: it
   * carries things that HAPPENED rather than things that ARE. `ended` is the
   * only one — the last tab of a scope closed — and a re-read of the state a
   * moment later must not still be saying it, or a panel reopened on that
   * scope would close itself the instant it asked what was there.
   */
  emitState(scopeKey, extra) {
    const scope = this.requireScope(scopeKey);
    this.version += 1;
    if (!this.window.isDestroyed()) {
      this.window.webContents.send("telar:browser:state", extra ? { ...this.state(scope), ...extra } : this.state(scope));
    }
    // Every emitted change is a change worth remembering; the store coalesces.
    this.persist();
  }

  /**
   * The tab's intrinsic viewport — its own, or the standard one.
   *
   * FIT MODE follows the visible stage: while the tab is shown with real
   * bounds, its viewport IS the stage size (scale 1, no letterbox). While
   * hidden (panel away, another session shown) it keeps the LAST size it
   * had on screen, so a background agent keeps working in the layout the
   * human last saw — never a 1×1 or a guess. `syncFitViewport` is what
   * writes that size, from the geometry pipeline, so this stays a read.
   */
  viewportOf(tab) {
    return tab.viewport || DEFAULT_VIEWPORT;
  }

  viewportModeOf(tab) {
    return tab.viewportMode === "fixed" ? "fixed" : "fit";
  }

  /**
   * WOULD THE FIT VIEWPORT MOVE? The size it would become, or `null` for "no
   * change". Pure — it writes nothing — so the geometry pipeline can ASK
   * before deciding whether this run owes any work at all, and `syncFitViewport`
   * stays the one writer.
   */
  fitViewportChange(tab) {
    if (this.viewportModeOf(tab) !== "fit" || !this.isTabVisible(tab)) return null;
    // A panel mid-animation (opening from 0, closing to 0) publishes tiny
    // bounds for a few frames. Those are not a size anyone chose: adopting
    // them would leave a background agent a 200×200 page. Below the
    // viewport minimum the last meaningful size is kept.
    // The stage, not the published rect: what the page lays out for is the
    // view's own pixels, so the cockpit's zoom is part of the size it adopts
    // (#895). At zoom 1 the two are the same number.
    const stage = this.stageBounds();
    if (stage.width < VIEWPORT_MIN || stage.height < VIEWPORT_MIN) return null;
    const next = resolveViewport({ width: stage.width, height: stage.height });
    const current = this.viewportOf(tab);
    if (next.width === current.width && next.height === current.height) return null;
    return next;
  }

  /** In fit mode, adopt the stage size as the viewport. Returns whether it
   *  changed (the caller bumps the generation / emits). */
  syncFitViewport(tab) {
    const next = this.fitViewportChange(tab);
    if (!next) return false;
    tab.viewport = next;
    return true;
  }

  /**
   * IS THE EMULATION ALREADY WHAT IT SHOULD BE? Asked WITHOUT binding a
   * debugger — that is the whole point: `ensureDebuggerOnly` is an await (and,
   * on a fresh tab, a real attach), so a drag frame that owes no CDP at all
   * must be able to find that out from the recorded override alone.
   */
  emulationSettled(tab) {
    const target = this.viewportTarget(tab);
    if (!target.emulate) return tab.viewportOverride === "native" || tab.viewportOverride === undefined;
    return tab.viewportOverride === emulationKey(target);
  }

  viewportInfo(tab) {
    const viewport = this.viewportOf(tab);
    return { width: viewport.width, height: viewport.height, preset: presetOf(viewport), mode: this.viewportModeOf(tab) };
  }

  /** Fit mode, on screen: the page IS the stage — no emulation, no
   *  presentation scale, whatever the recorded (retained) size says. */
  isNativeFit(tab) {
    return this.viewportModeOf(tab) === "fit" && this.isTabVisible(tab);
  }

  /**
   * THE COCKPIT'S OWN ZOOM (#895), and the one factor between two units that
   * look alike and are not.
   *
   * The View menu carries Electron's zoom roles, which zoom THIS window's
   * webContents, and Chromium remembers that per origin — one ⌘− is a 0.9×
   * cockpit across relaunches. Everything the renderer publishes (the panel's
   * rect, the host's size) is in CSS pixels of that zoomed page, while
   * `WebContentsView.setBounds` and the page inside the view speak the
   * window's device-independent pixels, which are `css × zoom`. Nothing used
   * to multiply, so at any zoom but 1 the view landed at `rect / zoom` from
   * the box the panel had drawn for it.
   *
   * READ FRESH, never cached: a zoom change is then a fact the next placement
   * picks up on its own, with no copy anywhere to go stale. NOT the per-tab
   * page zoom (`applyZoom`) — that is the page's own, a different quantity.
   */
  cockpitZoom() {
    const factor = this.window?.webContents?.getZoomFactor?.();
    return Number.isFinite(factor) && factor > 0 ? factor : 1;
  }

  /** A rect the renderer published (CSS px of the cockpit), in the window's
   *  own pixels — what `setBounds` takes. */
  windowRect(rect) {
    const zoom = this.cockpitZoom();
    return {
      x: Math.round(rect.x * zoom),
      y: Math.round(rect.y * zoom),
      width: Math.max(1, Math.round(rect.width * zoom)),
      height: Math.max(1, Math.round(rect.height * zoom)),
    };
  }

  /** The panel's rect in the window's own pixels: the stage the page is
   *  ACTUALLY laid out into, which is what a fit tab adopts as its viewport
   *  and what a capture clips to. */
  stageBounds() {
    return this.windowRect(this.bounds);
  }

  /** The viewport the page is ACTUALLY laid out for right now. */
  effectiveViewport(tab) {
    if (!this.isNativeFit(tab)) return this.viewportOf(tab);
    const stage = this.stageBounds();
    return { width: stage.width, height: stage.height };
  }

  /**
   * The rect the tab's view occupies inside the current bounds, IN THE
   * PANEL'S OWN CSS PIXELS — the units the renderer published and the units
   * it reads this back in (`presentation.rect`, the frozen frame's rect, both
   * of which subtract the host's own `getBoundingClientRect`). `windowRect`
   * is where it becomes something `setBounds` can take.
   */
  nativeRect(tab) {
    if (this.isNativeFit(tab)) return { ...this.bounds };
    return fitViewport(this.viewportOf(tab), this.bounds).rect;
  }

  /**
   * Set a tab's viewport: a preset or explicit size (→ fixed mode), or
   * `{ mode: "fit" }` / `{ mode: "fixed" }`. Agents and humans both come
   * through here; the page reflows wherever the tab is shown (or not), and
   * a snapshot taken before this is stale by definition. A failed emulation
   * puts the record back and throws — never a false "resized".
   */
  async resizeTab(tab, input) {
    const previous = { viewport: tab.viewport, mode: tab.viewportMode };
    const wantsFit = input && typeof input === "object" && input.mode === "fit";
    if (wantsFit) {
      tab.viewportMode = "fit";
      this.syncFitViewport(tab);
    } else {
      const explicit = input && typeof input === "object" && (input.preset !== undefined || input.width !== undefined || input.height !== undefined);
      if (explicit) tab.viewport = resolveViewport(input);
      else if (input?.mode !== "fixed") throw new Error("A viewport needs a preset, a width and height, or a mode.");
      tab.viewportMode = "fixed";
    }
    const current = this.viewportOf(tab);
    const before = previous.viewport || DEFAULT_VIEWPORT;
    const changed = current.width !== before.width || current.height !== before.height || (previous.mode === "fit") !== (tab.viewportMode === "fit");
    if (!changed) return current;
    try {
      await this.applyGeometry(tab);
    } catch (error) {
      tab.viewport = previous.viewport;
      tab.viewportMode = previous.mode;
      void this.applyGeometry(tab).catch(() => {});
      throw new Error(`Could not resize the viewport: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (current.width !== before.width || current.height !== before.height) {
      tab.generation += 1;
      tab.staleReason = "the viewport was resized";
    }
    this.emitState(tab.scopeKey);
    return current;
  }

  /** `ensureDebugger` without its trailing viewport sync (the geometry
   *  pipeline runs that itself so it can observe the failure). */
  async ensureDebuggerOnly(tab) {
    const debug = tab.view.webContents.debugger;
    if (!tab.debuggerReady) await this.ensureDebugger(tab, { sync: false });
    return debug;
  }

  /**
   * THE GEOMETRY PIPELINE — the one place a tab's native bounds and its
   * emulation are written, SERIALIZED PER TAB and LATEST-WINS.
   *
   * Before this, bounds and emulation were written from several unordered
   * paths (visibility, panel bounds, a resize, a resync) and each read the
   * state at its own moment: a preset change could set the view's bounds
   * for the new size while an older emulation was still in flight, or a
   * resync could re-apply bounds computed before a resize landed — a view
   * hanging outside the panel until the next real re-layout put it back.
   *
   * Here every trigger only SCHEDULES; the run reads the state at execution
   * time, sets the fitted bounds, applies the emulation, then re-asserts the
   * bounds once the emulation has settled. Triggers that arrive mid-run
   * coalesce into ONE further run (latest state), never a backlog.
   */
  applyGeometry(tab) {
    const geometry = (tab.geometry ||= { queue: Promise.resolve(), scheduled: null });
    if (geometry.scheduled) return geometry.scheduled;
    const run = geometry.queue.then(() => {
      geometry.scheduled = null;
      return this.applyGeometryNow(tab);
    });
    geometry.scheduled = run;
    geometry.queue = run.catch(() => undefined);
    return run;
  }

  async applyGeometryNow(tab) {
    const view = tab.view;
    if (!view || view.webContents.isDestroyed?.()) return;
    const place = () => {
      if (tab.view !== view || view.webContents.isDestroyed?.()) return;
      this.applyBorderRadius(tab, view);
      // PREVIEWED: the view fills its own window and the panel's visibility
      // rules do not apply to it (#473).
      // A PREVIEWED TAB IS NOT THIS WINDOW'S, so the cockpit's zoom is not
      // its: `previewRect` reads its own window's content size, which is
      // already in that window's pixels (#895).
      if (this.previewing(tab)) {
        view.setVisible(true);
        view.setBounds(this.previewRect(tab));
        return;
      }
      // Shown = the visible scope's active tab, bounds or not (a panel that
      // has not published bounds yet still owns the view); the fit SCALE is
      // what waits for real bounds (isTabVisible, in viewportTarget).
      // A BLANK TAB SHOWS NO NATIVE VIEW: the panel draws its start page
      // (recent sites, local servers) in the DOM there, and the native
      // layer would cover it. The view stays live and placed, only hidden;
      // the first navigation (did-start-loading → sync → emitState →
      // applyVisibility) reveals it.
      const shown = this.isTabShown(tab) && !this.isBlank(tab);
      view.setVisible(shown);
      // THE ONE SEAM where the panel's CSS pixels become the window's (#895).
      if (shown) view.setBounds(this.windowRect(this.nativeRect(tab)));
    };
    // THE DRAG FAST PATH. A panel resize handle publishes bounds every frame,
    // and the overwhelming majority of those frames owe the page NOTHING: the
    // stage is the same size as the last one placed (the panel moved, or the
    // renderer republished), the fit viewport would not change, the emulation
    // already says what it should, and no appearance is pending. Such a frame
    // is one native `setBounds` — no `persist`, no `ensureDebuggerOnly` (an
    // await, and on a cold tab a real debugger attach), no CDP round trip.
    //
    // Placing FIRST is what makes that possible, and costs nothing: `nativeRect`
    // reads only `bounds`, the viewport and visibility — never anything
    // `syncFitViewport` writes — so on a run that does go on to sync the fit
    // viewport, the trailing `place()` re-asserts the rect exactly as before.
    //
    // ALL THREE READS ARE LOAD-BEARING. Gating on the stage size alone would
    // starve `resizeTab`'s preset path, which changes the emulation target
    // while the stage stands still.
    place();
    const placed = tab.lastPlaced;
    tab.lastPlaced = { width: this.bounds.width, height: this.bounds.height };
    if (
      placed &&
      placed.width === this.bounds.width &&
      placed.height === this.bounds.height &&
      this.fitViewportChange(tab) === null &&
      this.emulationSettled(tab) &&
      !this.needsColorScheme(tab)
    ) {
      this.applyZoom(tab);
      return;
    }
    // Fit mode adopts the stage size FIRST, so the bounds and the emulation
    // below describe the same viewport.
    if (this.syncFitViewport(tab)) {
      tab.generation += 1;
      tab.staleReason = "the viewport was resized";
      this.persist();
    }
    const debug = await this.ensureDebuggerOnly(tab);
    if (tab.view !== view) return;
    await this.syncViewport(tab, debug);
    // Zoom and appearance ride the same pipeline (#473): both are page-level
    // facts a new document forgets, and dom-ready runs this.
    this.applyZoom(tab);
    if (this.needsColorScheme(tab)) await this.applyColorScheme(tab, debug);
    // The state may have moved while the emulation was in flight; the
    // coalesced follow-up run handles that. This re-assert covers the case
    // where nothing else changed but the view's bounds were written before
    // the emulation existed.
    place();
  }

  /**
   * THE PANEL'S CORNER, ON THE NATIVE VIEW (#475).
   *
   * A `WebContentsView` ignores the CSS radius of the element it is glued to —
   * it is composited above this renderer's DOM, not clipped by it — which is
   * why the host used to sit 8px inside the panel card to clear its corner.
   * Now the page fills the panel instead, and `setBorderRadius` is what keeps
   * it from overhanging the panel's own rounded rectangle. Electron rounds all
   * four corners with one number; the two that meet the address row above read
   * as the page tucking under the toolbar.
   *
   * WRITTEN ONLY ON A CHANGE. It is called from `place()`, which runs on every
   * bounds publish (the renderer's self-heal resends the same rect), and a
   * re-round per frame is a compositor change per frame for nothing.
   * OPTIONAL CALL: the API landed in Electron 36, and a square view is the
   * honest fallback below that rather than a crash on a panel bounds sync.
   */
  applyBorderRadius(tab, view) {
    // A previewed tab fills a window of its own, whose corners are the OS's
    // to round — the panel's radius is not its (#473).
    const radius = this.previewing(tab) ? 0 : this.radiusByScope.get(tab.scopeKey) || 0;
    if (tab.borderRadius === radius) return;
    tab.borderRadius = radius;
    view.setBorderRadius?.(radius);
  }

  applyVisibility() {
    for (const tab of this.tabs) {
      if (!tab.view) continue;
      // A previewed tab is its own window's; the pipeline still re-places it
      // there, but nothing here may hide it (#473).
      if (this.previewing(tab)) {
        this.applyGeometry(tab).catch(() => {});
        continue;
      }
      const active = tab.scopeKey === this.visibleScopeKey && tab.id === this.activeTabIds.get(tab.scopeKey);
      // Hide immediately (a switched-away tab must not linger a frame);
      // the shown one is placed by the pipeline with its emulation.
      if (!active) tab.view.setVisible(false);
      this.applyGeometry(tab).catch(() => {});
    }
  }

  setBounds(scopeKey, input) {
    const next = {
      x: Math.max(0, Math.round(Number(input?.x) || 0)),
      y: Math.max(0, Math.round(Number(input?.y) || 0)),
      width: Math.max(1, Math.round(Number(input?.width) || 1)),
      height: Math.max(1, Math.round(Number(input?.height) || 1)),
    };
    const scope = this.requireScope(scopeKey);
    this.boundsByScope.set(scope, next);
    // The panel's own corner, in device-independent pixels, rides the rect it
    // applies to (#475). Absent — an older renderer, or a fixed viewport whose
    // stage sits inside a padded host — means a square view, as before.
    this.radiusByScope.set(scope, Math.max(0, Math.round(Number(input?.radius) || 0)));
    // ANOTHER SCOPE'S RECT NEVER MOVES THE VISIBLE VIEW: remembered for when
    // that scope is shown, applied to nothing now.
    if (this.visibleScopeKey && this.visibleScopeKey !== scope) return;
    const same = next.x === this.bounds.x && next.y === this.bounds.y && next.width === this.bounds.width && next.height === this.bounds.height;
    this.bounds = next;
    // A republish of unchanged bounds is still a request to re-place the
    // view (the renderer's self-heal); the pipeline makes it cheap.
    this.applyVisibility();
    if (!same && this.visibleScopeKey) this.emitState(this.visibleScopeKey);
  }

  async setVisible(scopeKey, visible) {
    const scope = this.requireScope(scopeKey);
    if (visible) {
      this.visibleScopeKey = scope;
      // The scope being shown takes ITS OWN last rect (the renderer publishes
      // bounds before visibility, so it is normally already here).
      const own = this.boundsByScope.get(scope);
      if (own) this.bounds = own;
      for (const tab of this.scopeTabs(scope)) {
        if (!tab.destroyWhenIdle) this.cancelDeferredHibernate(tab);
      }
      const active = this.scopeTabs(scope).length ? this.activeTab(scope) : null;
      if (active) {
        try {
          await this.wakeTab(active);
        } catch {
          // The native view still renders Electron's navigation failure page.
          // Visibility restoration must not become an unhandled renderer
          // rejection merely because the remembered local server is offline.
        }
      }
    }
    else if (this.visibleScopeKey === scope) this.visibleScopeKey = null;
    // Awaited for the shown scope's active tab, so a caller (the panel's
    // viewport hook, a harness) observes the view placed when this resolves.
    await this.applyVisibilityAsync(scope);
  }

  /**
   * HIDE THE VIEW BEHIND A MENU WITHOUT THE PAGE BLINKING OUT (#475).
   *
   * Every menu in the right panel takes the native view down while it is open
   * — it has to, because Electron composites the view ABOVE this renderer's
   * DOM and a portal menu under it is the same as no menu at all
   * (`lib/native-view-overlay.ts`). What the person sees is the page vanish
   * and come back on every ⋯.
   *
   * There is no way to draw DOM over a `WebContentsView`, so the honest trick
   * is a FROZEN FRAME: the last pixels of the page, handed to the renderer to
   * paint into the host at the view's own rect, so the panel still looks like
   * the page is there while the menu is open. Nothing about it is live — it is
   * a picture, and it goes the moment the real view is back.
   *
   * ONE CALL, BECAUSE THE ORDER IS THE WHOLE POINT. Capture, THEN hide. A
   * renderer that hid first and captured after would be asking a view with no
   * compositor frame for one — the blink this exists to remove, with a stall
   * on top. A capture that fails or outruns FREEZE_TIMEOUT_MS answers null and
   * the view is hidden plainly, exactly as it was before this existed.
   */
  async freezeView(scopeKey) {
    const scope = this.requireScope(scopeKey);
    const frame = await this.captureFrozenFrame(scope);
    await this.setVisible(scopeKey, false);
    return frame;
  }

  /** The visible page's own pixels and the rect they occupy, or null when
   *  there is nothing to freeze (no tab, a blank one, a tab in a window of
   *  its own, a capture that failed or ran past its budget). */
  async captureFrozenFrame(scope) {
    if (this.visibleScopeKey !== scope) return null;
    const tab = this.scopeTabs(scope).length ? this.activeTab(scope) : null;
    if (!tab?.view || tab.view.webContents.isDestroyed?.()) return null;
    // The same three cases that make the view invisible in `place()`: there
    // are no pixels behind a start page, a previewed tab or a 1×1 panel.
    if (!this.isTabVisible(tab) || this.isBlank(tab) || this.previewing(tab)) return null;
    const rect = this.nativeRect(tab);
    try {
      const image = await withTimeout(tab.view.webContents.capturePage(), FREEZE_TIMEOUT_MS, FREEZE_TIMEOUT_MESSAGE);
      if (!image || image.isEmpty()) return null;
      return { data: image.toPNG().toString("base64"), mimeType: "image/png", rect };
    } catch {
      // A page with no frame to give is not an error anyone can act on: the
      // menu still has to open, and the view still has to go down for it.
      return null;
    }
  }

  /** applyVisibility, awaiting the scope's active tab's own placement. */
  async applyVisibilityAsync(scope) {
    this.applyVisibility();
    const activeId = this.activeTabIds.get(scope);
    const active = this.tabs.find((tab) => tab.scopeKey === scope && tab.id === activeId);
    // The queue TAIL, not the scheduled run: a run already in flight when
    // this was called reads stale visibility, and it is the coalesced
    // follow-up (queued behind it) that places the view for this state.
    if (active?.geometry) await active.geometry.queue;
  }

  /**
   * THE RENDERER IS RELOADING (main.js did-start-loading). The native view
   * outlives the document, and React gets no cleanup pass, so hide it here;
   * the remounted panel publishes fresh bounds and shows it again. HIDE,
   * NEVER RELEASE: this used to hibernate the scope, which tore down a page an
   * agent was working in (a background action's WebContents gone mid-call) and
   * threw away every other scope's warm view for a reload of the cockpit's
   * own chrome. The manager owns the tabs' lifetime; a reload is the cockpit's
   * business, not the pages'. The live-view budget still bounds memory.
   */
  hideVisibleScope() {
    const scope = this.visibleScopeKey;
    if (!scope) return;
    this.visibleScopeKey = null;
    this.applyVisibility();
    this.emitState(scope);
  }

  /** What a tab of this partition renders under. A POPUP never gets these —
   *  Chromium fixes an opened window's preferences from its opener's and hands
   *  the WebContents over already built (see `adoptPopupTab`) — so this is for
   *  the two paths that do make their own: an ordinary tab, and the popup
   *  fallback for an Electron that gave us no guest to adopt. */
  tabWebPreferences(tab) {
    return {
      partition: tab.partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Runs the (sandboxed, isolated) preload in SUBFRAMES too, so a login
      // form inside an iframe reports its entry. Despite the name this
      // enables no Node in any frame: sandbox stays on.
      nodeIntegrationInSubFrames: true,
      // The human-input reporter (see browser-tab-preload.js) — how a click
      // in the page becomes a control-model takeover in the main process.
      preload: require("node:path").join(__dirname, "browser-tab-preload.js"),
      // Chromium's built-in PDF viewer is a "plugin"; without this a PDF
      // navigation downloads instead of rendering. Enables nothing else.
      plugins: true,
    };
  }

  createViewForTab(tab) {
    // BEFORE THE VIEW, NOT AFTER: a page may ask for the camera on its first
    // frame, and a session with no handler denies without asking (#422).
    this.preparePartition(tab.partition);
    return this.attachView(tab, this.createView({ webPreferences: this.tabWebPreferences(tab) }));
  }

  /**
   * A POPUP'S VIEW: the WebContents already exists and is ADOPTED rather than
   * replaced. `new WebContentsView({ webContents })` is the Electron API for
   * exactly that, and it is what keeps `window.opener` alive — see
   * `decidePopup` for why a second WebContents is not an option here.
   *
   * `guest` absent is the belt-and-braces path for an Electron that called
   * `createWindow` without handing one over: a view of our own, on the
   * OPENER'S partition, which loses the opener edge but never the identity.
   */
  adoptViewForTab(tab, guest) {
    this.preparePartition(tab.partition);
    const view = guest
      ? this.createView({ webContents: guest })
      : this.createView({ webPreferences: this.tabWebPreferences(tab) });
    return this.attachView(tab, view);
  }

  /** Everything a fresh view needs once it exists, whoever made the
   *  WebContents inside it. */
  attachView(tab, view) {
    // Let the themed renderer host show through while a page is navigating.
    // An opaque white native underlay otherwise appears as a strip whenever
    // its bounds update a frame ahead of the surrounding right-panel layout.
    view.setBackgroundColor("#00000000");
    view.setVisible(false);
    this.window.contentView.addChildView(view);
    tab.view = view;
    tab.hibernating = false;
    tab.refs.clear();
    tab.console = [];
    tab.network = [];
    tab.debuggerReady = false;
    tab.debuggerListenersBound = false;
    // A new WebContents has no emulation: forget what the old one was told.
    tab.viewportOverride = undefined;
    tab.colorSchemeApplied = undefined;
    // A new view is square, whatever the old one had been rounded to (#475).
    tab.borderRadius = undefined;
    this.bindTab(tab);
    // THE INTRINSIC VIEWPORT APPLIES TO EVERY VIEW, NOT ONLY AGENT-INSPECTED
    // ONES. The emulation rides the debugger, and the debugger used to attach
    // only on an agent's first tool call — so a tab a human opened from the
    // toolbar laid out for the raw column (measured: toolbar said 1280×800
    // 48%, the page said 616×385). Attach now; a view that refuses (a crashed
    // renderer) is re-tried at dom-ready and by every resync.
    this.ensureViewport(tab).catch(() => {});
    return view;
  }

  /** Attach the debugger if needed and apply this tab's viewport — through
   *  the serialized pipeline, so it cannot race a resize or a bounds change. */
  ensureViewport(tab) {
    return this.applyGeometry(tab);
  }

  async wakeTab(tab) {
    tab.lastUsedAt = Date.now();
    if (tab.view) return tab;
    const view = this.createViewForTab(tab);
    await this.readyHostForTab(tab, view);
    const destination = normalizeUrl(tab.url);
    // A restored tab's first wake is its first navigation in this process —
    // lazy by design (nothing loaded at startup), and now that someone asked
    // for it, this is exactly when it should load.
    tab.restored = false;
    if (destination !== "about:blank") await this.loadTab(tab, destination);
    this.enforceLiveViewBudget(tab);
    return tab;
  }

  /**
   * WAIT FOR THE PARTITION'S EXTENSION HOST BEFORE THE FIRST NAVIGATION. The
   * host loads lazily and asynchronously (install + verify + loadExtension);
   * its content scripts register at load time and apply to navigations AFTER.
   * Navigating a login page before then would inject nothing — the human
   * would have to reload for 1Password to appear. So the first tab in a new
   * project waits (bounded) for the host to settle, then is tracked. A host
   * that FAILED does not block the page: the tab still opens, just without the
   * extension, and the failure shows in status().
   */
  async readyHostForTab(tab, view) {
    const host = this.extensionHostFor(tab.partition);
    if (!host) return;
    if (typeof host.whenReady === "function") {
      try { await host.whenReady(); } catch { /* a failed host must not block the page */ }
    }
    // Only after readiness, and only if the tab's view is still the one we
    // created (a hibernate could have raced), is it tracked with the library.
    if (tab.view === view && !view.webContents.isDestroyed()) host.addTab(view.webContents, this.window);
  }

  beginNavigation(tab) {
    tab.navigationPending += 1;
  }

  endNavigation(tab) {
    tab.navigationPending = Math.max(0, tab.navigationPending - 1);
    this.finishDeferredHibernate(tab);
  }

  async loadTab(tab, url) {
    this.beginNavigation(tab);
    try {
      await this.beforeNavigation(tab);
      await this.loadAllowingReplacement(tab, url);
    } finally {
      this.endNavigation(tab);
    }
  }

  /**
   * `loadURL` REJECTS WITH ERR_ABORTED (-3) WHEN THE PAGE REPLACES ITS OWN
   * LOAD — a `location.replace` in an inline script, a meta refresh, a site
   * that bounces itself (`youtube.com/?themeRefresh=1`, seen live) — because
   * the navigation it was waiting on was superseded, not because anything
   * failed. That is a page that is loading fine, and reporting it as an
   * error ("Error invoking remote method … ERR_ABORTED") was wrong.
   *
   * So: on -3, if another main-frame navigation has started on this
   * WebContents since ours, wait for THAT one to settle and answer with its
   * outcome. A genuine failure (any other code) still throws; an abort with
   * NO replacement — a stop, a navigation nobody continued — still throws,
   * because that page did not load and saying so is the point.
   */
  async loadAllowingReplacement(tab, url) {
    const wc = tab.view.webContents;
    // Listeners are up BEFORE the load, so a replacement that starts, lands
    // or fails while `loadURL` is still rejecting is seen, not missed.
    // Every listener is up BEFORE the load and removed in ONE place (the
    // `finally`), so a timeout cannot leave any attached. SUCCESS NEEDS A
    // COMMIT: a replacement must `did-navigate` (a new document) or, for a
    // same-document replacement, `did-navigate-in-page`. `did-stop-loading`
    // is NOT a success signal — the aborted document's own stop arrives
    // after the replacement started, and the URL read then still answers
    // the superseded one (seen: "Navigated to …/bounce"). A stop with no
    // commit, a destroyed WebContents, a main-frame failure, or the deadline
    // are all failures — a page that did not load is reported as such.
    let starts = 0;
    let committed = false;
    let failure = null;
    let settle = null; // resolves/rejects the wait below, once it exists
    const commit = () => { if (starts >= 2) { committed = true; settle?.(null); } };
    const onStart = (details) => {
      if (details?.isMainFrame) { starts += 1; if (!details.isSameDocument) committed = false; }
    };
    const onFail = (_event, code, description, failedUrl, isMainFrame) => {
      if (!isMainFrame || code === -3) return;
      failure = Object.assign(new Error(`${description || "load failed"} (${code}) loading ${failedUrl}`), { errno: code });
      settle?.(failure);
    };
    const onStop = () => {
      // The stop of whatever was last loading, with no commit seen for a
      // replacement: nothing landed (the load was stopped, or the
      // replacement's own request never committed).
      if (!committed) settle?.(Object.assign(new Error(`ERR_ABORTED (-3) loading '${url}' — the navigation was stopped before a page committed.`), { errno: -3 }));
    };
    const onDestroyed = () => settle?.(new Error("The tab was closed while the page was still loading."));
    wc.on("did-start-navigation", onStart);
    wc.on("did-navigate", commit);
    wc.on("did-navigate-in-page", commit);
    wc.on("did-fail-load", onFail);
    wc.on("did-stop-loading", onStop);
    wc.on("destroyed", onDestroyed);
    try {
      await wc.loadURL(url);
    } catch (error) {
      const aborted = error && (error.errno === -3 || error.code === "ERR_ABORTED" || /ERR_ABORTED/.test(String(error.message)));
      // Our own start is one; a replacement is a second. A still-loading
      // WebContents covers a replacement that began before the listener.
      const loading = typeof wc.isLoading === "function" && !wc.isDestroyed() && wc.isLoading();
      const replaced = aborted && !wc.isDestroyed() && (starts >= 2 || loading);
      if (!replaced) throw error;
      if (failure) throw failure;
      if (committed) return;
      if (!loading) throw error; // the replacement is already over, and never committed
      await withTimeout(
        new Promise((resolve, reject) => {
          settle = (outcome) => (outcome ? reject(outcome) : resolve());
        }),
        this.rpcTimeoutMs,
        "The page kept navigating and never settled.",
      );
    } finally {
      settle = null;
      wc.removeListener("did-start-navigation", onStart);
      wc.removeListener("did-navigate", commit);
      wc.removeListener("did-navigate-in-page", commit);
      wc.removeListener("did-fail-load", onFail);
      wc.removeListener("did-stop-loading", onStop);
      wc.removeListener("destroyed", onDestroyed);
    }
  }

  async navigateTab(tab, url) {
    this.beginNavigation(tab);
    try {
      await this.wakeTab(tab);
      await this.loadTab(tab, normalizeUrl(url));
    } finally {
      this.endNavigation(tab);
    }
  }

  async goBack(tab) {
    const wc = tab.view.webContents;
    if (navigationFlag(wc, "canGoBack")) {
      await this.beforeNavigation(tab);
      wc.navigationHistory.goBack();
    }
  }

  hibernateTab(tab) {
    if (!tab.view) return;
    // THE ONE TEARDOWN PATH, so it is where a key claim is given back (#660).
    // Closing the tab, evicting it, and the window quitting all arrive here, and
    // a destroyed web contents emits no `blur` — without this the shell would
    // keep the rail's ⌘1..⌘9 stripped with no way back but a restart. A no-op
    // for a tab that was not holding the keys.
    this.noteTabKeyFocus(tab, false);
    this.cancelDeferredHibernate(tab);
    // A PREVIEW WINDOW IS THE TAB'S TOO, and this is the one teardown path —
    // so a window showing a page that is about to stop existing is closed
    // here, and its view handed back before anything detaches it (#473).
    this.endPreview(tab);
    // DEVTOOLS ARE THE TAB'S AND GO WITH IT. This is the ONE teardown path —
    // closing a tab, hibernating it, the live-view budget evicting it, the
    // window quitting all arrive here — so a detached DevTools window cannot
    // outlive the page it was inspecting and sit there addressing nothing.
    this.closeDevTools(tab);
    const view = tab.view;
    { const host = this.hostOfTab(tab); if (host) host.removeTab(view.webContents); }
    tab.url = view.webContents.getURL() || tab.url || "about:blank";
    tab.title = view.webContents.getTitle() || tab.title || "New tab";
    tab.hibernating = true;
    tab.view = null;
    try { this.window.contentView.removeChildView(view); } catch {}
    try { if (!view.webContents.isDestroyed()) view.webContents.close(); } catch {}
    tab.hibernating = false;
  }

  cancelDeferredHibernate(tab) {
    if (tab.hibernateTimer) clearTimeout(tab.hibernateTimer);
    tab.hibernateTimer = null;
    tab.hibernateWhenIdle = false;
    tab.destroyWhenIdle = false;
  }

  removeTab(tab) {
    const scope = tab.scopeKey;
    // A question has nowhere left to be answered once its tab is gone; it is
    // settled as Block rather than left for the sixty-second timer.
    this.permissionPrompts.cancelWhere((record) => record.tabId === tab.id);
    this.tabs = this.tabs.filter((candidate) => candidate !== tab);
    this.noteAgentTabClosed(tab);
    if (this.activeTabIds.get(scope) === tab.id) {
      const remaining = this.scopeTabs(scope);
      this.activeTabIds.set(scope, remaining.at(-1)?.id ?? null);
    }
    if (!this.scopeTabs(scope).length) this.activeTabIds.delete(scope);
    this.applyVisibility();
  }

  finishDeferredHibernate(tab, force = false) {
    if (
      !tab.hibernateWhenIdle ||
      !tab.view ||
      ((tab.loading || tab.navigationPending > 0 || (this.activeToolCalls.get(tab.scopeKey) || 0) > 0) && !force)
    ) return;
    const destroy = tab.destroyWhenIdle;
    this.hibernateTab(tab);
    if (destroy) {
      this.removeTab(tab);
      this.emitState(tab.scopeKey);
    }
  }

  requestHibernate(tab, destroy = false) {
    if (!tab.view) {
      if (destroy) this.removeTab(tab);
      return;
    }
    if (tab.loading || tab.navigationPending > 0 || (this.activeToolCalls.get(tab.scopeKey) || 0) > 0) {
      tab.hibernateWhenIdle = true;
      tab.destroyWhenIdle ||= destroy;
      if (!tab.hibernateTimer) {
        tab.hibernateTimer = setTimeout(
          () => this.finishDeferredHibernate(tab, true),
          HIBERNATE_GRACE_MS,
        );
      }
      return;
    }
    this.hibernateTab(tab);
    if (destroy) this.removeTab(tab);
  }

  enforceLiveViewBudget(exceptTab) {
    const live = this.tabs.filter((tab) => tab.view && tab !== exceptTab);
    while (live.length + (exceptTab?.view ? 1 : 0) > this.maxLiveViews) {
      const candidate = live
        .filter(
          (tab) =>
            tab.scopeKey !== this.visibleScopeKey &&
            (this.activeToolCalls.get(tab.scopeKey) || 0) === 0,
        )
        .sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
      if (!candidate) break;
      this.hibernateTab(candidate);
      const index = live.indexOf(candidate);
      if (index >= 0) live.splice(index, 1);
    }
  }

  async createTab(scopeKey, url = "about:blank", openedBy = "agent") {
    const scope = this.requireScope(scopeKey);
    if (this.scopeTabs(scope).length >= MAX_TABS_PER_SCOPE) {
      throw new Error(`Tab limit reached (${MAX_TABS_PER_SCOPE} per session). Close a tab first.`);
    }
    // Fixed at creation from the scope's ACTIVE profile: a tab's cookies
    // belong to the profile it was opened in, whatever the session switches to
    // afterwards. `partitionOf` is what refuses an unbound scope.
    this.partitionOf(scope);
    const tab = this.newTabRecord(scope, this.activeProfile(scope), openedBy);
    const wasEmpty = this.scopeTabs(scope).length === 0;
    this.tabs.push(tab);
    /**
     * AN AGENT'S NEW TAB DOES NOT TAKE THE SCREEN. Opening a page is the
     * agent's decision, not yours, and it used to move your view mid-read —
     * the complaint that produced the two pointers. The human's view follows
     * only their own gesture, or the very first tab of a scope (a panel with
     * nothing shown has nothing to show).
     */
    if (openedBy === "human" || wasEmpty) this.activeTabIds.set(scope, tab.id);
    if (openedBy === "agent") {
      this.agentTabIds.set(scope, tab.id);
      this.agentTabClosed.delete(scope);
    }
    const view = this.createViewForTab(tab);
    const humanTabBefore = this.activeTabIds.get(scope);
    await this.readyHostForTab(tab, view);
    /**
     * AND THE EXTENSION HOST DOES NOT MOVE IT EITHER.
     *
     * Registering a tab with the partition's 1Password host makes the library
     * treat it as that window's active tab, and the shell wires the library's
     * selection back to `selectTab` — the HUMAN's pointer (main.js). So an
     * agent opening a page still stole the screen, through a second door,
     * after the decision above had correctly declined to. Measured against a
     * real nightly: the new tab came back marked `(current)`.
     *
     * Re-asserted rather than prevented, because the library's notion of an
     * active tab is its own and it is welcome to it — what must not survive is
     * that notion reaching the person's view.
     */
    if (
      openedBy === "agent" &&
      humanTabBefore !== undefined &&
      this.activeTabIds.get(scope) !== humanTabBefore &&
      this.tabs.some((candidate) => candidate.id === humanTabBefore)
    ) {
      this.activeTabIds.set(scope, humanTabBefore);
    }
    this.applyVisibility();
    // A human's fresh tab starts in their hands. Nobody has observed a new
    // tab's page yet — the first mutation on it needs a look first.
    if (openedBy === "human") tab.lastHumanInputAt = this.now();
    this.journalControl(tab, openedBy === "human" ? "human" : "agent");
    const destination = normalizeUrl(url);
    if (destination !== "about:blank") await this.loadTab(tab, destination);
    this.enforceLiveViewBudget(tab);
    this.emitState(scope);
    return tab;
  }

  popupOpener(tab) {
    const recentAgentInput = this.now() - (this.lastAgentInputAt.get(tab.scopeKey) || 0) < HUMAN_ATTRIBUTION_GRACE_MS;
    return tab.agentBusy > 0 || recentAgentInput ? "agent" : "human";
  }

  trackPopupTab(task) {
    this.pendingPopupTabs.add(task);
    task.then(
      () => this.pendingPopupTabs.delete(task),
      () => this.pendingPopupTabs.delete(task),
    );
    return task;
  }

  /**
   * THE POPUP TABS EXIST — not that their pages have loaded. Since #615 the
   * first navigation is CHROMIUM'S (it owns the guest and starts it the moment
   * the handler answers), not a `loadTab` this manager awaits, so a caller that
   * needs the popup's URL has to wait for the URL. Waiting here instead would
   * hang on the blank popup an OAuth client opens before it has somewhere to
   * send it — `window.open("")` then `popup.location = …` is the common shape.
   */
  async settlePopupTabs() {
    await Promise.allSettled([...this.pendingPopupTabs]);
  }

  /**
   * CHROMIUM'S OWN POPUP, ADOPTED — the whole of #615.
   *
   * This used to answer `window.open` with `{ action: "deny" }` and then open
   * the same URL again as an ordinary tab. The page loaded, so it looked
   * right; but a tab Telar opened has no opener relationship with the page
   * that asked for it, and every popup sign-in on the web hands its result
   * back through exactly that relationship:
   *
   *   - `window.opener.postMessage(result, origin)` — `opener` was null, so
   *     the call threw and the flow died in silence (signing into Cloudflare
   *     with Google: the leftover tab just sat on the callback URL);
   *   - `window.close()` — Chromium will not let script close a tab script did
   *     not open, so the popup never went away;
   *   - the opener polling `popup.closed` — `window.open()` had returned null.
   *
   * So the popup has to be CHROMIUM'S, not ours. `createWindow` is the seam
   * (Electron 30+): Chromium has already built the guest WebContents — with
   * the opener edge, the opener's session and the opener's webPreferences on
   * it — and offers it instead of constructing a BrowserWindow. Adopting that
   * into a `WebContentsView` lands it in the panel as an ordinary Telar tab
   * with the relationship intact. Proven against real Electron in
   * browser-popup.electron-test.js, which asserts the postMessage arrives and
   * that `window.close()` closes the tab — not what this function returns.
   *
   * `disposition` IS DELIBERATELY NOT READ, having looked. Routing only
   * `disposition: "new-window"` here and leaving `foreground-tab` on the old
   * deny path is the obvious-looking split and it is the wrong one: the opener
   * rules are Chromium's own, and a `target="_blank"` anchor and an explicit
   * `noopener` both arrive here with the opener edge ALREADY severed upstream
   * (measured: both report `foreground-tab`). Filtering on disposition could
   * only re-break the flows this fixes. `features`, `referrer` and `postBody`
   * are Chromium's to apply for the same reason — the guest already carries
   * them, which is the point of not building a second WebContents.
   */
  decidePopup(opener, details) {
    // THE SCHEME FENCE IS HERE, BEFORE THE ALLOW: adoption must not become a
    // way around `normalizePopupUrl`. A refusal opens nothing and says
    // nothing, exactly as it did.
    if (!normalizePopupUrl(details?.url)) return { action: "deny" };
    if (!this.tabs.includes(opener)) return { action: "deny" };
    if (this.scopeTabs(opener.scopeKey).length >= MAX_TABS_PER_SCOPE) return { action: "deny" };
    // WHOSE GESTURE THIS IS, decided NOW — at the `window.open` itself, which
    // is the moment the question is about. `createWindow` runs later and the
    // grace window in `popupOpener` would have moved by then.
    const openedBy = this.popupOpener(opener);
    return {
      action: "allow",
      /**
       * A POPUP OUTLIVES ITS OPENER, the way it does in every browser — and
       * here it must, for a reason of our own: `hibernateTab` closes an
       * opener's WebContents when the live-view budget evicts it, and with
       * Electron's default (`false`) that would take a half-finished sign-in
       * down because some tab nobody was looking at got swapped out.
       */
      outlivesOpener: true,
      createWindow: (options) => this.adoptPopupTab(opener, options, openedBy),
    };
  }

  /**
   * SYNCHRONOUS BY CONTRACT. Chromium is holding the guest open waiting for
   * the WebContents this returns, so the tab record, the view and the adoption
   * all happen here; the slow tail (the extension host, the view budget) goes
   * to `finishPopupTab` and is tracked, which is what `settlePopupTabs` — and
   * so every test that awaits a popup — is still waiting on.
   */
  adoptPopupTab(opener, options, openedBy) {
    const guest = options?.webContents || null;
    /**
     * THE POPUP STAYS ON THE OPENER'S IDENTITY. Chromium gives a guest its
     * opener's session, so this holds; it is checked rather than assumed
     * because the failure it guards — an OAuth cookie written into a profile
     * the person never signed in under — is a worse bug than the one being
     * fixed here, and a silent one. A guest that is somehow elsewhere is
     * refused: handed back so Electron's own bookkeeping completes, then
     * closed, and no tab is ever filed for it.
     */
    const expected = this.sessionFor(opener.partition);
    if (guest && expected && guest.session && guest.session !== expected) {
      queueMicrotask(() => { try { guest.close(); } catch { /* already gone */ } });
      return guest;
    }
    const scope = opener.scopeKey;
    // THE OPENER'S PROFILE, NOT THE SCOPE'S CURRENT ONE. A tab's identity is
    // fixed at creation (`createTab`), so a session that switched profiles
    // since the opener was opened must not re-file its popup elsewhere.
    const tab = this.newTabRecord(scope, { partition: opener.partition, id: opener.profileId }, openedBy);
    const wasEmpty = this.scopeTabs(scope).length === 0;
    this.tabs.push(tab);
    // The same rule `createTab` applies: an agent's new tab does not take the
    // screen, and the human's view follows only their own gesture.
    if (openedBy === "human" || wasEmpty) this.activeTabIds.set(scope, tab.id);
    if (openedBy === "agent") {
      this.agentTabIds.set(scope, tab.id);
      this.agentTabClosed.delete(scope);
    }
    const view = this.adoptViewForTab(tab, guest);
    // Nobody has observed this page yet — the first mutation on it needs a
    // look first, the same as any tab a person opened.
    if (openedBy === "human") tab.lastHumanInputAt = this.now();
    this.journalControl(tab, openedBy === "human" ? "human" : "agent");
    this.applyVisibility();
    this.emitState(scope);
    this.trackPopupTab(this.finishPopupTab(tab, view));
    return view.webContents;
  }

  /**
   * A POPUP CANNOT WAIT FOR THE EXTENSION HOST the way `createTab` does:
   * Chromium is already navigating it, and there is no before-the-first-
   * navigation to wait in. Registering is all that is left — and in practice
   * the host is warm, because the opener's own tab readied it.
   */
  async finishPopupTab(tab, view) {
    const scope = tab.scopeKey;
    const humanTabBefore = this.activeTabIds.get(scope);
    await this.readyHostForTab(tab, view);
    // AND THE EXTENSION HOST DOES NOT MOVE THE HUMAN'S VIEW EITHER — the
    // second door `createTab` guards, on the same library call.
    if (
      tab.openedBy === "agent" &&
      humanTabBefore !== undefined &&
      this.activeTabIds.get(scope) !== humanTabBefore &&
      this.tabs.some((candidate) => candidate.id === humanTabBefore)
    ) {
      this.activeTabIds.set(scope, humanTabBefore);
    }
    this.enforceLiveViewBudget(tab);
    this.applyVisibility();
    this.emitState(scope);
    return tab;
  }

  /** A tab record with no WebContents — what createTab and the inventory
   *  restore both start from. */
  newTabRecord(scope, profile, openedBy) {
    return {
      id: this.createId(),
      scopeKey: scope,
      // The identity this tab is signed into, fixed here for its whole life.
      partition: profile.partition,
      profileId: profile.id,
      view: null,
      /** The tab's own intrinsic viewport; absent means DEFAULT_VIEWPORT. */
      viewport: undefined,
      /** "fit" (THE DEFAULT: the page reflows with the panel like an ordinary
       *  browser, and keeps the last seen size while hidden) or "fixed" (an
       *  explicit preset / custom size / drag — opt-in). */
      viewportMode: "fit",
      /** The page zoom the options menu's − / + walk (#473). A page-level
       *  factor, not a presentation scale: it changes what the page lays out
       *  as, so the agent sees what the human set. */
      zoom: 1,
      /** What `prefers-color-scheme` answers in this tab — "system" is no
       *  override at all, which is the default a page would see anyway. */
      colorScheme: "system",
      /** The scheme currently pushed to this WebContents, so a resync does not
       *  re-send it. Cleared with the view, like `viewportOverride`. */
      colorSchemeApplied: undefined,
      /** This tab's own window while it is previewed out of the panel (#473).
       *  The view lives in that window's `contentView` meanwhile; the cockpit
       *  neither places nor hides it — see `previewing`. */
      previewWindow: null,
      /** The serialized geometry pipeline — see applyGeometry. */
      geometry: null,
      /** Restored from the inventory and not yet woken in this process. */
      restored: false,
      title: "New tab",
      url: "about:blank",
      loading: false,
      openedBy,
      // The interaction model (see the header): when a human last touched
      // this tab; the page generation, bumped by human input and navigation;
      // the generation the agent last observed; agent calls in flight on it;
      // and the tail of its serialized action queue.
      lastHumanInputAt: undefined,
      generation: 0,
      observedGeneration: -1,
      staleReason: "",
      agentBusy: 0,
      /** Preload reports the agent's own dispatches are about to raise. */
      expectedReports: [],
      /** Set when a human's input landed while an agent action was running. */
      interruptedAt: undefined,
      ticket: 0,
      queue: Promise.resolve(),
      lastJournaled: "idle",
      faviconUrl: null,
      refs: new Map(),
      console: [],
      network: [],
      debuggerReady: false,
      debuggerListenersBound: false,
      hibernating: false,
      hibernateWhenIdle: false,
      destroyWhenIdle: false,
      hibernateTimer: null,
      navigationPending: 0,
      lastUsedAt: Date.now(),
    };
  }

  bindTab(tab) {
    const view = tab.view;
    const wc = view.webContents;
    const sync = () => {
      tab.url = wc.getURL() || "about:blank";
      tab.title = wc.getTitle() || (tab.url === "about:blank" ? "New tab" : tab.url);
      // Blank ↔ loaded flips whether the native view is shown at all (the
      // DOM start page lives under a blank tab) — re-place through the
      // pipeline, which is idempotent when nothing changed.
      const blank = this.isBlank(tab);
      if (blank !== tab.wasBlank) { tab.wasBlank = blank; this.applyGeometry(tab).catch(() => {}); }
      this.emitState(tab.scopeKey);
    };
    if (typeof wc.setWindowOpenHandler === "function") {
      wc.setWindowOpenHandler((details) => this.decidePopup(tab, details || {}));
    }
    /**
     * THE PAGE HAS THE KEYS, OR HAS GIVEN THEM BACK (#660).
     *
     * This is the focus condition the issue asked for, read where it is actually
     * knowable. A claim keyed to the panel being MOUNTED would suppress the
     * rail's ⌘1..⌘9 for as long as the panel is open, which is a worse bug than
     * the one it fixes; a claim keyed to DOM focus cannot see this state at all,
     * because focus here is native and in another process.
     *
     * BLUR RELEASES UNCONDITIONALLY, and `noteTabKeyFocus` ignores a blur from a
     * tab that no longer holds the claim. A suppression that leaks leaves the
     * rail's shortcut dead with no way back but a restart — so every edge that
     * can end this (closing the tab, destroying the manager, another tab taking
     * focus) releases through the same one place.
     */
    wc.on("focus", () => this.noteTabKeyFocus(tab, true));
    wc.on("blur", () => this.noteTabKeyFocus(tab, false));
    /**
     * AND THE HALF THAT ANSWERS. Stripping the accelerator only stops the rail
     * from jumping — without this, ⌘2 would fall through to the web page, which
     * is a different bug rather than a fix. The cockpit's own `onKeys` cannot
     * serve it: this keydown never reaches that renderer.
     *
     * `before-input-event` is the earliest point the main process can see a key
     * headed for this page, and it only ever fires for these chords once the
     * menu has stood down — macOS matches a key equivalent ahead of the focused
     * view, so the claim above is what makes this handler reachable at all.
     */
    wc.on("before-input-event", (event, input) => this.handleTabKey(tab, event, input));
    /**
     * A hidden view is a background renderer and Chromium stops flushing its
     * input queue — a CDP click never resolves; unthrottled it lands in
     * ~100ms (measured, browser-manager.electron-test.js). Set on every
     * dom-ready: the flag lives on the render widget and a navigation gets a
     * new one. The viewport emulation is re-applied here too; see
     * beforeNavigation for why it must be gone while a document commits.
     */
    wc.on("did-start-navigation", (details) => {
      if (!details?.isMainFrame || details.isSameDocument || !tab.viewportOverride || !tab.debuggerReady) return;
      tab.viewportOverride = undefined;
      wc.debugger.sendCommand("Emulation.clearDeviceMetricsOverride").catch(() => {});
    });
    wc.on("dom-ready", () => {
      if (wc.isDestroyed()) return;
      wc.setBackgroundThrottling(false);
      // Attach-and-apply, not apply-if-attached: a human navigation on a
      // never-inspected tab must land on the intrinsic viewport too.
      this.ensureViewport(tab).catch(() => {});
    });
    wc.on("did-start-loading", () => {
      tab.loading = true;
      tab.refs.clear();
      sync();
    });
    wc.on("did-stop-loading", () => {
      tab.loading = false;
      sync();
      this.finishDeferredHibernate(tab);
    });
    wc.on("page-title-updated", (_event, title) => {
      tab.title = title || tab.title;
      this.emitState(tab.scopeKey);
    });
    wc.on("page-favicon-updated", (_event, favicons) => {
      tab.faviconUrl = (Array.isArray(favicons) && favicons[0]) || null;
      this.emitState(tab.scopeKey);
    });
    wc.on("did-navigate", (_event, navigatedUrl, httpResponseCode) => {
      this.noteNavigation(tab);
      sync();
      this.noteVisited(tab, navigatedUrl || wc.getURL(), httpResponseCode);
    });
    wc.on("did-navigate-in-page", sync);
    /**
     * THE PAGE'S OWN RIGHT-CLICK MENU (#423). Chromium fires this with
     * everything it knows about what was under the pointer; what the rows SAY
     * is the pure fold in browser-context-menu.js, and what they DO is
     * `runContextMenuCommand` below. Nothing here decides either.
     */
    wc.on("context-menu", (_event, params) => {
      // A right-click is a person's hand on this tab, before any row is picked
      // — an agent mutation should already be deferring while the menu is open.
      this.noteHumanInput(tab.scopeKey, { force: true });
      this.openContextMenu(tab, params || {});
    });
    // DevTools are part of what the strip shows about a tab, so both edges of
    // the window's life — including the person closing it by its own button —
    // are a state push.
    wc.on("devtools-opened", () => this.emitState(tab.scopeKey));
    wc.on("devtools-closed", () => this.emitState(tab.scopeKey));
    wc.on("destroyed", () => {
      if (tab.hibernating || tab.view !== view) return;
      this.tabs = this.tabs.filter((candidate) => candidate !== tab);
      /**
       * THE DEAD VIEW GOES WITH THE TAB. This used to be a crash path only,
       * where one orphaned child view in the window hardly mattered. Since
       * #615 it is also the ROUTINE one — `window.close()` from an adopted
       * popup destroys its WebContents, which is how an OAuth popup is
       * supposed to end — so a view left parented to the window would now
       * accumulate once per sign-in.
       */
      tab.view = null;
      { const host = this.hostOfTab(tab); if (host) { try { host.removeTab(wc); } catch { /* host already gone */ } } }
      try { this.window.contentView.removeChildView(view); } catch { /* never parented */ }
      this.noteAgentTabClosed(tab);
      const scoped = this.scopeTabs(tab.scopeKey);
      if (this.activeTabIds.get(tab.scopeKey) === tab.id) {
        this.activeTabIds.set(tab.scopeKey, scoped.at(-1)?.id ?? null);
      }
      this.applyVisibility();
      this.emitState(tab.scopeKey);
    });
  }

  // --- DevTools, per tab (#423) ----------------------------------------------
  //
  // ALWAYS DETACHED. A docked DevTools splits the WebContents' own viewport,
  // and this manager has just spent a whole geometry pipeline deciding what
  // that viewport is — the panel's measured rect, the tab's intrinsic size, the
  // fit scale an agent's click coordinates are computed against. Docking would
  // silently move all three. A separate window changes nothing about the page.

  /** The tab's live WebContents, or null for a sleeping/destroyed one. */
  contentsOf(tab) {
    const wc = tab?.view?.webContents;
    return wc && !wc.isDestroyed() ? wc : null;
  }

  devToolsOpen(tab) {
    const wc = this.contentsOf(tab);
    try {
      return Boolean(wc && wc.isDevToolsOpened && wc.isDevToolsOpened());
    } catch {
      // A WebContents torn down between the check and the call: not open.
      return false;
    }
  }

  /** Open (if needed) and optionally aim DevTools at the element under a
   *  point, in the page's own coordinates — what "Inspect" means. */
  openDevTools(tab, inspectAt) {
    const wc = this.contentsOf(tab);
    if (!wc) return;
    try {
      if (!this.devToolsOpen(tab)) wc.openDevTools?.({ mode: "detach" });
      if (inspectAt) wc.inspectElement?.(Math.round(inspectAt.x || 0), Math.round(inspectAt.y || 0));
    } catch {
      // DevTools are a convenience; a refusal must not take the page with it.
    }
  }

  closeDevTools(tab) {
    if (!this.devToolsOpen(tab)) return;
    try {
      this.contentsOf(tab)?.closeDevTools?.();
    } catch {
      // Same: never block a teardown on this.
    }
  }

  /**
   * ⌥⌘I / View › Developer Tools, for the tab the person is looking at.
   *
   * NOTHING HAPPENS WHEN THERE IS NO TAB, deliberately (#423): this chord is
   * live across the whole cockpit, and a session whose panel has never opened a
   * page should answer it with silence rather than an error toast. A REMEMBERED
   * tab is woken first — inspecting it is looking at it, and a sleeping tab has
   * no WebContents to attach to.
   */
  async toggleDevTools(scopeKey) {
    const scope = this.requireScope(scopeKey);
    const activeId = this.activeTabIds.get(scope);
    const tab = this.scopeTabs(scope).find((candidate) => candidate.id === activeId);
    if (!tab) return this.state(scope);
    await this.wakeTab(tab);
    if (this.devToolsOpen(tab)) this.closeDevTools(tab);
    else this.openDevTools(tab);
    this.emitState(scope);
    return this.state(scope);
  }

  // --- The options menu's own verbs (#473) -----------------------------------

  /**
   * THE TAB, IN A WINDOW OF ITS OWN — not a second page at the same address.
   *
   * The live `WebContentsView` is MOVED: out of the cockpit's `contentView`
   * and into the new window's. A copy would be a different page — its own
   * scroll, its own form state, its own login step half-finished — and
   * "preview this tab" would then be a control that shows you something else.
   * Moving it is also why there is nothing to reconcile when it comes back.
   *
   * THE PANEL IS LEFT EMPTY ON PURPOSE while the tab is away, and says so
   * (`preview` in the tab's state). A page cannot be composited in two places,
   * and a panel that silently showed a different tab would lose the person's
   * place in this one.
   *
   * Sized to the tab's intrinsic viewport, because that is the size the page
   * is laid out for — a previewed tab is not "shown" in the panel
   * (`isTabShown`), so it keeps its own viewport rather than adopting a stage
   * it has left.
   */
  async openPreview(scopeKey, index) {
    const scope = this.requireScope(scopeKey);
    const tab = index === undefined ? this.activeTab(scope) : this.tabAt(scope, index);
    await this.wakeTab(tab);
    if (this.previewing(tab)) {
      try { tab.previewWindow.focus(); } catch { /* a window mid-close */ }
      return this.state(scope);
    }
    const { BrowserWindow } = this.electron();
    if (!BrowserWindow) throw new Error("This build cannot open a separate window for a tab.");
    const viewport = this.viewportOf(tab);
    const win = new BrowserWindow({
      width: viewport.width,
      height: viewport.height,
      useContentSize: true,
      title: tab.title || "Preview",
      backgroundColor: "#00000000",
      show: true,
    });
    try {
      this.window.contentView.removeChildView(tab.view);
      win.contentView.addChildView(tab.view);
    } catch (error) {
      // The move failed halfway: put the view back where it belongs rather
      // than leaving it parented to nothing.
      try { this.window.contentView.addChildView(tab.view); } catch { /* already there */ }
      try { win.destroy(); } catch { /* never opened */ }
      throw new Error(`Could not open a separate window for this tab: ${error instanceof Error ? error.message : String(error)}`);
    }
    tab.previewWindow = win;
    win.on?.("resize", () => { this.applyGeometry(tab).catch(() => {}); });
    // CLOSING THE WINDOW IS HOW THE TAB COMES BACK. `closed` fires after the
    // window is gone, so `endPreview` finds `isDestroyed()` true and only
    // re-parents — which is exactly what is left to do.
    win.on?.("closed", () => {
      if (!tab.previewWindow) return;
      tab.previewWindow = null;
      this.reclaimView(tab);
      this.applyVisibility();
      try { this.emitState(tab.scopeKey); } catch { /* the scope went with it */ }
    });
    this.applyVisibility();
    this.emitState(scope);
    return this.state(scope);
  }

  /** Bring a previewed tab back into the panel and shut its window. Safe on a
   *  tab that is not previewed, and on one whose window is already gone. */
  endPreview(tab) {
    const win = tab?.previewWindow;
    if (!win) return;
    tab.previewWindow = null;
    this.reclaimView(tab);
    try { if (!win.isDestroyed?.()) win.destroy(); } catch { /* already gone */ }
  }

  /** Re-parent a returning preview's view to the cockpit window. */
  reclaimView(tab) {
    if (!tab.view) return;
    try { this.window.contentView.addChildView(tab.view); } catch { /* the cockpit went first */ }
  }

  /** The human's "bring it back", from the panel rather than the window. */
  closePreview(scopeKey, index) {
    const scope = this.requireScope(scopeKey);
    const tab = index === undefined ? this.activeTab(scope) : this.tabAt(scope, index);
    this.endPreview(tab);
    this.applyVisibility();
    this.emitState(scope);
    return this.state(scope);
  }

  /**
   * CLEAR COOKIES / CACHE, FOR THE PROFILE THIS TAB BROWSES IN.
   *
   * THE SCOPE IS THE PARTITION, NOT THE SITE, and the panel's confirm says so
   * in those words: a Chromium session is cleared whole, and offering a row
   * that read "clear cookies for example.com" while signing the profile out of
   * everything would be this menu lying about what it does. The site is named
   * beside it because it is the page in front of the person — what they are
   * about to be signed out of, not the limit of what is.
   */
  async clearBrowsingData(scopeKey, kind) {
    const scope = this.requireScope(scopeKey);
    const tabs = this.scopeTabs(scope);
    if (!tabs.length) throw new Error("There is no tab here to clear anything for.");
    const tab = this.activeTab(scope);
    const ses = this.sessionFor(tab.partition);
    if (!ses) throw new Error("This browser profile has no Chromium session to clear.");
    if (kind === "cookies") await ses.clearStorageData({ storages: ["cookies"] });
    else if (kind === "cache") await ses.clearCache();
    else throw new Error(`Unknown browsing data ${JSON.stringify(kind)}. Use cookies or cache.`);
    return { ok: true, kind, partition: tab.partition, profile: this.profiles.get(tab.profileId)?.label ?? null };
  }

  // --- The page's context menu (#423) ----------------------------------------

  /** Build and pop the native menu for one right-click. The rows are the pure
   *  fold's; this only binds each to `runContextMenuCommand`. */
  openContextMenu(tab, params) {
    const wc = this.contentsOf(tab);
    if (!wc) return;
    const template = browserContextMenuTemplate(params, {
      canGoBack: navigationFlag(wc, "canGoBack"),
      canGoForward: navigationFlag(wc, "canGoForward"),
    });
    const items = template.map((entry) =>
      entry.type === "separator"
        ? { type: "separator" }
        : {
            label: entry.label,
            enabled: entry.enabled,
            click: () => {
              void Promise.resolve(this.runContextMenuCommand(tab, entry, params)).catch(() => {});
            },
          },
    );
    try {
      const { Menu } = this.electron();
      Menu.buildFromTemplate(items).popup({ window: this.window });
    } catch {
      // No display, a window mid-close: a menu that cannot open is not an error
      // worth propagating into a page event handler.
    }
  }

  /**
   * ONE SWITCH FOR THE WHOLE MENU — every id the fold can emit is answered
   * here, and browser-context-menu.test.js checks that pairing, because a row
   * with no case is a menu item that highlights and does nothing.
   */
  async runContextMenuCommand(tab, entry, params) {
    const wc = this.contentsOf(tab);
    if (!wc) return;
    const scope = tab.scopeKey;
    switch (entry.id) {
      case "open-link-new-tab":
      case "open-image-new-tab":
        await this.openMenuTab(tab, normalizePopupUrl(entry.value));
        break;
      case "copy-link":
        this.electron().clipboard.writeText(String(entry.value ?? ""));
        break;
      case "copy-image":
        wc.copyImageAt(Math.round(params?.x || 0), Math.round(params?.y || 0));
        break;
      case "save-image-as":
        // No `will-download` handler is installed, so Electron asks where —
        // which is exactly what the "…" in the label promises.
        wc.downloadURL(String(entry.value ?? ""));
        break;
      case "replace-misspelling":
        wc.replaceMisspelling(String(entry.value ?? ""));
        break;
      case "cut":
        wc.cut();
        break;
      case "copy":
        wc.copy();
        break;
      case "paste":
        wc.paste();
        break;
      case "select-all":
        wc.selectAll();
        break;
      case "search-web":
        // ALWAYS a search, never a navigation: the row said "Search the web
        // for", and a selection that happens to look like a host must not
        // quietly become an address instead.
        await this.openMenuTab(tab, `${SEARCH_URL}${encodeURIComponent(String(entry.value ?? ""))}`);
        break;
      case "back":
        await this.goBack(tab);
        break;
      case "forward":
        if (navigationFlag(wc, "canGoForward")) {
          await this.beforeNavigation(tab);
          wc.navigationHistory.goForward();
        }
        break;
      case "reload":
        await this.beforeNavigation(tab);
        wc.reload();
        break;
      case "view-source":
        await this.openMenuTab(tab, `${VIEW_SOURCE_PREFIX}${entry.value}`);
        break;
      case "inspect":
        this.openDevTools(tab, { x: params?.x, y: params?.y });
        break;
      default:
        // A disabled row (no spelling suggestions) has no click to answer.
        break;
    }
    this.emitState(scope);
  }

  /**
   * A new tab from the page's menu — THROUGH THE ORDINARY OPEN-TAB PATH.
   *
   * Not a bare `loadURL` on a fresh view: the strip, the inventory, the live-
   * view budget and #383's "the last tab closing ends the browser" all hang off
   * `createTab`, and a tab that skipped it would be a tab the panel and the
   * saved session disagree about. Opened as the HUMAN's, because a context-menu
   * row is a hand on the mouse by construction — so it takes the screen, the
   * way clicking + does.
   *
   * A url of null (a `javascript:` link, a `data:` image, a protected URL that
   * `normalizePopupUrl` refused) opens nothing and says nothing: the same
   * silence the popup path answers those with.
   */
  openMenuTab(tab, url) {
    if (!url) return Promise.resolve(null);
    return this.trackPopupTab(this.createTab(tab.scopeKey, url, "human")).catch(() => null);
  }

  activeTab(scopeKey) {
    const scope = this.requireScope(scopeKey);
    const tab = this.tabs.find((candidate) =>
      candidate.scopeKey === scope && candidate.id === this.activeTabIds.get(scope),
    );
    if (!tab) throw new Error("Open a browser tab before using browser controls.");
    return tab;
  }

  tabAt(scopeKey, index) {
    const tab = this.scopeTabs(scopeKey)[Number(index)];
    if (!tab) throw new Error(`Browser tab ${String(index)} does not exist.`);
    return tab;
  }

  /**
   * THE TAB AN AGENT CALL ACTS ON when it did not name one.
   *
   * Its own focus if it has taken one and that tab still exists; otherwise the
   * human's, which is what makes "look at this page" work in a session where
   * the agent never opened a tab of its own.
   *
   * A FOCUS THAT WAS CLOSED IS AN ERROR, ONCE. Falling through to the human's
   * tab would have the agent quietly act on a page nobody pointed it at, so it
   * is told instead — and the tombstone is cleared as it is reported, so the
   * next call resolves normally rather than stranding the agent.
   */
  agentTab(scopeKey) {
    const scope = this.requireScope(scopeKey);
    const closed = this.agentTabClosed.get(scope);
    if (closed) {
      this.agentTabClosed.delete(scope);
      throw new Error(`The tab you were working in (${closed}) was closed. List the tabs and choose one to continue in.`);
    }
    const focused = this.tabs.find((candidate) => candidate.scopeKey === scope && candidate.id === this.agentTabIds.get(scope));
    if (focused) return focused;
    this.agentTabIds.delete(scope);
    return this.activeTab(scope);
  }

  /** The agent takes a tab as its own. Does NOT move the human's view — that
   *  is the whole point of the two pointers. */
  async focusAgentTab(scopeKey, index) {
    const scope = this.requireScope(scopeKey);
    const tab = this.tabAt(scope, index);
    await this.wakeTab(tab);
    this.agentTabIds.set(scope, tab.id);
    this.agentTabClosed.delete(scope);
    this.emitState(scope);
    return tab;
  }

  /** Remember that the agent's tab went, so its next call is told rather than
   *  silently redirected. Only for the tab it was actually working in. */
  noteAgentTabClosed(tab) {
    if (this.agentTabIds.get(tab.scopeKey) !== tab.id) return;
    this.agentTabIds.delete(tab.scopeKey);
    this.agentTabClosed.set(tab.scopeKey, tab.title || tab.url || "untitled");
  }

  /**
   * A call's tab: `tabId` (positional index) when given — a call may address
   * any tab, including one the human holds, which is how the model both sees
   * what it is being shown and works somewhere else — else the agent's own.
   * Never switches the human's view.
   *
   * A WRITE TO A TAB THE HUMAN IS USING IS STILL GATED. Being able to name a
   * tab does not weaken `runOnTab`: it still defers while their hands are on
   * that tab and still refuses on a view the agent has not refreshed.
   */
  tabFor(scope, args) {
    return args && args.tabId !== undefined ? this.tabAt(scope, args.tabId) : this.agentTab(scope);
  }

  /** `tabFor` for the paths that only want to LOOK — the extension-page
   *  precheck and the queue's pinning. Never throws, and never consumes the
   *  closed-tab tombstone, which belongs to the call that reports it. */
  peekTarget(scope, args) {
    try {
      if (args && args.tabId !== undefined) return this.tabAt(scope, args.tabId);
      if (this.agentTabClosed.has(this.requireScope(scope))) return null;
      return this.tabFor(scope, args);
    } catch {
      return null;
    }
  }

  /**
   * A TAB'S PAGE TOOK OR GAVE BACK THE KEYS (#660).
   *
   * Last-writer-wins on a single id rather than a set: exactly one web contents
   * has native focus at a time, and a stale blur — Chromium delivers focus to
   * the new view before blurring the old one on some paths — must not release a
   * claim the NEXT tab has already taken. Hence the id check on the way out.
   */
  noteTabKeyFocus(tab, focused) {
    if (focused) {
      if (this.keyFocusedTabId === tab.id) return;
      this.keyFocusedTabId = tab.id;
    } else {
      if (this.keyFocusedTabId !== tab.id) return;
      this.keyFocusedTabId = null;
    }
    this.publishChordScope();
  }

  /** Tell the shell what this browser's pages have taken — the nine while a page
   *  holds the keys, nothing otherwise. Idempotent; main rebuilds its menu. */
  publishChordScope() {
    try {
      this.onChordScope(this.keyFocusedTabId ? TAB_SELECT_CHORDS : []);
    } catch {
      // A shell that cannot take the scope is not a reason to break the tab.
    }
  }

  /**
   * ⌘1..⌘9 ON A FOCUSED PAGE: select the Nth tab of that page's own scope.
   *
   * The digit is a POSITION in the strip, which is what `tabAt` already means
   * and what the cockpit's `onKeys` already did — so the key and the strip
   * cannot come to disagree. A digit past the end does nothing and is NOT
   * swallowed: ⌘7 with four tabs open should reach the page, not vanish.
   *
   * Bare ⌘/⌃ only. ⌥⌘1 and ⇧⌘1 are other things in other apps and this must not
   * eat them.
   */
  handleTabKey(tab, event, input) {
    if (!input || input.type !== "keyDown" || input.alt || input.shift) return;
    if (!(input.meta || input.control)) return;
    if (!/^[1-9]$/.test(String(input.key))) return;
    let scoped;
    try {
      scoped = this.scopeTabs(tab.scopeKey);
    } catch {
      return; // A scope torn down under a still-live view.
    }
    // The position IS the index the panel's strip and `tabAt` both mean — the
    // state a tab is serialized into numbers it the same way (`state`), so the
    // key and the strip cannot come to disagree about which tab ⌘2 is.
    const position = Number(input.key) - 1;
    if (!scoped[position]) return;
    event.preventDefault();
    this.selectTab(tab.scopeKey, position).catch(() => {});
  }

  /** The HUMAN's view moves to a tab — the tab strip, the keyboard shortcuts,
   *  the extension host. Leaves the agent's focus exactly where it was. */
  async selectTab(scopeKey, index) {
    const scope = this.requireScope(scopeKey);
    const tab = this.tabAt(scope, index);
    await this.wakeTab(tab);
    this.activeTabIds.set(scope, tab.id);
    { const host = tab.view ? this.hostOfTab(tab) : null; if (host) host.selectTab(tab.view.webContents); }
    this.applyVisibility();
    this.emitState(scope);
  }

  closeTab(scopeKey, index, closedBy = "agent") {
    const scope = this.requireScope(scopeKey);
    return this.closeTabRef(index === undefined ? this.activeTab(scope) : this.tabAt(scope, index), closedBy);
  }

  /** Close BY IDENTITY — what a queued close must do, since the index it was
   *  given may name a different tab by the time it runs. */
  closeTabRef(tab, closedBy = "agent") {
    const scope = tab.scopeKey;
    const scoped = this.scopeTabs(scope);
    if (!scoped.includes(tab)) throw new Error("That browser tab is already closed.");
    const position = scoped.indexOf(tab);
    this.tabs = this.tabs.filter((candidate) => candidate !== tab);
    this.noteAgentTabClosed(tab);
    this.hibernateTab(tab);
    if (this.activeTabIds.get(scope) === tab.id) {
      // "Current" moves to the nearest neighbour, the way every browser does it.
      const remaining = this.scopeTabs(scope);
      this.activeTabIds.set(scope, remaining[position]?.id ?? remaining[position - 1]?.id ?? null);
    }
    // CLOSING THE LAST TAB ENDS THE BROWSER (issue #383), the way it does in
    // every browser anybody uses. It used to open one blank tab instead, on
    // the argument that a panel with no tab has no address bar to type into
    // and no page to snapshot — which is true, and is an argument for the
    // panel closing rather than for a tab nobody asked for. Closing the last
    // one is how a person says they are done with this browser, and answering
    // it with a fresh New Tab made that impossible to say.
    if (!this.scopeTabs(scope).length) return this.endBrowser(scope);
    this.applyVisibility();
    this.emitState(scope);
  }

  /**
   * THE SCOPE'S BROWSER IS OVER — its last tab just closed.
   *
   * The native views are already gone (`hibernateTab` closed each one's
   * WebContents as it was removed); what is left is the pointers into a tab
   * list that no longer exists, the claim on the window, and telling the panel.
   *
   * THE PROFILE BINDING STAYS. `forgetScope` drops it, and an unbound scope is
   * REFUSED a tab (`partitionOf`) — so forgetting here would mean an agent
   * whose last tab closed could not open another one. What ends is the
   * browser, not the session's right to have one.
   *
   * `ended` rides the push rather than the state: the panel tab closes on the
   * EVENT, and a scope with no tabs is otherwise indistinguishable from one
   * that has not opened its first page yet.
   */
  endBrowser(scopeKey) {
    const scope = this.requireScope(scopeKey);
    this.activeTabIds.delete(scope);
    this.boundsByScope.delete(scope);
    this.radiusByScope.delete(scope);
    if (this.visibleScopeKey === scope) this.visibleScopeKey = null;
    this.applyVisibility();
    this.emitState(scope, { ended: true });
  }

  /**
   * The IPC surface behind the cockpit's own chrome — URL bar, tab strip,
   * back/forward — which is a human's hand by construction. Typing an address
   * marks the human active on the tab and bumps its generation, so an agent
   * mutation defers briefly and then has to look again. The agent's own
   * `browser_navigate_back` goes through `performAction` and marks nothing.
   */
  async action(scopeKey, action) {
    const scope = this.requireScope(scopeKey);
    const kind = action?.action;
    // Navigating, going back/forward, reloading: the human drove the ACTIVE
    // tab. Selecting is just looking; closing removes the tab.
    if (kind === "navigate" || kind === "back" || kind === "forward" || kind === "reload") {
      this.noteHumanInput(scope, { force: true });
    }
    // Typing in the address bar, before any submit: the human's hands are on
    // the tab now, and an agent mutation should defer already.
    if (kind === "intent") {
      this.noteHumanInput(scope, { force: true });
      return this.state(scope);
    }
    /**
     * DEVTOOLS ARE THE HUMAN'S SURFACE ONLY, which is why this sits here and
     * not in `performAction`: an agent's tool calls share that switch, and
     * opening a debugger window over the person's screen is not something a
     * background agent should be able to do.
     */
    if (kind === "toggle-devtools") return this.toggleDevTools(scope);
    /**
     * THE OPTIONS MENU'S VERBS (#473) SIT HERE FOR THE SAME REASON DEVTOOLS
     * DOES: they are the cockpit's own chrome. Zoom and appearance change what
     * the page lays out as, which an agent's snapshot then describes — the
     * human sets those, and `performAction` is the switch agents share.
     */
    if (kind === "hard-reload") {
      const tab = await this.wakeTab(action.index === undefined ? this.activeTab(scope) : this.tabAt(scope, action.index));
      this.noteHumanInput(scope, { force: true });
      await this.beforeNavigation(tab);
      // The whole point of the row: the HTTP cache is bypassed, so a rebuilt
      // asset is fetched rather than re-read.
      tab.view.webContents.reloadIgnoringCache();
      return this.state(scope);
    }
    if (kind === "zoom") {
      const tab = await this.wakeTab(action.index === undefined ? this.activeTab(scope) : this.tabAt(scope, action.index));
      tab.zoom = zoomStep(tab.zoom, action.direction);
      this.applyZoom(tab);
      this.emitState(scope);
      return this.state(scope);
    }
    if (kind === "appearance") {
      const tab = await this.wakeTab(action.index === undefined ? this.activeTab(scope) : this.tabAt(scope, action.index));
      tab.colorScheme = resolveColorScheme(action.scheme);
      await this.applyGeometry(tab);
      this.emitState(scope);
      return this.state(scope);
    }
    if (kind === "preview") return this.openPreview(scope, action.index);
    if (kind === "end-preview") return this.closePreview(scope, action.index);
    if (kind === "new") return (await this.createTab(scope, action.url || "about:blank", "human"), this.state(scope));
    if (kind === "close") return (this.closeTab(scope, action.index, "human"), this.state(scope));
    // The toolbar's viewport control: a preset or a custom size for the
    // addressed tab (the active one by default). Presentation-only for the
    // panel — the page reflows to its new intrinsic size, and an agent
    // looking at it next sees exactly that.
    if (kind === "resize") {
      const tab = action.index === undefined ? this.activeTab(scope) : this.tabAt(scope, action.index);
      await this.resizeTab(tab, action);
      return this.state(scope);
    }
    return this.performAction(scope, action, "human");
  }

  /** The quit path's synchronous save (main.js will-quit). */
  persistSync() {
    if (!this.tabStore || this._disposed) return;
    this.tabStore.flushSync(this.inventory());
  }

  async performAction(scopeKey, action, opener = "agent") {
    const scope = this.requireScope(scopeKey);
    switch (action?.action) {
      case "new":
        await this.createTab(scope, action.url || "about:blank", opener);
        break;
      case "select":
        await this.selectTab(scope, action.index);
        break;
      case "close":
        this.closeTab(scope, action.index, opener);
        break;
      /**
       * DUPLICATE — a second tab at the same address, the way every browser's
       * strip offers it.
       *
       * THE SOURCE'S *LIVE* URL, not the record's. `tab.url` is what the tab
       * was last reported at; `webContents.getURL()` is where it actually is,
       * and the two differ for exactly as long as a navigation is in flight —
       * which is precisely when somebody duplicates a tab to keep the page
       * they had. `state()` resolves them the same way, so the strip and this
       * agree about what "this tab" means.
       *
       * A SLEEPING TAB DUPLICATES FINE: it has no WebContents to ask, and its
       * remembered `url` is the whole of what it is.
       */
      case "duplicate": {
        const source = action.index === undefined ? this.activeTab(scope) : this.tabAt(scope, action.index);
        const live = source.view && !source.view.webContents.isDestroyed() ? source.view.webContents.getURL() : "";
        await this.createTab(scope, live || source.url || "about:blank", opener);
        break;
      }
      case "navigate": {
        const tab = this.scopeTabs(scope).length ? this.activeTab(scope) : await this.createTab(scope, "about:blank", opener);
        await this.navigateTab(tab, action.url);
        break;
      }
      case "back":
        await this.goBack(await this.wakeTab(this.activeTab(scope)));
        break;
      case "forward": {
        const tab = await this.wakeTab(this.activeTab(scope));
        const wc = tab.view.webContents;
        if (navigationFlag(wc, "canGoForward")) {
          await this.beforeNavigation(tab);
          wc.navigationHistory.goForward();
        }
        break;
      }
      /**
       * RELOAD MAY NAME A TAB, the way close and select already do.
       *
       * The toolbar button never does — it is about the page you are looking
       * at — but the strip's per-tab menu is about the tab you right-clicked,
       * and reloading a background tab must not drag your view to it. Without
       * an index this is exactly what it always was.
       */
      case "reload": {
        const tab = await this.wakeTab(action.index === undefined ? this.activeTab(scope) : this.tabAt(scope, action.index));
        await this.beforeNavigation(tab);
        tab.view.webContents.reload();
        break;
      }
      default:
        throw new Error("Unknown desktop browser action.");
    }
    return this.state(scope);
  }

  async ensureDebugger(tab, { sync = true } = {}) {
    const debug = tab.view.webContents.debugger;
    if (!debug.isAttached()) debug.attach("1.3");
    if (!tab.debuggerListenersBound) {
      debug.on("message", (_event, method, params) => {
        if (method === "Runtime.consoleAPICalled") {
          // Each ARGUMENT is bounded before the join, so a single huge one
          // cannot build a huge intermediate on its way to being truncated.
          const text = logText((params.args || []).map((arg) => logText(arg.value ?? arg.description ?? "")).join(" "));
          pushCapped(tab.console, { level: params.type || "log", text });
        }
        if (method === "Log.entryAdded") {
          pushCapped(tab.console, { level: params.entry?.level || "info", text: logText(params.entry?.text || "") });
        }
        if (method === "Network.requestWillBeSent") {
          pushCapped(tab.network, { method: params.request?.method || "GET", url: logText(params.request?.url || "") });
        }
      });
      debug.on("detach", () => {
        tab.debuggerReady = false;
      });
      tab.debuggerListenersBound = true;
    }
    if (!tab.debuggerReady) {
      await Promise.all([
        debug.sendCommand("DOM.enable"),
        debug.sendCommand("Runtime.enable"),
        debug.sendCommand("Accessibility.enable"),
        debug.sendCommand("Network.enable"),
        debug.sendCommand("Log.enable"),
        debug.sendCommand("Page.enable"),
      ]);
      tab.debuggerReady = true;
    }
    // Through the serialized pipeline, never a direct write: an agent call
    // arriving mid-resize must not interleave its emulation with the run.
    // The pipeline itself asks with `sync: false` (it IS the run).
    if (sync) await this.applyGeometry(tab);
    return debug;
  }

  /**
   * EVERY TAB LAYS OUT FOR ITS OWN VIEWPORT, SHOWN OR NOT.
   *
   * Why hidden tabs need one at all: until the cockpit's panel mounts and
   * publishes bounds, every view sits at the 1×1 default — Chromium
   * hit-tests synthetic mouse events against the visual viewport, so a click
   * at (140, 96) lands outside a 1×1 window and is silently dropped, and
   * `Page.captureScreenshot` has no frame to return. The agent browsing while
   * the panel is closed (or from a remote client with no panel) is the
   * intended case, not an edge.
   *
   * Why shown tabs keep it too (item 11): the panel's column width used to
   * BE the viewport — narrowing the sidebar reflowed the page, so the agent's
   * snapshot described one layout and the human looked at another. Now the
   * intrinsic size is the tab's own (standard 1280×800, a preset, or a
   * custom size) and what the panel changes is only the presentation
   * `scale` that fits it into the column. Idempotent per target so a poll
   * does not re-send it.
   */
  async syncViewport(tab, debug) {
    // FIXED tabs (and every hidden tab) are emulated at their own viewport:
    // the page lays out for that size wherever it is, and a shown fixed tab
    // carries a presentation `scale` to fit the column. A FIT tab ON SCREEN
    // is emulated at NOTHING: it lays out for the native bounds like an
    // ordinary browser. Measured (Dev, 2026-09-06): emulating the stage
    // size under fit read as ZOOM — the async override lagged the native
    // `setBounds` by a frame per resize, and any moment the recorded size
    // and the bounds disagreed (an animation frame, a sub-minimum frame)
    // Chromium scaled the stale emulated viewport into the rect.
    const target = this.viewportTarget(tab);
    if (!target.emulate) {
      // `undefined` = a fresh WebContents with no override; nothing to clear.
      if (tab.viewportOverride === undefined || tab.viewportOverride === "native") { tab.viewportOverride = "native"; return; }
      await debug.sendCommand("Emulation.clearDeviceMetricsOverride");
      tab.viewportOverride = "native";
      return;
    }
    const wanted = emulationKey(target);
    if (tab.viewportOverride === wanted) return;
    await debug.sendCommand("Emulation.setDeviceMetricsOverride", {
      width: target.width,
      height: target.height,
      deviceScaleFactor: 1,
      mobile: false,
      ...(target.scale === 1 ? {} : { scale: target.scale }),
    });
    tab.viewportOverride = wanted;
  }

  /** The tab's zoom, pushed to its live WebContents. A no-op for a sleeping
   *  tab — waking it runs the pipeline, which lands here again. */
  applyZoom(tab) {
    const wc = this.contentsOf(tab);
    if (!wc?.setZoomFactor) return;
    try { wc.setZoomFactor(tab.zoom || 1); } catch { /* a page mid-teardown */ }
  }

  /**
   * IS THERE ANY APPEARANCE TO SEND? Asked separately so the geometry pipeline
   * can skip the `await` entirely in the ordinary case — an await on a settled
   * no-op still costs that run a microtask, and how far the run gets before
   * the next one is queued is observable (the debugger binds inside it).
   *
   * `undefined` = a fresh WebContents emulating nothing, which IS "system":
   * clearing it would be a round trip to assert the status quo on every tab.
   */
  needsColorScheme(tab) {
    const wanted = tab.colorScheme || "system";
    if (tab.colorSchemeApplied === wanted) return false;
    return !(wanted === "system" && tab.colorSchemeApplied === undefined);
  }

  /**
   * WHAT `prefers-color-scheme` ANSWERS IN THIS TAB. "system" clears the
   * override rather than asserting the host's own scheme — a page then reads
   * whatever it would have read with nobody emulating anything, which is what
   * "system" means. Recorded only once the command lands, like the viewport
   * override, so a refusal is not remembered as applied.
   */
  async applyColorScheme(tab, debug) {
    const wanted = tab.colorScheme || "system";
    await debug.sendCommand("Emulation.setEmulatedMedia", {
      features: wanted === "system" ? [] : [{ name: "prefers-color-scheme", value: wanted }],
    });
    tab.colorSchemeApplied = wanted;
  }

  /** What the emulation for this tab should be right now. */
  viewportTarget(tab) {
    if (this.isNativeFit(tab)) {
      const stage = this.stageBounds();
      return { emulate: false, width: stage.width, height: stage.height, scale: 1 };
    }
    const viewport = this.viewportOf(tab);
    // THE PRESENTATION SCALE IS NATIVE. The page renders into the view's own
    // pixels, and the view is the fitted rect scaled by the cockpit's zoom
    // (`place`), so the same zoom rides the scale or the page is rendered at
    // a size the view does not have — clipped at 0.9×, letterboxed at 1.1×
    // (#895). The CSS-space scale the renderer draws its frame with stays
    // unzoomed, which is why `state()` computes that one itself.
    const scale = this.isTabVisible(tab) ? fitViewport(viewport, this.bounds).scale * this.cockpitZoom() : 1;
    return { emulate: true, width: viewport.width, height: viewport.height, scale };
  }

  /**
   * CDP `Input.dispatch*Event` takes NATIVE coordinates: under a fit scale the
   * page's CSS point (what a snapshot's element rect says) lands at
   * `css × scale` (measured — the unscaled point misses). Native input from a
   * human's hands is mapped by Chromium on its own; only the agent's synthetic
   * events need this.
   */
  inputPoint(tab, point) {
    const { scale } = this.viewportTarget(tab);
    return scale === 1 ? point : { ...point, x: point.x * scale, y: point.y * scale };
  }

  /**
   * BEFORE A NAVIGATION THIS PROCESS STARTS, clear the emulation and WAIT
   * for the clear. A new document that commits under an active
   * `setDeviceMetricsOverride` never produces a compositor frame while
   * hidden — every capture times out, and only a new WebContents recovers
   * (measured: navigate, reload and back all fail; the same three pass when
   * the clear is awaited first and the override re-applied at dom-ready).
   * The `did-start-navigation` hook below is the best-effort for
   * navigations the PAGE starts (a link, a redirect): it keeps the tab's
   * state truthful so dom-ready re-applies, but it fires too late to save
   * that document's capture — a known limit, not a silent one.
   */
  async beforeNavigation(tab) {
    if (!tab.view || !tab.debuggerReady || !tab.viewportOverride) return;
    tab.viewportOverride = undefined;
    try {
      await tab.view.webContents.debugger.sendCommand("Emulation.clearDeviceMetricsOverride");
    } catch {
      // A torn-down debugger mid-navigation: dom-ready re-syncs regardless.
    }
  }

  /**
   * THE INTRINSIC SCREENSHOT — the page at its own viewport, whatever the
   * panel scale. `captureScreenshot` with an explicit CSS clip at scale 1:
   * measured, a plain capture (and `capturePage`) under a fit scale returns
   * the intrinsic dimensions with the content shrunk into a corner and the
   * rest blank; the clip renders the real layout. A visible view has a
   * compositor frame; a hidden one may not (`captureHidden` handles that).
   */
  captureIntrinsic(debug, tab, format, fullPage, documentHeight) {
    const viewport = this.effectiveViewport(tab);
    return debug.sendCommand("Page.captureScreenshot", {
      format,
      fromSurface: true,
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: viewport.width, height: fullPage && documentHeight ? documentHeight : viewport.height, scale: 1 },
    });
  }

  /** Every live tab through the pipeline — kept as a name for callers. */
  resyncViewports() {
    this.applyVisibility();
  }

  /**
   * The page's accessibility tree, optionally narrowed.
   *
   * `args.target` is a ref from the PREVIOUS snapshot of this tab — it has to
   * be resolved against `tab.refs` before the re-mint clears them, which is
   * the only ordering subtlety here. An unknown ref is refused by name rather
   * than quietly widened back to the whole page: a model that asked about one
   * region and got the document would read the answer as the region.
   */
  async snapshot(tab, args = {}) {
    const debug = await this.ensureDebugger(tab);
    const target = String(args.target || "").trim();
    const backendNodeId = target ? tab.refs.get(target) : undefined;
    if (target && !backendNodeId) {
      throw new Error(`Unknown browser target ${target}. Take a fresh browser_snapshot first.`);
    }
    const result = await debug.sendCommand("Accessibility.getFullAXTree", { depth: 40 });
    const nodes = Array.isArray(result.nodes) ? result.nodes : [];
    let rootNodeId = null;
    if (backendNodeId) {
      const root = nodes.find((node) => Number(node.backendDOMNodeId || 0) === backendNodeId);
      if (!root) throw new Error(`${target} is no longer on the page. Take a fresh browser_snapshot first.`);
      rootNodeId = root.nodeId;
    }
    const maxDepth = Number.isInteger(args.depth) && args.depth >= 0 ? args.depth : null;
    const rendered = renderSnapshot(nodes, { title: tab.title, url: tab.url, rootNodeId, maxDepth });
    tab.refs.clear();
    for (const [ref, id] of rendered.refs) tab.refs.set(ref, id);
    return okText(rendered.text);
  }

  backendNode(tab, target) {
    const ref = String(target || "").trim();
    const backendNodeId = tab.refs.get(ref);
    if (!backendNodeId) {
      throw new Error(`Unknown browser target ${ref || "(empty)"}. Take a fresh browser_snapshot first.`);
    }
    return backendNodeId;
  }

  async callOnNode(tab, backendNodeId, functionDeclaration, args = []) {
    const debug = await this.ensureDebugger(tab);
    const resolved = await debug.sendCommand("DOM.resolveNode", { backendNodeId });
    const objectId = resolved.object?.objectId;
    if (!objectId) throw new Error("The selected element is no longer available. Take a fresh snapshot.");
    return debug.sendCommand("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration,
      arguments: args.map((value) => ({ value })),
      returnByValue: true,
      awaitPromise: true,
    });
  }

  async targetPoint(tab, target) {
    const backendNodeId = this.backendNode(tab, target);
    const result = await this.callOnNode(
      tab,
      backendNodeId,
      "function(){ this.scrollIntoView({block:'center',inline:'center'}); const r=this.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2,width:r.width,height:r.height}; }",
    );
    const point = result.result?.value;
    if (!point || point.width <= 0 || point.height <= 0) throw new Error("The selected element is not visible.");
    return { backendNodeId, x: point.x, y: point.y };
  }

  async showAgentCursor(tab, point, phase) {
    const debug = await this.ensureDebugger(tab);
    const payload = JSON.stringify({ ...point, phase, duration: CURSOR_MOVE_MS });
    await debug.sendCommand("Runtime.evaluate", {
      expression: `(() => {
        const data = ${payload};
        let root = document.getElementById('__telar_agent_cursor__');
        if (!root) {
          root = document.createElement('div');
          root.id = '__telar_agent_cursor__';
          root.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;width:24px;height:24px;opacity:0;transition:transform 160ms cubic-bezier(.22,1,.36,1),opacity 90ms ease;filter:drop-shadow(0 1px 2px rgba(0,0,0,.35))';
          root.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M5 3.5 19 13l-6.2 1.2 3.4 5.6-2.8 1.7-3.3-5.6L6 20z" fill="#fff" stroke="#2563eb" stroke-width="1.8" stroke-linejoin="round"/></svg>';
          document.documentElement.appendChild(root);
        }
        root.style.opacity = '1';
        root.style.transform = 'translate3d(' + data.x + 'px,' + data.y + 'px,0)';
        clearTimeout(window.__telarAgentCursorTimer);
        window.__telarAgentCursorTimer = setTimeout(() => {
          root.style.opacity = '0.38';
          window.__telarAgentCursorTimer = setTimeout(() => {
            root.style.opacity = '0';
          }, 6000);
        }, 2200);
        if (data.phase === 'click') {
          const ring = document.createElement('span');
          ring.style.cssText = 'position:absolute;left:-7px;top:-7px;width:24px;height:24px;border-radius:999px;background:rgba(37,99,235,.22);animation:__telar_cursor_ping 360ms ease-out forwards';
          if (!document.getElementById('__telar_cursor_style__')) {
            const style = document.createElement('style');
            style.id = '__telar_cursor_style__';
            style.textContent = '@keyframes __telar_cursor_ping{from{transform:scale(.35);opacity:1}to{transform:scale(1.8);opacity:0}}';
            document.documentElement.appendChild(style);
          }
          root.prepend(ring);
          setTimeout(() => ring.remove(), 450);
        }
      })()`,
    });
    if (!this.window.isDestroyed()) {
      this.window.webContents.send("telar:browser:pointer", {
        scopeKey: tab.scopeKey,
        tabId: tab.id,
        phase,
        x: point.x,
        y: point.y,
        createdAt: new Date().toISOString(),
      });
    }
  }

  async click(tab, args, action) {
    const point = await this.targetPoint(tab, args.target);
    await this.showAgentCursor(tab, point, "move");
    await this.wait(CURSOR_MOVE_MS);
    await this.showAgentCursor(tab, point, "click");
    await this.wait(CURSOR_CLICK_LEAD_MS);
    const debug = await this.ensureDebugger(tab);
    const button = args.button || "left";
    const clickCount = args.doubleClick ? 2 : 1;
    if (action) this.checkpoint(action);
    // One pointerdown per press → one preload report expected.
    this.stampAgentInput(tab, clickCount);
    const native = this.inputPoint(tab, point);
    await debug.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x: native.x, y: native.y });
    await debug.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", x: native.x, y: native.y, button, clickCount });
    await debug.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x: native.x, y: native.y, button, clickCount });
    return okText(`Clicked ${args.element || args.target}.`);
  }

  async type(tab, args, action) {
    const backendNodeId = this.backendNode(tab, args.target);
    if (action) this.checkpoint(action);
    await this.callOnNode(
      tab,
      backendNodeId,
      "function(){ this.scrollIntoView({block:'center',inline:'center'}); this.focus(); if ('value' in this) { this.value=''; this.dispatchEvent(new Event('input',{bubbles:true})); } }",
    );
    const debug = await this.ensureDebugger(tab);
    const text = String(args.text ?? "");
    if (args.slowly) {
      for (const char of text) {
        if (action) this.checkpoint(action);
        this.stampAgentInput(tab); // insertText raises no keydown: nothing to expect
        await debug.sendCommand("Input.insertText", { text: char });
        await this.wait(15);
      }
    } else {
      if (action) this.checkpoint(action);
      this.stampAgentInput(tab);
      await debug.sendCommand("Input.insertText", { text });
    }
    if (args.submit) await this.press(tab, { key: "Enter" }, action);
    return okText(`Typed into ${args.element || args.target}.`);
  }

  async press(tab, args, action) {
    const key = String(args.key || "");
    if (!key) throw new Error("A key is required.");
    if (action) this.checkpoint(action);
    this.stampAgentInput(tab, 1); // keyDown → one keydown report
    tab.view.webContents.sendInputEvent({ type: "keyDown", keyCode: key });
    tab.view.webContents.sendInputEvent({ type: "keyUp", keyCode: key });
    return okText(`Pressed ${key}.`);
  }

  async fillForm(tab, args, action) {
    for (const field of Array.isArray(args.fields) ? args.fields : []) {
      const backendNodeId = this.backendNode(tab, field.target);
      if (field.type === "checkbox" || field.type === "radio") {
        const checked = /^(true|1|yes|on)$/i.test(String(field.value));
        if (action) this.checkpoint(action);
        await this.callOnNode(tab, backendNodeId, "function(value){ if (this.checked !== value) this.click(); }", [checked]);
      } else if (field.type === "combobox") {
        await this.selectOption(tab, { target: field.target, values: [field.value] }, action);
      } else {
        await this.type(tab, { target: field.target, element: field.element || field.name, text: field.value }, action);
      }
    }
    return okText("Filled the requested form fields.");
  }

  async selectOption(tab, args, action) {
    const backendNodeId = this.backendNode(tab, args.target);
    if (action) this.checkpoint(action);
    await this.callOnNode(
      tab,
      backendNodeId,
      "function(values){ const wanted=new Set(values.map(String)); for (const option of this.options || []) option.selected=wanted.has(option.value)||wanted.has(option.text); this.dispatchEvent(new Event('input',{bubbles:true})); this.dispatchEvent(new Event('change',{bubbles:true})); }",
      [Array.isArray(args.values) ? args.values : []],
    );
    return okText(`Selected an option in ${args.element || args.target}.`);
  }

  /**
   * A SCREENSHOT OF A HIDDEN VIEW. `Page.captureScreenshot {fromSurface}`
   * reads the compositor, and a view that is not shown has no compositor
   * frame — the command never answers. The visible path keeps it (it is
   * exact, and supports fullPage); the hidden path uses Electron's own
   * `capturePage` with `stayHidden`, which paints the view offscreen
   * without showing it or taking focus. Both are bounded: a capture that
   * outlives CAPTURE_TIMEOUT_MS is an error result, never a 30s hang.
   */
  async screenshot(tab, args) {
    const debug = await this.ensureDebugger(tab);
    const format = args.type === "jpeg" ? "jpeg" : "png";
    const fullPage = Boolean(args.fullPage);
    const data = this.isTabVisible(tab)
      ? await withTimeout(
          (async () => {
            const documentHeight = fullPage ? await this.measureDocument(debug).then((metrics) => metrics.height) : undefined;
            return (await this.captureIntrinsic(debug, tab, format, fullPage, documentHeight)).data;
          })(),
          CAPTURE_TIMEOUT_MS,
          CAPTURE_TIMEOUT_MESSAGE,
        )
      : await this.captureHidden(tab, debug, format, fullPage);
    return { content: [{ type: "image", data, mimeType: `image/${format}` }] };
  }

  async measureDocument(debug) {
    const { result } = await debug.sendCommand("Runtime.evaluate", {
      expression: "({ width: Math.ceil(Math.max(document.documentElement.scrollWidth, innerWidth)), height: Math.ceil(Math.max(document.documentElement.scrollHeight, innerHeight)) })",
      returnByValue: true,
    });
    const metrics = result?.value;
    if (!metrics || !(metrics.width > 0 && metrics.height > 0)) throw new Error("Could not measure the page for a full-page capture.");
    return metrics;
  }

  /**
   * The hidden path. `capturePage` paints only the viewport, so a fullPage
   * request is honoured by temporarily emulating the document's own height
   * (the same trick DevTools uses) and restoring the viewport afterwards;
   * it is never silently downgraded to a viewport shot.
   */
  async captureHidden(tab, debug, format, fullPage) {
    const wc = tab.view.webContents;
    let metrics = null;
    if (fullPage) {
      metrics = await this.measureDocument(debug);
      await debug.sendCommand("Emulation.setDeviceMetricsOverride", { width: metrics.width, height: metrics.height, deviceScaleFactor: 1, mobile: false });
    }
    try {
      // The deadline lives INSIDE the try so a capture that never settles
      // still runs the restore below; raced outside, a timeout would have
      // left the page at document height for good.
      const image = await withTimeout(wc.capturePage(undefined, { stayHidden: true, stayAwake: true }), CAPTURE_TIMEOUT_MS, CAPTURE_TIMEOUT_MESSAGE);
      if (image.isEmpty()) throw new Error("The hidden page produced an empty frame.");
      return (format === "jpeg" ? image.toJPEG(80) : image.toPNG()).toString("base64");
    } finally {
      if (metrics) {
        // Back to the tab's own viewport — through the pipeline, so a
        // resize that landed during the capture is not undone by this.
        tab.viewportOverride = undefined;
        await this.applyGeometry(tab).catch(() => {});
      }
    }
  }

  /**
   * THE COCKPIT'S OWN SCREENSHOT (#474) — the camera button in the address
   * row, and the frozen frame the annotate overlay draws on.
   *
   * NOT `callTool("browser_take_screenshot")`, and the difference is WHOSE TAB
   * IT IS. A tool call reads the AGENT's tab (`peekTarget`) and waits behind
   * that tab's queue — both correct for an agent, and both wrong for a person
   * pressing a camera on the page in front of them. This reads the tab THEY
   * are looking at.
   *
   * AT THE TAB'S OWN SCALE, NEVER THE PANEL'S FIT SCALE. `screenshot` resolves
   * to `captureIntrinsic`'s explicit scale-1 clip, so a page laid out at
   * 1280×800 inside a 640px column comes back 1280×800 — not a third of one in
   * the corner of a blank frame, which is what a plain capture under a fit
   * scale returns (measured; see `captureIntrinsic`). The viewport travels with
   * the image because the overlay draws ON it and has to know what a pixel is.
   */
  async capture(scopeKey, options = {}) {
    const scope = this.requireScope(scopeKey);
    if (!this.scopeTabs(scope).length) throw new Error("There is no page here to capture.");
    const tab = await this.wakeTab(this.activeTab(scope));
    // The same refusal every tool path wears: an extension's own pages are
    // nobody's to photograph, least of all a password manager's unlock.
    if (isProtectedUrl(tab.url)) throw new Error("That tab is showing an extension page. Telar does not capture extension pages.");
    if (this.isBlank(tab)) throw new Error("There is no page loaded in this tab to capture.");
    const fullPage = Boolean(options.fullPage);
    const outcome = await this.screenshot(tab, { type: "png", fullPage });
    const image = outcome.content?.find((entry) => entry.type === "image");
    if (!image?.data) throw new Error("The page produced no frame to capture.");
    const viewport = this.effectiveViewport(tab);
    return {
      data: image.data,
      mimeType: image.mimeType,
      url: tab.url,
      title: tab.title,
      fullPage,
      width: viewport.width,
      height: viewport.height,
      ...(options.elements ? { elements: await this.elementBoxes(tab) } : {}),
    };
  }

  /**
   * WHAT THE ANNOTATE OVERLAY CAN PICK (#474): every element worth pointing
   * at, with the rect it occupies in the SAME CSS pixels the capture above is
   * measured in, and enough about it to name in a message — its role, its
   * accessible name, and a selector that finds it again.
   *
   * GEOMETRY, WHICH IS WHY IT IS NOT `snapshot`. That one emits refs and text
   * off the AX tree and carries no rects; the overlay hit-tests in the
   * renderer while the native view is HIDDEN behind a frozen frame, so a
   * per-hover round trip is not available to it either. One evaluate, taken at
   * the same instant as the frame it is about, is both cheaper and truer than
   * asking the live page where things are after it has been hidden.
   *
   * SMALLEST AREA FIRST, so a hit test can take the first box containing the
   * point and get the innermost element rather than the <body> around it.
   * Offscreen and zero-area elements never appear: nothing can be under the
   * pointer that is not on screen.
   */
  async elementBoxes(tab) {
    const debug = await this.ensureDebugger(tab);
    const { result } = await debug.sendCommand("Runtime.evaluate", {
      expression: `(() => {
        const selectorFor = (el) => {
          if (el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) return '#' + CSS.escape(el.id);
          const parts = [];
          for (let node = el; node && node.nodeType === 1 && parts.length < 5; node = node.parentElement) {
            const tag = node.localName;
            if (node.id && document.querySelectorAll('#' + CSS.escape(node.id)).length === 1) { parts.unshift('#' + CSS.escape(node.id)); break; }
            const siblings = node.parentElement ? [...node.parentElement.children].filter((other) => other.localName === tag) : [tag];
            parts.unshift(siblings.length > 1 ? tag + ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')' : tag);
          }
          return parts.join(' > ');
        };
        const nameOf = (el) => (
          el.getAttribute('aria-label') ||
          (el.labels && el.labels[0] && el.labels[0].textContent) ||
          el.getAttribute('alt') ||
          el.getAttribute('placeholder') ||
          el.getAttribute('title') ||
          (el.value && typeof el.value === 'string' ? el.value : '') ||
          el.textContent ||
          ''
        ).replace(/\\s+/g, ' ').trim().slice(0, 120);
        const roleOf = (el) => el.getAttribute('role') || el.localName;
        const boxes = [];
        for (const el of document.body ? document.body.querySelectorAll('*') : []) {
          const rect = el.getBoundingClientRect();
          if (rect.width < 2 || rect.height < 2) continue;
          if (rect.bottom < 0 || rect.right < 0 || rect.top > innerHeight || rect.left > innerWidth) continue;
          const style = getComputedStyle(el);
          if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue;
          boxes.push({
            role: roleOf(el),
            name: nameOf(el),
            selector: selectorFor(el),
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          });
          if (boxes.length >= 1500) break;
        }
        return boxes.sort((a, b) => a.width * a.height - b.width * b.height);
      })()`,
      returnByValue: true,
    });
    return Array.isArray(result?.value) ? result.value : [];
  }

  /** Nothing loaded and nothing loading: the start page's case. */
  isBlank(tab) {
    const url = tab.view && !tab.view.webContents.isDestroyed?.() ? tab.view.webContents.getURL() || tab.url : tab.url;
    return (!url || url === "about:blank") && !tab.loading && tab.navigationPending === 0;
  }

  /**
   * THE TAB IS IN A WINDOW OF ITS OWN (#473), so the cockpit's panel is not
   * where it is drawn. Every place that places, sizes or hides a view asks
   * this first: the view is a child of the preview window's `contentView`
   * while this is true, and a `setVisible(false)` meant for the panel would
   * blank the window a person is looking at.
   */
  previewing(tab) {
    return Boolean(tab?.previewWindow && !tab.previewWindow.isDestroyed?.());
  }

  /** The rect the previewed view fills inside its own window. */
  previewRect(tab) {
    const [width, height] = tab.previewWindow?.getContentSize?.() || [];
    const viewport = this.viewportOf(tab);
    return { x: 0, y: 0, width: Math.max(1, Math.round(width || viewport.width)), height: Math.max(1, Math.round(height || viewport.height)) };
  }

  /**
   * The visible scope's active tab — what the native view shows. A PREVIEWED
   * tab is shown in its own window instead, so it is not this panel's: it
   * keeps its intrinsic viewport (no fit adoption, no presentation scale)
   * rather than following a panel it has left.
   */
  isTabShown(tab) {
    if (this.previewing(tab)) return false;
    return tab.scopeKey === this.visibleScopeKey && tab.id === this.activeTabIds.get(tab.scopeKey);
  }

  /** Shown AND with real panel bounds — what fit scaling and the visible
   *  capture path need. */
  isTabVisible(tab) {
    return this.isTabShown(tab) && this.bounds.width > 1 && this.bounds.height > 1;
  }

  listTabs(scopeKey) {
    const scope = this.requireScope(scopeKey);
    const tabs = this.scopeTabs(scope);
    if (!tabs.length) return okText("No browser tabs are open in this session.");
    const activeTabId = this.activeTabIds.get(scope);
    // Which tab an un-addressed call would act on, WITHOUT consuming the
    // closed-tab tombstone or throwing — listing tabs is how an agent
    // recovers from exactly that, so it must never be the thing that fails.
    const agentTabId = this.peekTarget(scope, {})?.id;
    // The {…} suffix is contract with the engine's parseBrowserTabs, which
    // tolerates exactly this shape — the model reads who opened and who holds
    // each tab without a second tool call.
    return okText(
      tabs
        .map((tab, index) => {
          /**
           * THE TAB'S OWN IDENTITY, because `tabId` is a POSITION. Every tool
           * addresses a tab by its index in this list (`tabAt`), so closing a
           * tab renumbers the ones after it and an index captured a moment ago
           * can name a different page. Callers that must act on the SAME tab
           * they inspected — the login path — compare this instead.
           */
          const meta = [`tab=${tab.id}`, `controller=${this.tabActivity(tab)}`, `opened-by=${tab.openedBy || "agent"}`];
          /**
           * WHICH IDENTITY THIS TAB IS SIGNED INTO, per tab and not per
           * session. After a profile switch a session's tabs are of two
           * profiles, and the credential path binds an authorization to the
           * profile of the tab it is about to type into — so it has to be able
           * to read that here rather than assume the session's next-tab
           * default. The label is percent-encoded: it is a person's free text
           * inside a comma-separated suffix.
           */
          if (tab.profileId) {
            meta.push(`profile=${tab.profileId}`);
            const profile = this.profiles.get(tab.profileId);
            if (profile) meta.push(`profile-label=${encodeURIComponent(profile.label)}`);
          }
          // "(current)" is the HUMAN's view; this is where YOUR next call
          // lands. They are routinely different tabs, and a model that cannot
          // tell them apart cannot work in the background on purpose.
          if (tab.id === agentTabId) meta.push("yours");
          if (tab.loading) meta.push("loading");
          if (isProtectedUrl(tab.url)) { meta.push("extension-page"); return `- ${index}: ${tab.id === activeTabId ? "(current) " : ""}[Extension page](about:blank) {${meta.join(", ")}}`; }
          return `- ${index}: ${tab.id === activeTabId ? "(current) " : ""}[${tab.title}](${tab.url}) {${meta.join(", ")}}`;
        })
        .join("\n"),
    );
  }

  async callTool(scopeKey, name, args = {}) {
    const scope = this.requireScope(scopeKey);
    return this.callToolInner(scope, name, args);
  }

  async callToolInner(scope, name, args) {
    const read = isReadTool(name, args);
    // AN EXTENSION'S OWN PAGES ARE NEVER A TARGET. A tab showing a
    // chrome-extension:// page (a popup, an unlock, a settings page) is the
    // password manager's, not the agent's, whether it wants to read or act.
    if (name !== "browser_tabs") {
      const candidate = this.scopeTabs(scope).length ? this.peekTarget(scope, args) : null;
      if (candidate && isProtectedUrl(candidate.url)) {
        return errorResult(new Error("That tab is showing an extension page. Browser tools do not read or act on extension pages."));
      }
    }
    // Which tab does this call touch? Page mutations hit the ACTIVE tab;
    // browser_tabs close hits the addressed one; new/select/list touch none.
    let targetTab = null;
    if (!read) {
      if (name === "browser_tabs") {
        if (args.action === "close") {
          try {
            targetTab = args.index === undefined ? this.agentTab(scope) : this.tabAt(scope, args.index);
          } catch (error) {
            return errorResult(error);
          }
        }
      } else if (this.scopeTabs(scope).length) {
        // The agent's own tab, or the one it named. A tombstone leaves this
        // null so the call falls through to `dispatch`, where resolving it
        // again reports the closed tab instead of silently redirecting.
        targetTab = this.peekTarget(scope, args);
      }
    }
    // A SNAPSHOT OR SCREENSHOT observes the tab it addresses — that is the
    // fresh view a later mutation may act on. Console and network are logs,
    // not a view of the page. The generation is captured BEFORE the read:
    // if it moved while the read ran, the read saw a page that is gone.
    let readTab = null;
    let readGeneration = -1;
    if (name === "browser_snapshot" || name === "browser_take_screenshot") {
      readTab = this.peekTarget(scope, args);
      readGeneration = readTab ? readTab.generation : -1;
    }
    // A mutation of ONE tab is serialized behind that tab's earlier mutations,
    // defers while a human is interacting there, and needs a fresh view.
    // Other tabs are independent: their queues never touch this one.
    if (targetTab) {
      const enqueuedAt = this.now();
      const run = () => this.runOnTab(scope, name, args, targetTab, enqueuedAt, (action) => this.dispatch(scope, name, args, action));
      const queued = targetTab.queue.then(run, run);
      targetTab.queue = queued.catch(() => undefined);
      return queued;
    }
    if (!read) this.lastAgentInputAt.set(scope, this.now());
    const outcome = this.protectedPostcheck(readTab, await this.dispatch(scope, name, args));
    if (readTab && this.tabs.includes(readTab) && !outcome.isError && readTab.generation === readGeneration) {
      this.noteObserved(readTab);
    }
    return outcome;
  }

  /**
   * THE DESTINATION IS CHECKED AGAIN AFTER THE CALL. The entry check saw the
   * URL the tab HAD; a redirect or a navigation in flight can land it on an
   * extension page by the time the read or navigation returns. If the tab
   * addressed now shows a protected URL, the result — a snapshot of the
   * unlock page, a screenshot of the popup — is refused, not returned.
   */
  protectedPostcheck(tab, outcome) {
    if (!tab || !this.tabs.includes(tab) || outcome.isError) return outcome;
    const current = tab.view && !tab.view.webContents.isDestroyed() ? tab.view.webContents.getURL() || tab.url : tab.url;
    if (isProtectedUrl(current)) {
      return errorResult(new Error("That tab is now showing an extension page. Browser tools do not read or act on extension pages."));
    }
    return outcome;
  }

  /**
   * The per-tab gate. Direct human input wins: while the human is active on
   * this tab the mutation waits — bounded — for their hands to lift. Then it
   * must have observed the page since the last human input or navigation; if
   * not, it is refused with the reason and never replayed. Then it runs, and
   * afterwards, if a navigation or human input landed DURING the action, the
   * model is told the page moved rather than handed a result that implies it
   * still sees what it saw.
   */
  async runOnTab(scope, name, args, tab, enqueuedAt, dispatch) {
    const index = () => Math.max(0, this.scopeTabs(scope).indexOf(tab));
    // The deadline counts from when the call was QUEUED, so time spent
    // behind an earlier action on this tab is not a second wait.
    const deadline = enqueuedAt + DEFER_MAX_MS;
    while (this.tabs.includes(tab) && this.humanActive(tab)) {
      if (this.now() >= deadline) return errorResult(new Error(humanActiveOn(tab, index())));
      await this.wait(DEFER_POLL_MS);
    }
    if (!this.tabs.includes(tab)) return errorResult(new Error(`Browser tab ${index()} was closed.`));
    // A deliberate navigation or tab-set change LEAVES the current page; it
    // does not act on it, so it needs no fresh view of it. Everything that
    // acts on the page — click, type, fill, select, press, hover — does.
    // A resize reflows the page rather than acting on it: no fresh view
    // needed, and the generation it bumps is its own doing.
    const actsOnPage = name !== "browser_navigate" && name !== "browser_navigate_back" && name !== "browser_tabs" && name !== "browser_resize";
    if (actsOnPage && tab.observedGeneration !== tab.generation) {
      return errorResult(new Error(staleView(tab, index(), tab.staleReason || "it changed")));
    }
    const generationAtStart = tab.generation;
    tab.interruptedAt = undefined;
    const action = { tab, ticket: this.nextTicket(tab), generation: generationAtStart, startedAt: this.now(), cancelled: false };
    tab.agentBusy += 1;
    this.lastAgentInputAt.set(scope, this.now());
    this.journalControl(tab, "agent");
    try {
      const outcome = this.protectedPostcheck(tab, await dispatch(action));
      if (!this.tabs.includes(tab) || outcome.isError) return outcome;
      // A NAVIGATION NEVER BLESSES THE PAGE IT LANDS ON — deliberate or not,
      // the agent has not seen it (its refs are gone too); the next mutation
      // needs a snapshot or screenshot first. Anything else that moved the
      // generation mid-action was the human or an unasked-for navigation:
      // say so rather than hand back a result that implies the page held.
      const navigational = name === "browser_navigate" || name === "browser_navigate_back" || name === "browser_tabs" || name === "browser_resize";
      if (tab.interruptedAt !== undefined) {
        return errorResult(new Error(`${textOfResult(outcome)} ${humanActiveOn(tab, index())}`));
      }
      if (!navigational && tab.generation !== generationAtStart) {
        return errorResult(new Error(`${textOfResult(outcome)} ${staleView(tab, index(), tab.staleReason || "it changed")}`));
      }
      return outcome;
    } finally {
      tab.agentBusy = Math.max(0, tab.agentBusy - 1);
      this.lastAgentInputAt.set(scope, this.now());
      if (this.tabs.includes(tab)) this.journalControl(tab, this.humanActive(tab) ? "human" : "idle");
    }
  }

  /** One tool call against the host, timed, counted, and turned into a result.
   *  `pinned` is the tab a mutation was queued against: page mutations act on
   *  IT, never on "whatever is active now" — a tab switch during the wait
   *  must not redirect a click. */
  async dispatch(scope, name, args, action = null) {
    const pinned = action ? action.tab : null;
    // A mutation acts on the tab it was queued for, by identity. If that tab
    // is gone the action is over — never redirected to whatever is active.
    const target = async () => {
      if (!pinned) return this.wakeTab(this.tabFor(scope, args));
      if (!this.tabs.includes(pinned)) throw new Error("The tab this action was queued for was closed.");
      return this.wakeTab(pinned);
    };
    this.activeToolCalls.set(scope, (this.activeToolCalls.get(scope) || 0) + 1);
    let timeoutId;
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        // The operation may still be running; from here its next checkpoint
        // stops it, so a successor on this tab never shares the page with it.
        if (action) action.cancelled = true;
        reject(new Error(`Browser action ${name} timed out.`));
      }, this.rpcTimeoutMs);
    });
    const operation = (async () => {
      switch (name) {
        case "browser_tabs":
          if (args.action === "list") return this.listTabs(scope);
          if (args.action === "new") { if (isProtectedUrl(args.url)) throw new Error("Browser tools cannot open extension pages."); await this.createTab(scope, args.url || "about:blank", "agent"); return this.listTabs(scope); }
          // SELECT IS THE AGENT TAKING A TAB, not moving your screen.
          if (args.action === "select") { await this.focusAgentTab(scope, args.index); return this.listTabs(scope); }
          if (args.action === "close") { this.closeTabRef(pinned || (args.index === undefined ? this.agentTab(scope) : this.tabAt(scope, args.index)), "agent"); return this.listTabs(scope); }
          throw new Error("Unknown browser_tabs action.");
        case "browser_navigate": {
          if (isProtectedUrl(args.url)) throw new Error("Browser tools cannot open extension pages.");
          const tab = pinned && this.tabs.includes(pinned) ? pinned : this.scopeTabs(scope).length ? this.tabFor(scope, args) : await this.createTab(scope);
          await this.navigateTab(tab, args.url);
          return okText(`Navigated to ${tab.view.webContents.getURL()}.`);
        }
        case "browser_navigate_back": await this.goBack(await target()); return okText("Navigated back.");
        case "browser_snapshot": return this.snapshot(await this.wakeTab(this.tabFor(scope, args)), args);
        case "browser_click": return this.click(await target(), args, action);
        case "browser_type": return this.type(await target(), args, action);
        case "browser_fill_form": return this.fillForm(await target(), args, action);
        case "browser_select_option": return this.selectOption(await target(), args, action);
        case "browser_press_key": return this.press(await target(), args, action);
        case "browser_hover": {
          const tab = await target();
          const point = await this.targetPoint(tab, args.target);
          await this.showAgentCursor(tab, point, "move");
          const debug = await this.ensureDebugger(tab);
          this.stampAgentInput(tab);
          const native = this.inputPoint(tab, point);
          await debug.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x: native.x, y: native.y });
          return okText(`Hovered ${args.element || args.target}.`);
        }
        case "browser_resize": {
          const tab = await target();
          const size = await this.resizeTab(tab, args);
          const mode = this.viewportModeOf(tab) === "fit" ? " (fit to panel — follows the panel while shown)" : presetOf(size) ? ` (${presetOf(size)})` : "";
          return okText(`Resized the viewport to ${size.width}×${size.height}${mode}. Take a fresh snapshot before acting on the page.`);
        }
        case "browser_take_screenshot": return this.screenshot(await this.wakeTab(this.tabFor(scope, args)), args);
        case "browser_console_messages": {
          const tab = await this.wakeTab(this.tabFor(scope, args));
          await this.ensureDebugger(tab);
          return okText(renderConsole(tab.console, { level: args.level, all: args.all === true }));
        }
        case "browser_network_requests": {
          const tab = await this.wakeTab(this.tabFor(scope, args));
          await this.ensureDebugger(tab);
          return okText(renderNetwork(tab.network, { filter: args.filter }));
        }
        default: throw new Error(`Unsupported desktop browser tool: ${name}.`);
      }
    })();
    try {
      return await Promise.race([operation, timeout]);
    } catch (error) {
      return errorResult(error);
    } finally {
      clearTimeout(timeoutId);
      const remaining = Math.max(0, (this.activeToolCalls.get(scope) || 1) - 1);
      if (remaining) this.activeToolCalls.set(scope, remaining);
      else this.activeToolCalls.delete(scope);
      for (const tab of this.scopeTabs(scope)) this.finishDeferredHibernate(tab);
    }
  }

  /**
   * EVERYTHING KEYED BY A SCOPE, FORGOTTEN TOGETHER (issue #296).
   *
   * Nine maps are keyed by scope, and a scope that ended used to leave entries
   * in six of them: its profile, its project, its profile override, its last
   * published bounds and its last agent-input moment stayed for the life of the
   * process. Each leftover costs more than its own bytes — `emitAllStates`
   * iterates `scopeProfiles`, so every dead scope is one more full state
   * serialisation and IPC push on a profile rename.
   *
   * Called only where the scope is genuinely over (a destroying release, an
   * adoption's source): a scope that still has tabs keeps everything.
   */
  forgetScope(scopeKey) {
    const scope = this.requireScope(scopeKey);
    this.scopeProfiles.delete(scope);
    this.scopeProjects.delete(scope);
    this.scopeProfileOverrides.delete(scope);
    this.boundsByScope.delete(scope);
    this.radiusByScope.delete(scope);
    this.lastAgentInputAt.delete(scope);
    this.activeToolCalls.delete(scope);
    this.activeTabIds.delete(scope);
    this.agentTabIds.delete(scope);
    this.agentTabClosed.delete(scope);
  }

  releaseScope(scopeKey, destroy = false) {
    const scope = this.requireScope(scopeKey);
    const scoped = this.scopeTabs(scope);
    // BEFORE the hibernate/remove pass empties the list: a destroyed scope's
    // tabs belong to nobody, and the idle transitions must still journal.
    if (destroy) {
      for (const tab of scoped) this.journalControl(tab, "idle");
    }
    for (const tab of scoped) this.requestHibernate(tab, destroy);
    if (this.visibleScopeKey === scope) this.visibleScopeKey = null;
    this.applyVisibility();
    // The agent's pointers go with the scope. A tombstone left here would be
    // reported to whatever session next used the id — an error about a tab
    // belonging to a conversation that is over. And so does everything else
    // keyed by it: see `forgetScope`.
    if (destroy && !this.scopeTabs(scope).length) this.forgetScope(scope);
    this.emitState(scope);
  }

  adoptScope(fromScopeKey, toScopeKey) {
    const from = this.requireScope(fromScopeKey);
    const to = this.requireScope(toScopeKey);
    if (from === to) return this.state(to);
    const sourceTabs = this.scopeTabs(from);
    if (sourceTabs.length && this.scopeTabs(to).length) {
      throw new Error("Cannot merge two browser session scopes.");
    }
    // Tabs carry their partition; a scope may only adopt tabs of ITS profile,
    // otherwise a draft's cookie jar would follow it into another project. A
    // target that is not bound yet INHERITS the source's profile (the common
    // case: a fresh session scope adopting a draft's tabs).
    const fromProject = this.profileOf(from);
    const toProject = this.profileOf(to);
    if (toProject) {
      const targetPartition = this.partitionOf(to);
      if (sourceTabs.some((tab) => tab.partition !== targetPartition)) {
        throw new Error("Cannot adopt tabs across browser profiles (different projects).");
      }
    } else if (fromProject) {
      this.scopeProjects.set(to, fromProject);
      const profileId = this.scopeProfiles.get(from);
      if (profileId) this.scopeProfiles.set(to, profileId);
      const override = this.scopeProfileOverrides.get(from);
      if (override) this.scopeProfileOverrides.set(to, override);
    }
    const sourceActiveId = this.activeTabIds.get(from) ?? null;
    // The agent's focus travels with the tabs, exactly as the human's view
    // does: a draft adopted into a real session must not lose track of the tab
    // its agent was working in.
    const sourceAgentId = this.agentTabIds.get(from) ?? null;
    for (const tab of sourceTabs) tab.scopeKey = to;
    if (sourceTabs.length) {
      this.activeTabIds.set(to, sourceActiveId);
      if (sourceAgentId) this.agentTabIds.set(to, sourceAgentId);
    }
    // The source scope is over: its tabs are the target's now, and everything
    // keyed by it goes — its profile binding included, which used to stay
    // behind and keep the dead scope in `emitAllStates`' loop for good.
    this.forgetScope(from);
    if (this.visibleScopeKey === from) this.visibleScopeKey = to;
    this.applyVisibility();
    this.emitState(from);
    this.emitState(to);
    return this.state(to);
  }

  /**
   * WHAT THE MAIN PROCESS IS HOLDING RIGHT NOW — issue #296's heap log.
   *
   * COUNTS ONLY. This line lands in shell.log, which is read by whoever is
   * debugging and must never become a browsing history: no URL, no title, no
   * console text, no scope key. Every number here is a thing that GROWS, so a
   * minute-by-minute series names the one that ran away without a snapshot.
   *
   * `wcListeners` is the figure the issue asks for: every live WebContents'
   * own listeners plus its debugger's, summed. A tab recreated or re-pointed
   * without its old registrations coming off shows up here as a count that
   * climbs while `liveViews` does not.
   */
  diagnostics() {
    const countListeners = (emitter) => {
      if (!emitter || typeof emitter.eventNames !== "function" || typeof emitter.listenerCount !== "function") return 0;
      let total = 0;
      for (const event of emitter.eventNames()) total += emitter.listenerCount(event);
      return total;
    };
    let liveViews = 0;
    let wcListeners = 0;
    let consoleEntries = 0;
    let networkEntries = 0;
    let expectedReports = 0;
    let refs = 0;
    for (const tab of this.tabs) {
      consoleEntries += tab.console.length;
      networkEntries += tab.network.length;
      expectedReports += tab.expectedReports.length;
      refs += tab.refs.size;
      const wc = tab.view && !tab.view.webContents.isDestroyed?.() ? tab.view.webContents : null;
      if (!wc) continue;
      liveViews += 1;
      wcListeners += countListeners(wc) + countListeners(wc.debugger);
    }
    return {
      scopes: new Set([...this.tabs.map((tab) => tab.scopeKey), ...this.scopeProfiles.keys()]).size,
      tabs: this.tabs.length,
      liveViews,
      wcListeners,
      extensionHosts: this.extensionHosts.size,
      consoleEntries,
      networkEntries,
      expectedReports,
      refs,
      // Every scope-keyed map together: a scope that ends should take its
      // entries with it, so this tracking `scopes` is the invariant.
      scopeEntries:
        this.scopeProfiles.size +
        this.scopeProjects.size +
        this.scopeProfileOverrides.size +
        this.boundsByScope.size +
        this.radiusByScope.size +
        this.lastAgentInputAt.size +
        this.activeToolCalls.size +
        this.activeTabIds.size +
        this.agentTabIds.size +
        this.agentTabClosed.size,
      pendingPopups: this.pendingPopupTabs.size,
      uiHolds: this.uiHolds.size,
    };
  }

  destroy() {
    // The inventory is written BEFORE the tabs go, synchronously: this runs
    // on window close / quit, where an async write would be cut off. The
    // live views' current URLs are what is remembered.
    if (this.tabStore && !this._disposed) this.tabStore.flushSync(this.inventory());
    // Stop the auto-release loop: its next poll sees this and exits.
    this._disposed = true;
    // Nothing outlives the window that was asking: every open question is
    // settled as Block rather than left holding a page for a minute.
    this.permissionPrompts.dispose();
    for (const tab of [...this.tabs]) {
      this.hibernateTab(tab);
    }
    this.tabs = [];
    this.activeTabIds.clear();
    this.agentTabIds.clear();
    this.agentTabClosed.clear();
    this.boundsByScope.clear();
    this.radiusByScope.clear();
    this.lastAgentInputAt.clear();
    this.activeToolCalls.clear();
    // The hosts hold a partition session's listener and a module-level
    // registration, both of which outlive this manager — a translucency
    // rebuild makes a new manager against the very same sessions (#296).
    for (const host of this.extensionHosts.values()) {
      try {
        host.dispose?.();
      } catch {
        // A host that cannot let go must not stop the window from closing.
      }
    }
    this.extensionHosts.clear();
    this.visibleScopeKey = null;
  }
}

/**
 * WHAT A WINDOW'S CLAIM ON A SESSION'S BROWSER IS WORTH, strongest first —
 * see `DesktopBrowserManager.scopeClaim`.
 */
const SCOPE_CLAIM = { visible: 3, panel: 2, pages: 1 };
/** An exact scope outranks ANY claim on a sibling instance of the same
 *  session: `S` is a scope of its own, not a stand-in for `S#2`. */
const EXACT_SCOPE_CLAIM = 10;

/**
 * THE WINDOW A SESSION'S BROWSER LIVES IN (issue #311) — what the agent-facing
 * control server resolves per request, where there is no sender to resolve
 * from.
 *
 * The surest claim wins (`scopeClaim`). The fallback — the window the human is
 * in — takes every tie, including the tie of nobody claiming anything at all,
 * so a session whose panel has never been mounted still opens its first page
 * where the person is, exactly as it did before there were two windows.
 *
 * @param {Iterable<DesktopBrowserManager>} managers - every live window's host.
 * @param {string | null | undefined} scopeKey - the scope the agent named.
 * @param {DesktopBrowserManager | null} fallback - the focused window's host.
 */
function managerForScope(managers, scopeKey, fallback = null) {
  let best = fallback;
  let claim = fallback ? fallback.scopeClaim(scopeKey) : 0;
  for (const manager of managers || []) {
    const next = manager.scopeClaim(scopeKey);
    if (next > claim) {
      best = manager;
      claim = next;
    }
  }
  return best;
}

module.exports = { DesktopBrowserManager, managerForScope, createExternalLinkPolicy, externalOpenTarget, normalizeUrl, looksLikeAddress, SEARCH_URL, TAB_SELECT_CHORDS, resolveViewport, fitViewport, zoomStep, DEFAULT_VIEWPORT, VIEWPORT_PRESETS, ZOOM_STEPS, renderSnapshot, renderConsole, renderNetwork, MAX_LOG_ITEMS, MAX_LOG_TEXT };
