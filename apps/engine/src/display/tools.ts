/**
 * THE DISPLAY TOOLKIT — the agent showing the human something, on purpose.
 *
 * One verb. `display_open` names a file in the session's own checkout and the
 * cockpit opens it in the right panel with the viewer its kind earns: markdown
 * rendered, a PDF paged, an image or video played, code highlighted. It is the
 * counterpart of the browser's "you get your own tab in the background" rule —
 * this tool exists precisely for the moment the agent WANTS the foreground:
 * a guide it just wrote, a report it finished, a plot it rendered to disk.
 *
 * WHAT IT DELIBERATELY IS NOT:
 *   - Not a read. The tool never returns the file's content; the agent already
 *     has file tools for reading. The cockpit reads the bytes itself, through
 *     the same fenced routes every panel surface uses.
 *   - Not a browser. A URL belongs in `browser_tabs new`; this takes a path.
 *   - Not gated. Showing a person a file they could open themselves changes
 *     nothing and risks nothing, the same judgement every other wall's verbs got.
 *
 * The capability is the seam (tool-kit.ts): the WORKER implements `open` —
 * fence the path inside the turn's checkout, confirm it exists, report a
 * `display.opened` observation the engine journals — so this file stays free
 * of both the SDK and the filesystem, and a unit test drives it with a fake.
 */
import { z } from "zod";
import { err, failure, ok, type ToolFactory } from "../tool-kit";

export type DisplayCapability = {
  /**
   * Validate the path against the session's checkout and journal the gesture.
   * Resolves with the workspace-relative path it verified; rejects with a
   * sentence when the file is missing, outside the checkout, or a directory.
   */
  open(input: { path: string; title?: string }): Promise<{ path: string }>;
};

/**
 * UNDER 350 CHARACTERS, ENFORCED BY A TEST (#515). This string is in every turn
 * of every session whether or not a file is ever shown, so the examples and the
 * rationale that used to live here — which file kinds render how, why the
 * foreground is deliberate — moved to the `telar` skill, which is on disk and
 * costs nothing until something asks for it. What stays is what a model needs
 * to CHOOSE: what it does, what it is for, and the one restraint on it.
 */
const OPEN = `Show the human one file from this session's checkout in the cockpit's right panel, rendered rather than as source: markdown formatted, PDFs paged, images and video shown, code highlighted. For something you produced FOR them to look at now, not a file you are working on. Path is relative to the checkout root, and it takes the foreground.`;

export function displayTools(tool: ToolFactory, capability: DisplayCapability): unknown[] {
  return [
    tool(
      "display_open",
      OPEN,
      {
        path: z.string().min(1).describe("The file to show, relative to the session's checkout root."),
        title: z.string().max(200).optional().describe("What to call it — shown to the human beside the file."),
      },
      async (args) => {
        const path = typeof args.path === "string" ? args.path.trim() : "";
        if (!path) return err("Name the file to show (path, relative to the checkout root).");
        const title = typeof args.title === "string" && args.title.trim() ? args.title.trim() : undefined;
        try {
          const opened = await capability.open({ path, ...(title ? { title } : {}) });
          return ok(
            `Opened ${opened.path} in the right panel${title ? ` as "${title}"` : ""}. The human is looking at the rendered file, not its source; nothing further is needed unless you want to walk them through it.`,
          );
        } catch (error) {
          return err(`Could not display "${path}": ${failure(error)}`);
        }
      },
    ),
  ];
}
