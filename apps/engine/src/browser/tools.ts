/**
 * The agent-facing browser tool surface, and the result shape a call returns.
 *
 * PORTED FROM `apps/web_old/lib/browser-mcp.ts` WITH ITS SDK COUPLING CUT. The
 * legacy definitions were built with the Agent SDK's `tool()` helper and typed
 * their result as `Awaited<ReturnType<SdkMcpToolDefinition["handler"]>>`, which
 * made the browser — a thing that has nothing to do with Claude — unusable
 * without the Claude SDK loaded. The engine must be able to drive a page for a
 * Codex session, and a unit test must be able to assert on a tool result
 * without importing a provider. So the schemas are plain zod here and the
 * result is an engine-local MCP content shape.
 *
 * These schemas are the ENGINE's copy of the contract, not Playwright MCP's.
 * They are deliberately a narrower surface than `@playwright/mcp` exposes (no
 * `browser_evaluate`, no `browser_handle_dialog`, no file uploads): a tool the
 * engine does not define is a tool an agent cannot reach.
 */
import { z } from "zod";

// ── what a browser tool call returns ───────────────────────────────────────

export const McpTextContent = z.object({ type: z.literal("text"), text: z.string() });
export type McpTextContent = z.infer<typeof McpTextContent>;

/** `data` is base64. Playwright MCP only sends this when the runtime was
 *  launched with `--image-responses allow`, which `transport.ts` does. */
export const McpImageContent = z.object({
  type: z.literal("image"),
  data: z.string(),
  mimeType: z.string().min(1).optional(),
});
export type McpImageContent = z.infer<typeof McpImageContent>;

/**
 * Any content block MCP grows that this engine does not model yet (`resource`,
 * `audio`, …). Kept so a newer @playwright/mcp cannot make a whole result fail
 * to parse over one block nobody reads.
 *
 * THE REFINEMENT IS THE POINT. Without it this arm also swallows a MALFORMED
 * `text` block — `{ type: "text", text: 42 }` fails the text arm, falls through
 * to here, matches, and is silently accepted as an opaque block whose text
 * every caller then reads as `undefined`. A forward-compatibility escape hatch
 * must never be able to accept a shape we DO know and got wrong.
 */
export const McpUnknownContent = z
  .looseObject({ type: z.string().min(1) })
  .refine((block) => block.type !== "text" && block.type !== "image", {
    message: "malformed text/image content block",
  });
export type McpUnknownContent = z.infer<typeof McpUnknownContent>;

export const McpContentBlock = z.union([McpTextContent, McpImageContent, McpUnknownContent]);
export type McpContentBlock = z.infer<typeof McpContentBlock>;

/**
 * The `tools/call` result.
 *
 * `isError` IS NOT A TRANSPORT ERROR. MCP reports a tool that ran and failed
 * (bad selector, navigation refused) as a normal result with `isError: true`
 * and the reason in its text — a JSON-RPC `error` means the call never ran at
 * all. Conflating them is how "element not found" turns into "the browser
 * crashed" in a session journal.
 */
export const BrowserToolResult = z.object({
  content: z.array(McpContentBlock).default([]),
  isError: z.boolean().optional(),
});
export type BrowserToolResult = z.infer<typeof BrowserToolResult>;

// ── the tools ──────────────────────────────────────────────────────────────

export const BrowserToolName = z.enum([
  "browser_list_tabs",
  "browser_tabs",
  "browser_navigate",
  "browser_navigate_back",
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_fill_form",
  "browser_select_option",
  "browser_press_key",
  "browser_hover",
  "browser_resize",
  "browser_take_screenshot",
  "browser_console_messages",
  "browser_network_requests",
  "browser_fill_secret",
]);

/** Named viewport sizes `browser_resize {preset}` accepts. The desktop host
 *  keeps the same table (browser-manager.js VIEWPORT_PRESETS); resolved to
 *  numbers here so the headless runtime, which has no presets, gets a size. */
export const BROWSER_VIEWPORT_PRESETS = {
  default: { width: 1280, height: 800 },
  laptop: { width: 1440, height: 900 },
  tablet: { width: 768, height: 1024 },
  phone: { width: 390, height: 844 },
} as const;
export type BrowserViewportPreset = keyof typeof BROWSER_VIEWPORT_PRESETS;
export type BrowserToolName = z.infer<typeof BrowserToolName>;

export type BrowserToolDefinition = {
  name: BrowserToolName;
  /** Written for the model, not for a human reader. It is the only thing that
   *  tells an agent when this tool is the right one, so it names the situation
   *  rather than describing the parameters. */
  description: string;
  input: z.ZodObject;
};

const EMPTY = z.object({});

/**
 * `target` is a ref out of the most recent `browser_snapshot`, and `element` is
 * the human-readable description of the same node. Both are passed on every
 * interaction: Playwright MCP uses `element` for its own error messages, so a
 * failure reads "could not click the Save button" rather than "could not click
 * e17". It stays optional because a retry that has the ref and not the prose is
 * still worth letting through.
 */
const targeted = {
  target: z.string().min(1),
  element: z.string().optional(),
};

/**
 * WHICH TAB — accepted by reads AND by writes.
 *
 * It used to be reads only, on the rule "reads on a human-held tab are
 * allowed, writes never". That rule was protecting the wrong thing: what must
 * not happen is an agent typing into a page while a person is using it, and
 * that is enforced where it actually lives — the desktop host defers a write
 * while their hands are on that tab and refuses one decided from a view the
 * agent has not refreshed. Withholding the parameter did not add safety; it
 * only meant every write landed on one shared "current tab", so an agent could
 * not work in a background tab at all and a person switching tabs silently
 * re-aimed the agent's next click.
 *
 * Omitted means the tab the agent is working in, which is NOT necessarily the
 * one the human is looking at — `browser_list_tabs` marks both.
 */
const tabId = {
  tabId: z.number().int().nonnegative().optional(),
};

export const BROWSER_TOOLS: readonly BrowserToolDefinition[] = [
  {
    name: "browser_list_tabs",
    description:
      "List the tabs currently open in Telar's integrated browser without changing them. Each is marked (current) if it is the tab the human is looking at and \"yours\" if it is the one your calls act on — these are often different, which is how you can work in a background tab while they read something else. Use this first when the user refers to a visible page, and to pick a tabId.",
    input: EMPTY,
  },
  {
    name: "browser_tabs",
    description:
      "Open, close, or move to a tab in Telar's integrated browser. \"new\" opens a tab and moves you into it; \"select\" moves you to an existing one. Neither changes what the human is looking at — you get your own tab, in the background. List tabs before acting when more than one is open.",
    input: z.object({
      action: z.enum(["list", "new", "close", "select"]),
      // Tabs are addressed positionally by Playwright MCP, so a fractional or
      // negative index is not a near-miss — it is a different tab or none.
      index: z.number().int().nonnegative().optional(),
      url: z.string().optional(),
    }),
  },
  {
    name: "browser_navigate",
    description: "Navigate to an http or https URL — in the tab you are working in, or the tabId you name. Does not change what the human is looking at.",
    input: z.object({ url: z.url(), ...tabId }),
  },
  {
    name: "browser_navigate_back",
    description: "Go back in the tab you are working in.",
    input: z.object({ ...tabId }),
  },
  {
    name: "browser_snapshot",
    description:
      "Read the accessibility snapshot of the tab you are working in, or the tabId you name. Use its exact target refs for interactions.",
    input: z.object({
      target: z.string().optional(),
      depth: z.number().int().nonnegative().optional(),
      boxes: z.boolean().optional(),
      ...tabId,
    }),
  },
  {
    name: "browser_click",
    description: "Click an element using a target from browser_snapshot, in the tab you are working in or the tabId you name.",
    input: z.object({
      ...targeted,
      ...tabId,
      doubleClick: z.boolean().optional(),
      button: z.enum(["left", "right", "middle"]).optional(),
    }),
  },
  {
    name: "browser_type",
    description: "Type text into an editable element, in the tab you are working in or the tabId you name.",
    input: z.object({
      ...targeted,
      ...tabId,
      text: z.string(),
      submit: z.boolean().optional(),
      slowly: z.boolean().optional(),
    }),
  },
  {
    name: "browser_fill_form",
    description: "Fill several fields, in the tab you are working in or the tabId you name.",
    input: z.object({
      ...tabId,
      fields: z.array(
        z.object({
          ...targeted,
          name: z.string(),
          type: z.enum(["textbox", "checkbox", "radio", "combobox", "slider"]),
          value: z.string(),
        }),
      ),
    }),
  },
  {
    name: "browser_select_option",
    description: "Select values in a dropdown, in the tab you are working in or the tabId you name.",
    input: z.object({ ...targeted, ...tabId, values: z.array(z.string()) }),
  },
  {
    name: "browser_press_key",
    description: "Press a keyboard key, in the tab you are working in or the tabId you name.",
    input: z.object({ key: z.string().min(1), ...tabId }),
  },
  {
    name: "browser_hover",
    description: "Move Telar's visible agent cursor over an element, in the tab you are working in or the tabId you name.",
    input: z.object({ ...targeted, ...tabId }),
  },
  {
    name: "browser_resize",
    description:
      "Change the viewport of the tab you are working in (or the tabId you name) — the size the page lays out for, independent of how it is shown. Pass a preset (default 1280×800, laptop, tablet, phone), an explicit width and height, or mode \"fit\" to follow the size of the panel the human is looking at (mode \"fixed\" returns to a stable size). Take a fresh browser_snapshot afterwards.",
    input: z
      .object({
        preset: z.enum(["default", "laptop", "tablet", "phone"]).optional(),
        width: z.number().int().min(200).max(5000).optional(),
        height: z.number().int().min(200).max(5000).optional(),
        mode: z.enum(["fixed", "fit"]).optional(),
        ...tabId,
      })
      .refine((input) => input.preset !== undefined || input.mode !== undefined || (input.width !== undefined && input.height !== undefined), {
        message: "pass a preset, a mode, or both width and height",
      }),
  },
  {
    name: "browser_take_screenshot",
    description:
      "Capture the tab you are working in, or the tabId you name, for visual inspection. Use browser_snapshot for element targeting.",
    input: z.object({
      type: z.enum(["png", "jpeg"]).default("png"),
      fullPage: z.boolean().optional(),
      scale: z.enum(["css", "device"]).default("css"),
      ...tabId,
    }),
  },
  {
    name: "browser_console_messages",
    description: "Read console messages from the tab you are working in, or the tabId you name.",
    input: z.object({
      level: z.enum(["error", "warning", "info", "debug"]).default("info"),
      all: z.boolean().optional(),
      ...tabId,
    }),
  },
  {
    name: "browser_network_requests",
    description: "Read network requests from the tab you are working in, or the tabId you name.",
    input: z.object({
      static: z.boolean().default(false),
      filter: z.string().optional(),
      ...tabId,
    }),
  },
  {
    name: "browser_fill_secret",
    description:
      "Fill login fields on the current page from the user's 1Password, without ever seeing the values. Pass snapshot refs and say what each field is (username/password/otp); a human approves and picks the item, Telar fills it, and the secret never enters this conversation. Use this instead of asking the user to paste a password.",
    input: z.object({
      fields: z
        .array(
          z.object({
            ...targeted,
            kind: z.enum(["username", "password", "otp", "field"]),
            /** The 1Password field label, required in spirit when kind is
             *  "field" — enforced by the fill path, not the schema, so the
             *  error can say what to do. */
            label: z.string().optional(),
          }),
        )
        .min(1),
      /** Which item, as a hint (title). The human's pick on the approval card
       *  is what decides; a hint can only reorder the candidates. */
      item: z.string().optional(),
      /** Press this after filling — the login button's snapshot ref. */
      submit: z.object({ ...targeted }).optional(),
    }),
  },
];

const BY_NAME = new Map<string, BrowserToolDefinition>(BROWSER_TOOLS.map((tool) => [tool.name, tool]));

export function browserToolDefinition(name: string): BrowserToolDefinition | null {
  return BY_NAME.get(name) ?? null;
}

/** Every name the engine will forward to the browser. `isReadOnlyBrowserCall`
 *  derives from this, so an unlisted tool is unknown rather than assumed safe. */
export const BROWSER_TOOL_NAMES: ReadonlySet<string> = new Set(BrowserToolName.options);

export class BrowserToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserToolInputError";
  }
}

/**
 * Validate a tool call's arguments before they leave the engine.
 *
 * WORTH DOING EVEN THOUGH PLAYWRIGHT MCP VALIDATES TOO. A rejection here costs
 * nothing and names the field; a rejection over there costs a 30-second RPC
 * round trip through a browser process we may have just spawned, and comes back
 * as prose. It also applies the schema DEFAULTS (screenshot `type`, console
 * `level`) so the engine's journal records the arguments the browser actually
 * received rather than the ones the model happened to type.
 */
export function parseBrowserToolInput(name: string, input: unknown = {}): Record<string, unknown> {
  const definition = browserToolDefinition(name);
  if (!definition) throw new BrowserToolInputError(`Unknown browser tool: ${name}`);
  const parsed = definition.input.safeParse(input ?? {});
  if (parsed.success) return parsed.data;
  const detail = parsed.error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`)
    .join("; ");
  throw new BrowserToolInputError(`Invalid arguments for ${name} — ${detail}`);
}
