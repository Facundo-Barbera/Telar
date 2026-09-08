/**
 * The pure part of the browser runtime: name mapping, tab parsing, and error
 * normalization. Nothing here spawns, awaits, or holds state, which is why it
 * is the part that carries real tests.
 *
 * Ported from `apps/web_old/lib/server/browser-runtime.ts` and
 * `apps/web_old/lib/browser-mcp.ts`.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BROWSER_TOOL_NAMES, BROWSER_VIEWPORT_PRESETS, type BrowserToolResult, type BrowserViewportPreset } from "./tools";

/** One tab as Playwright MCP reports it. `index` IS the handle — the MCP tab
 *  tools address tabs positionally, so there is no stable id to carry. */
export type BrowserTabInfo = {
  index: number;
  title: string;
  url: string;
  /** The tab the HUMAN is looking at. */
  active: boolean;
  /** The tab the AGENT's un-addressed calls act on. Often not the same tab —
   *  that is what lets an agent work in the background — so anything asking
   *  "which page am I on" must mean this one, not `active`. Absent from hosts
   *  that do not report it (the headless runtime has no human to differ from). */
  agentFocus?: boolean;
  /**
   * The named browser profile THIS TAB is signed into — not the session's
   * next-tab default, which is a different thing the moment a person switches
   * profiles with tabs open. Absent from a host with no named profiles, and
   * absent means UNKNOWN: the credential path asks a human rather than
   * assuming an identity.
   */
  profileId?: string;
  profileLabel?: string;
};

/**
 * Tools that change the page. Used for permission classification, and the
 * reason the engine can auto-run a snapshot in a detached session while still
 * parking a click.
 *
 * `browser_tabs` IS IN HERE EVEN THOUGH ITS `list` ARM IS READ-ONLY. The tool is
 * overloaded — one name, four verbs — and classifying by name alone would have
 * to pick a side. Defaulting an overloaded tool to "mutating" and special-casing
 * the safe arm is the direction that fails closed.
 */
export const MUTATING_TOOLS: ReadonlySet<string> = new Set([
  "browser_navigate",
  "browser_navigate_back",
  "browser_click",
  "browser_type",
  "browser_fill_form",
  "browser_press_key",
  "browser_hover",
  "browser_select_option",
  "browser_tabs",
  // Reflows the page: every snapshot before it is stale.
  "browser_resize",
  // Not merely mutating: it also opens a `secret_access` request. Listed here
  // so nothing can ever classify it as an auto-acceptable read.
  "browser_fill_secret",
]);

/**
 * `browser_list_tabs` is Telar's own alias, not a Playwright MCP tool.
 *
 * IT EXISTS BECAUSE OVERLOADED TOOLS ARE UNAPPROVABLE. Playwright's
 * `browser_tabs` takes an `action` that ranges from "list" to "close", so a
 * model that just wants to see what is open has to call a tool whose name says
 * it might close something — and a permission prompt for it cannot honestly say
 * what will happen. The alias gives the read-only intent its own name, and this
 * function is where it turns back into the call the browser understands.
 */
export function normalizeBrowserToolCall(
  name: string,
  args: Record<string, unknown>,
): { name: string; args: Record<string, unknown> } {
  if (name === "browser_list_tabs") return { name: "browser_tabs", args: { action: "list" } };
  // A preset is Telar's own vocabulary; the browsers (desktop host and
  // Playwright's `browser_resize`) take numbers.
  if (name === "browser_resize") {
    if (typeof args.preset === "string") {
      const preset = BROWSER_VIEWPORT_PRESETS[args.preset as BrowserViewportPreset];
      if (preset) return { name, args: { width: preset.width, height: preset.height } };
    }
    // A bare mode has no numbers for the headless browser (which has no panel
    // to fit): "fit"/"fixed" there mean the standard size. The desktop host
    // takes the mode itself — the desktop path does not go through here.
    if (typeof args.mode === "string" && args.width === undefined && args.height === undefined) {
      return { name, args: { width: BROWSER_VIEWPORT_PRESETS.default.width, height: BROWSER_VIEWPORT_PRESETS.default.height } };
    }
  }
  return { name, args };
}

/**
 * Whether a call only observes the page.
 *
 * DERIVED FROM ONE LIST, not two. The legacy code kept a `MUTATING_TOOLS` set
 * next to a separate `BROWSER_READ_TOOLS` allowlist that had to stay an exact
 * complement of it by hand; adding a tool to the schema and to only one of them
 * silently mis-permissions it. Here the read set is "a tool the engine defines
 * that is not mutating", so a tool can only be forgotten in one place.
 *
 * An UNKNOWN name is not read-only. Unknown means the engine does not define
 * the tool, and the safe answer about a capability you cannot describe is no.
 */
export function isReadOnlyBrowserCall(name: string, args: Record<string, unknown> = {}): boolean {
  const call = normalizeBrowserToolCall(name, args);
  if (call.name === "browser_tabs") return call.args.action === "list";
  return BROWSER_TOOL_NAMES.has(call.name) && !MUTATING_TOOLS.has(call.name);
}

/**
 * The `file:` fence: why a call carrying a file URL may not proceed, or null.
 *
 * A BROWSER READING A LOCAL FILE IS A FILE READ WEARING NAVIGATION'S CLOTHES.
 * Navigation is classified read-only-adjacent enough that the mode ladder
 * auto-accepts much of it, so an unfenced `file:` navigate would let an agent
 * read `~/.ssh/id_ed25519` by screenshotting it — a walk straight past the
 * file-read gate. The fence is the same one every other read has: the
 * session's own checkout, and nothing else. No workspace bound (a test, an
 * older worker) means no file URLs at all — the direction that fails closed.
 *
 * Checked HERE, at the socket, because both backends sit behind it: the
 * headless runtime would happily `page.goto("file:...")` and the desktop host
 * now accepts `file:` for the human's own address bar.
 */
export function fileUrlViolation(name: string, args: Record<string, unknown>, workspaceRoot?: string): string | null {
  const raw =
    name === "browser_navigate" || (name === "browser_tabs" && args.action === "new")
      ? args.url
      : undefined;
  if (typeof raw !== "string") return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null; // Not this fence's question — the schema or the browser answers it.
  }
  if (parsed.protocol !== "file:") return null;
  if (!workspaceRoot) return "The integrated browser cannot open file URLs in this session.";
  let target: string;
  try {
    target = fileURLToPath(parsed);
  } catch {
    return "That file URL does not name a local path this machine can read.";
  }
  const resolved = path.resolve(target);
  const prefix = workspaceRoot.endsWith(path.sep) ? workspaceRoot : `${workspaceRoot}${path.sep}`;
  if (!resolved.startsWith(prefix)) {
    return `The integrated browser opens local files only inside this session's checkout (${workspaceRoot}).`;
  }
  return null;
}

/**
 * Strip the framing Playwright MCP wraps failures in, so the reason can be put
 * in a session journal or an error event without a stray "### Error" heading.
 */
export function browserErrorText(value: unknown): string {
  return String(value)
    .replace(/^\s*#{1,6}\s*Error\s*/i, "")
    .replace(/^\s*Error:\s*/i, "")
    .trim();
}

/**
 * Whether a failed browser call means "the binary was never downloaded".
 *
 * MATCHED ON TEXT BECAUSE THERE IS NOTHING ELSE. Playwright MCP reports this as
 * an ordinary `isError` tool result with prose in it — no code, no typed field —
 * so a substring match is the whole of the available signal. Kept deliberately
 * loose across the two phrasings it uses, and read-only: a false positive costs
 * one wasted install attempt, while a false negative leaves a detached session
 * permanently unable to browse with nobody around to run the installer.
 */
export function isBrowserNotInstalled(text: string): boolean {
  const lowered = text.toLowerCase();
  return (
    (lowered.includes("is not installed") || lowered.includes("install-browser") || lowered.includes("executable doesn't exist")) &&
    lowered.includes("brows")
  );
}

/**
 * The text blocks of a tool result, joined. Image blocks are skipped rather
 * than stringified — a base64 payload in an error message is a wall.
 *
 * The `typeof` guards are not defensive noise: `McpContentBlock` carries a
 * forward-compatibility arm for block types this engine does not model, so
 * narrowing on `type` alone leaves the payload statically `unknown`. Checking
 * it is what keeps `undefined` out of a session journal.
 */
export function textOf(result: BrowserToolResult): string {
  const chunks: string[] = [];
  for (const part of result.content) {
    if (part.type === "text" && typeof part.text === "string") chunks.push(part.text);
  }
  return chunks.join("\n");
}

/** The first image block as a data URL, or null. This is how a screenshot
 *  reaches a client: the runtime never writes screenshot files, because a
 *  detached session has nobody to clean them up. */
export function imageDataUrlOf(result: BrowserToolResult): string | null {
  for (const part of result.content) {
    if (part.type !== "image" || typeof part.data !== "string") continue;
    const mimeType = typeof part.mimeType === "string" && part.mimeType.length > 0 ? part.mimeType : "image/jpeg";
    return `data:${mimeType};base64,${part.data}`;
  }
  return null;
}

/**
 * Read the tab list out of `browser_tabs { action: "list" }` prose.
 *
 * THIS IS A PARSER OVER A HUMAN-READABLE RENDERING, which is unpleasant and
 * unavoidable: MCP tool results are text, and Playwright MCP has no structured
 * tab list. The regex is therefore deliberately STRICT — it only accepts the
 * shapes Playwright actually emits:
 *
 *   - 0: (current) [Page title](http://localhost:3000/)
 *   - 1: Some title - https://example.com          (older builds)
 *
 * The temptation is to loosen it until something matches. Do not: a loose
 * pattern picks URLs out of arbitrary prose, and then an error message
 * mentioning a link renders as a browser tab that does not exist.
 */
/** `profile=<id>, profile-label=<percent-encoded>` out of the host's per-tab
 *  metadata suffix. A malformed label costs the label, never the id. */
function profileFromMeta(meta: string): { profileId?: string; profileLabel?: string } {
  const id = /(?:^|,)\s*profile=([^,\s}]+)/i.exec(meta)?.[1];
  if (!id) return {};
  const rawLabel = /(?:^|,)\s*profile-label=([^,\s}]*)/i.exec(meta)?.[1];
  let label: string | undefined;
  if (rawLabel) {
    try {
      label = decodeURIComponent(rawLabel);
    } catch {
      label = undefined;
    }
  }
  return { profileId: id, ...(label ? { profileLabel: label } : {}) };
}

export function parseBrowserTabs(text: string): BrowserTabInfo[] {
  const tabs: BrowserTabInfo[] = [];
  for (const line of text.split("\n")) {
    const match = line.match(
      // The trailing `\{[^}]*\}?` arm tolerates the desktop host's per-tab
      // metadata suffix — `{controller=human, opened-by=agent, yours}` —
      // without loosening what counts as a tab line. It is CAPTURED rather
      // than merely tolerated now, because `yours` in there is the only signal
      // of which tab the agent's own calls land on.
      /^\s*[-*]?\s*(?:Tab\s+)?(\d+)\s*[:.]\s*(\((?:current|active)\)\s*)?(?:\[([^\]]*)\]\(([^)]+)\)|(.+?)\s+-\s+(https?:\/\/\S+|about:blank))\s*(\[(?:current|active)\]|\((?:current|active)\))?\s*(?:\[crashed\])?\s*(?:\{([^}]*)\})?\s*$/i,
    );
    if (!match) continue;
    const index = Number(match[1]);
    const title = (match[3] ?? match[5] ?? `Tab ${index + 1}`).trim();
    const url = (match[4] ?? match[6] ?? "about:blank").trim();
    const meta = match[8] ?? "";
    tabs.push({
      index,
      title: title.replace(/\s*\((?:current|active)\)\s*$/i, "") || `Tab ${index + 1}`,
      url,
      active: Boolean(match[2] || match[7]),
      ...(/(^|,)\s*yours\s*(,|$)/i.test(meta) ? { agentFocus: true } : {}),
      // The browser profile THIS TAB is signed into. Present only from a host
      // with named profiles; the credential path treats absent as "unknown"
      // and asks a human rather than assuming the session's default.
      ...profileFromMeta(meta),
    });
  }
  return tabs;
}
