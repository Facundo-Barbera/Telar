import { z } from "zod";
import { VIEWPORT_PRESET_KEYS } from "../../../../desktop/src/browser/viewport-presets.js";

const McpTextContent = z.object({ type: z.literal("text"), text: z.string() });
type McpTextContent = z.infer<typeof McpTextContent>;

const McpImageContent = z.object({
  type: z.literal("image"),
  data: z.string(),
  mimeType: z.string().min(1).optional(),
});
type McpImageContent = z.infer<typeof McpImageContent>;

const McpUnknownContent = z
  .looseObject({ type: z.string().min(1) })
  .refine((block) => block.type !== "text" && block.type !== "image", {
    message: "malformed text/image content block",
  });
type McpUnknownContent = z.infer<typeof McpUnknownContent>;

const McpContentBlock = z.union([McpTextContent, McpImageContent, McpUnknownContent]);
type McpContentBlock = z.infer<typeof McpContentBlock>;

export const BrowserToolResult = z.object({
  content: z.array(McpContentBlock).default([]),
  isError: z.boolean().optional(),
});
export type BrowserToolResult = z.infer<typeof BrowserToolResult>;

const BrowserToolName = z.enum([
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
  "browser_drag",
  "browser_paste",
  "browser_copy",
]);

export const BROWSER_DEFAULT_VIEWPORT = { width: 1280, height: 800 } as const;
type BrowserToolName = z.infer<typeof BrowserToolName>;

export type BrowserToolDefinition = {
  name: BrowserToolName;
  description: string;
  input: z.ZodObject;
};

export const BROWSER_DESCRIPTION_MAX_BYTES = 350;

const EMPTY = z.object({});

const targeted = {
  target: z.string().min(1),
  element: z.string().optional(),
};

const tabId = {
  tabId: z.number().int().nonnegative().optional(),
};

const point = {
  target: z.string().min(1).optional(),
  element: z.string().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
};
const ONE_OF_TARGET_OR_POINT = {
  message: "pass a target from browser_snapshot, or both x and y from a screenshot — not both",
};
function targetOrPoint(input: { target?: string; x?: number; y?: number }): boolean {
  const hasPoint = input.x !== undefined || input.y !== undefined;
  if (input.target !== undefined) return !hasPoint;
  return input.x !== undefined && input.y !== undefined;
}

export const BROWSER_TOOLS: readonly BrowserToolDefinition[] = [
  {
    name: "browser_list_tabs",
    description:
      "List the tabs open in Telar's integrated browser, changing none. (current) marks the tab the human is looking at, \"yours\" the one your calls act on — often different, which is how you work in the background. Use it when the user refers to a visible page, and to pick a tabId.",
    input: EMPTY,
  },
  {
    name: "browser_tabs",
    description:
      "Open, close, or move to a tab in Telar's integrated browser. \"new\" opens one and moves you into it, \"select\" moves you to an existing one; neither changes what the human is looking at. List tabs first when more than one is open.",
    input: z.object({
      action: z.enum(["list", "new", "close", "select"]),
      index: z.number().int().nonnegative().optional(),
      url: z.string().optional(),
    }),
  },
  {
    name: "browser_navigate",
    description:
      "Navigate to an http or https URL, in the tab you are working in or the tabId you name. Does not change what the human is looking at. file:// URLs work only inside this session's checkout. To put a file IN FRONT of the human rather than browse it yourself, use display_open.",
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
      "Read the accessibility snapshot of the tab you are working in, or the tabId you name. Use its exact target refs for interactions. The answer is capped at 16 KB: on a large page pass target (a ref from the last snapshot) to read one region, or depth to stop at a level.",
    input: z.object({
      target: z.string().optional(),
      depth: z.number().int().nonnegative().optional(),
      boxes: z.boolean().optional(),
      ...tabId,
    }),
  },
  {
    name: "browser_click",
    description:
      "Click by target from browser_snapshot, or at x,y in browser_take_screenshot's CSS pixels where the snapshot has no ref (a canvas-drawn page). In your tab or the tabId you name.",
    input: z
      .object({
        ...point,
        ...tabId,
        doubleClick: z.boolean().optional(),
        button: z.enum(["left", "right", "middle"]).optional(),
      })
      .refine(targetOrPoint, ONE_OF_TARGET_OR_POINT),
  },
  {
    name: "browser_type",
    description:
      "Type into an editable element by target or, with no target, into whatever has focus (say a cell you just clicked by x,y). In your tab or the tabId you name.",
    input: z.object({
      target: z.string().min(1).optional(),
      element: z.string().optional(),
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
    description:
      "Press a key or a chord (Enter, Control+A, Meta+V, Shift+Tab), in the tab you are working in or the tabId you name.",
    input: z.object({ key: z.string().min(1), ...tabId }),
  },
  {
    name: "browser_hover",
    description:
      "Move Telar's visible agent cursor over a target, or to x,y in screenshot CSS pixels where there is no ref. In your tab or the tabId you name.",
    input: z.object({ ...point, ...tabId }).refine(targetOrPoint, ONE_OF_TARGET_OR_POINT),
  },
  {
    name: "browser_drag",
    description:
      "Drag with the left button from x,y to toX,toY in screenshot CSS pixels — to select cells or move a shape on a canvas-drawn page. In your tab or the tabId you name.",
    input: z.object({ x: z.number(), y: z.number(), toX: z.number(), toY: z.number(), ...tabId }),
  },
  {
    name: "browser_resize",
    description:
      "Set the size the page lays out for in your tab or the tabId you name. width and/or height test a breakpoint (one alone keeps the other); or a preset: phones, tablets, desktop (default 1280×800), foldables. orientation turns it. mode \"fit\" follows the human's panel, \"fixed\" stops. Snapshot again after.",
    input: z
      .object({
        width: z.number().int().min(200).max(5000).optional(),
        height: z.number().int().min(200).max(5000).optional(),
        preset: z.enum(VIEWPORT_PRESET_KEYS).optional(),
        orientation: z.enum(["portrait", "landscape"]).optional(),
        mode: z.enum(["fixed", "fit"]).optional(),
        ...tabId,
      })
      .refine(
        (input) => input.width !== undefined || input.height !== undefined || input.preset !== undefined || input.orientation !== undefined || input.mode !== undefined,
        { message: "pass a width or height, a preset, an orientation, or a mode" },
      ),
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
    description:
      "Read console messages from the tab you are working in, or the tabId you name. level is a floor and defaults to info; pass all for the quieter ones too. The answer is capped at 6 KB and the newest lines are the ones kept — raise level to see further back. Also lists downloads and their paths.",
    input: z.object({
      level: z.enum(["error", "warning", "info", "debug"]).default("info"),
      all: z.boolean().optional(),
      ...tabId,
    }),
  },
  {
    name: "browser_network_requests",
    description:
      "Read network requests from the tab you are working in, or the tabId you name. The answer is capped at 6 KB and the newest rows are the ones kept — pass filter, a substring of the URL, to ask about one endpoint rather than the whole page.",
    input: z.object({
      static: z.boolean().default(false),
      filter: z.string().optional(),
      ...tabId,
    }),
  },
  {
    name: "browser_fill_secret",
    description:
      "Fill login fields from the user's 1Password without ever seeing the values. Pass snapshot refs and say what each field is (username/password/otp); a human approves and picks the item, and the secret never enters this conversation. Use this rather than asking them to paste a password.",
    input: z.object({
      fields: z
        .array(
          z.object({
            ...targeted,
            kind: z.enum(["username", "password", "otp", "field"]),
            label: z.string().optional(),
          }),
        )
        .min(1),
      item: z.string().optional(),
      submit: z.object({ ...targeted }).optional(),
    }),
  },
  {
    name: "browser_paste",
    description:
      "Paste text into what has focus as a real paste does, never touching the clipboard. Tab-separated rows fill many spreadsheet cells at once. In your tab or the tabId you name.",
    input: z.object({ text: z.string().min(1), ...tabId }),
  },
  {
    name: "browser_copy",
    description:
      "Read what a copy would take — the page's copy text, else the selection — never touching the clipboard; reads cells selected on a canvas-drawn page. In your tab or the tabId you name.",
    input: z.object({ ...tabId }),
  },
];

const BY_NAME = new Map<string, BrowserToolDefinition>(BROWSER_TOOLS.map((tool) => [tool.name, tool]));

function browserToolDefinition(name: string): BrowserToolDefinition | null {
  return BY_NAME.get(name) ?? null;
}

export const BROWSER_TOOL_NAMES: ReadonlySet<string> = new Set(BrowserToolName.options);

export class BrowserToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserToolInputError";
  }
}

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
