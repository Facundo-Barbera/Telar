/**
 * THE COMPOSED SURFACE — the agent draws, the browser watches.
 *
 * ── ORPHANED BY docs/spool-loops.md §13.6 ───────────────────────────────────
 * §13.6 redefined the Spool's front door: "the user navigates rooms
 * themselves; the agent no longer controls what the screen shows." This whole
 * file is the opposite premise — the agent composes the screen block by
 * block — and it predates that section. Nothing in `apps/web` calls
 * `/v2/spool/canvas` any more (checked at the time of the §13.6 tool-wall
 * pass), so this is dead code left dormant rather than deleted: the route in
 * `daemon.ts` and the state in `state.ts` still work, and reviving them was
 * out of scope for that pass. A caller reappearing here should be read as a
 * regression toward the pre-§13.6 model, not as this file being alive on
 * purpose.
 *
 * ── THE INVERSION ───────────────────────────────────────────────────────────
 * Everywhere else in this module a person wrote the layout and the agent filled
 * it. Here the agent composes, from a closed set of objects whose form is
 * already decided (`protocol/canvas.ts`). You ask "what have we got today" and
 * the screen is BUILT in front of you, block by block, because each draw takes
 * effect the moment the model calls it rather than when the pass ends.
 *
 * ── IN MEMORY, AND THAT IS THE POINT ────────────────────────────────────────
 * A canvas is a rendering, not a record — the same reasoning `work.ts` uses for
 * a pass in flight. Nothing here is durable, nothing here is a source of truth,
 * and the store it draws from is untouched by drawing. Restart the daemon and
 * the canvas is gone, which is correct: it is an answer to a question somebody
 * asked, and the question is gone too.
 *
 * ── THE ONE RULE THE DRAW TOOLS ENFORCE ─────────────────────────────────────
 * Same id twice REPLACES IN PLACE. Without it the model's only way to fix a
 * block is to clear and start over, and the surface would flicker through empty
 * on every correction. With it, refinement is a redraw — which is also how the
 * canvas updates when a background pass lands.
 */
import { z } from "zod";
import {
  SPOOL_CANVAS_SCHEMA_VERSION,
  SpoolCanvasBlock,
  type SpoolCanvasState,
} from "@telar/engine-client";
import type { SideTool } from "../agent.js";

/**
 * ONE CANVAS, because there is one screen looking at it.
 *
 * A registry keyed by session would be the general answer, and it would be
 * speculation: the Spool's front door is a single project-less surface, and the
 * thing being tested is whether an agent can compose a screen at all. When a
 * second canvas is needed, this becomes a Map and nothing else changes.
 */
export class SpoolCanvas {
  private blocks: SpoolCanvasBlock[] = [];
  private rev = 0;
  private status: SpoolCanvasState["status"] = "idle";
  private step: string | undefined;
  private say: string | undefined;
  private reason: string | undefined;

  read(): SpoolCanvasState {
    return {
      rev: this.rev,
      blocks: [...this.blocks],
      status: this.status,
      ...(this.step ? { step: this.step } : {}),
      ...(this.say ? { say: this.say } : {}),
      ...(this.reason ? { reason: this.reason } : {}),
      schemaVersion: SPOOL_CANVAS_SCHEMA_VERSION,
    };
  }

  /**
   * A NEW QUESTION DOES NOT BLANK THE SCREEN.
   *
   * The obvious move is to clear on every ask, and it is wrong: you would stare
   * at an empty page for the thirty seconds the model takes to draw the first
   * block, every single time. The old canvas stays up and is replaced as the new
   * blocks land — the model calls `clear_canvas` itself when what it is about to
   * draw genuinely supersedes what is there.
   */
  begin(): void {
    this.status = "building";
    this.step = undefined;
    this.say = undefined;
    this.reason = undefined;
    this.rev += 1;
  }

  settle(input: { ok: true; say?: string } | { ok: false; reason: string }): void {
    this.status = input.ok ? "done" : "failed";
    this.step = undefined;
    if (input.ok) this.say = input.say;
    else this.reason = input.reason;
    this.rev += 1;
  }

  progress(step: string): void {
    this.step = step;
    this.rev += 1;
  }

  clear(): void {
    this.blocks = [];
    this.rev += 1;
  }

  draw(block: SpoolCanvasBlock): void {
    const at = this.blocks.findIndex((b) => b.id === block.id);
    if (at === -1) this.blocks.push(block);
    else this.blocks[at] = block;
    this.rev += 1;
  }

  erase(id: string): boolean {
    const before = this.blocks.length;
    this.blocks = this.blocks.filter((b) => b.id !== id);
    if (this.blocks.length === before) return false;
    this.rev += 1;
    return true;
  }
}

/**
 * THE PEN — one tool per kind, and that is deliberate.
 *
 * A single `draw({kind, ...})` with a flat superset of every property would be
 * one schema instead of seven, and it would describe none of them: the model
 * would see thirteen optional fields with no indication which pair together. Per
 * kind, each tool's arguments ARE the object's definition, and the step line
 * reads "draw_thread" rather than "draw", which is the difference between a
 * progress line that informs and one that only proves something is alive.
 */
export function canvasTools(canvas: SpoolCanvas): SideTool[] {
  const span = z.union([z.literal(1), z.literal(2)]).optional().describe("1 = half width (default), 2 = full width");
  const id = z.string().min(1).describe("Your handle for this block. Drawing the same id again REPLACES it in place.");

  /** Parsed against the protocol before it lands, so a malformed draw is
   *  reported to the model rather than corrupting the surface. */
  const place = (block: unknown): string => {
    canvas.draw(SpoolCanvasBlock.parse(block));
    return "drawn";
  };

  return [
    {
      name: "clear_canvas",
      description:
        "Erase everything on the canvas. Use this ONLY when what you are about to draw replaces the whole screen — the previous canvas stays visible while you work, so clearing early leaves the person staring at nothing.",
      shape: {},
      handler: () => {
        canvas.clear();
        return "cleared";
      },
    },
    {
      name: "erase_block",
      description: "Remove one block by id.",
      shape: { id: z.string().min(1) },
      handler: (input) => {
        const { id: target } = z.object({ id: z.string() }).parse(input);
        return canvas.erase(target) ? "erased" : "no block had that id";
      },
    },
    {
      name: "draw_heading",
      description: "A section title. Say what the section is ABOUT today, not what kind of data it holds.",
      shape: { id, span, text: z.string(), note: z.string().optional() },
      handler: (input) => place({ ...(input as object), kind: "heading" }),
    },
    {
      name: "draw_text",
      description:
        "A sentence you are saying on the canvas. This is what makes it a briefing rather than a dashboard — use it to tell them something, not to label things.",
      shape: {
        id,
        span,
        text: z.string(),
        lead: z.boolean().optional().describe("The opening line. At most one block should set this."),
      },
      handler: (input) => place({ ...(input as object), kind: "text" }),
    },
    {
      name: "draw_subject",
      description: "A subject — a container heading whose questions you draw after it.",
      shape: {
        id,
        span,
        name: z.string(),
        note: z.string().optional(),
        working: z.string().optional().describe("Set only if a pass is running on it right now."),
      },
      handler: (input) => place({ ...(input as object), kind: "subject" }),
    },
    {
      name: "draw_thread",
      description:
        "An open question. Pass subject and threadId to make it clickable — clicking starts work on it. Set `waiting` ONLY for a third party; never for the user themselves.",
      shape: {
        id,
        span,
        label: z.string(),
        known: z.number().optional(),
        unanswered: z.number().optional(),
        waiting: z.string().optional(),
        settled: z.boolean().optional(),
        subject: z.string().optional(),
        threadId: z.string().optional(),
      },
      handler: (input) => place({ ...(input as object), kind: "thread" }),
    },
    {
      name: "draw_capture",
      description:
        "The user's own words, verbatim. Never paraphrase into this — it is the one string on the screen that is theirs.",
      shape: { id, span, said: z.string(), provenance: z.string().optional(), itemId: z.string().optional() },
      handler: (input) => place({ ...(input as object), kind: "capture" }),
    },
    {
      name: "draw_proposal",
      description:
        "Something you are suggesting they do. Put THEIR words in `said` and your reading of them in `because`, so the suggestion sits under the thing that caused it.",
      shape: {
        id,
        span,
        because: z.string(),
        said: z.string().optional(),
        subject: z.string().optional(),
        threadId: z.string().optional(),
      },
      handler: (input) => place({ ...(input as object), kind: "proposal" }),
    },
    {
      name: "draw_fact",
      description: "Something known about a subject, with where it came from and whether anything has checked it.",
      shape: { id, span, text: z.string(), source: z.string().optional(), checked: z.boolean().optional() },
      handler: (input) => place({ ...(input as object), kind: "fact" }),
    },
  ];
}

/** What the composer says back in the chat. The canvas is the answer; this is
 *  the one line acknowledging what was asked. */
export const CanvasSay = z.object({
  say: z
    .string()
    .describe("One or two sentences for the chat, in plain language. Do NOT restate the canvas — they can see it."),
});

/**
 * THE BRIEF THE COMPOSER WORKS FROM.
 *
 * ── EVERYTHING IS IN THE PROMPT, AND NOTHING IS A TOOL ──────────────────────
 * The composer gets no read tools. The Spool's whole map is a few kilobytes, so
 * handing it over costs one prompt instead of six round trips of the model
 * asking what exists — and every second it spends discovering the store is a
 * second the screen is empty. It reads once and draws for the rest of the pass.
 */
export function canvasPrompt(input: {
  asked: string;
  state: string;
}): string {
  return `You are composing the screen a person is looking at right now. They asked:

"${input.asked}"

You answer by DRAWING. Everything you call takes effect immediately — they are
watching the page build as you work — so draw the most useful thing first and
refine it, rather than thinking silently and drawing at the end.

── WHAT IS IN THEIR SPOOL ──────────────────────────────────────────────────
${input.state}

── HOW TO COMPOSE ──────────────────────────────────────────────────────────
· OPEN WITH A SENTENCE. draw_text with lead:true, telling them where they are —
  not a title, not a label. If nothing has changed since last time, say so
  plainly; that is useful and it is honest.
· ANSWER THE QUESTION THEY ASKED. This is not a dashboard that looks the same
  every morning. If they asked what is on today, the screen should be today's
  answer and nothing else. If they asked about one subject, do not draw the
  others.
· SHOW THEIR OWN WORDS. When you assert anything derived — someone is waiting,
  this is blocked, this matters — draw_capture or the proposal's \`said\` field
  underneath it. They have said they cannot use a system that reports things
  they do not understand, and their own five words explain it better than your
  sentence does.
· MAKE IT DO SOMETHING. Threads and proposals with subject/threadId are
  clickable and start work. A screen of pure nouns is the thing that failed.
· BE SHORT. Ten to eighteen blocks is a good screen. Everything you draw is
  something they have to read.
· NEVER INVENT. Only draw what is in the state above. If it is not there, you do
  not know it.

When the canvas says what you want it to say, call emit_result with one or two
sentences for the chat — do not restate what they can already see.`;
}

/**
 * COMPOSE ONE SCREEN.
 *
 * ── THE CANVAS IS UPDATED BY THE TOOLS, NOT BY THIS RETURN VALUE ────────────
 * By the time this resolves the screen has already been drawn — every block
 * landed the moment the model called for it. What comes back is only the
 * sentence for the chat and whether the pass got there, which is why the failure
 * path settles the canvas rather than clearing it: a half-drawn screen from a
 * pass that died is still more use than an empty one, and the status says so.
 *
 * WRITE-FREE. `assertWall` is left at its default, so the composer has read-only
 * built-ins and the seven draw tools, and drawing cannot touch the store. There
 * is no path from this function to a packet.
 */
export async function runCanvasTurn(
  canvas: SpoolCanvas,
  input: { asked: string; state: string; abort?: AbortController },
  run: typeof import("../agent.js").structuredAgent,
): Promise<{ ok: true; say: string } | { ok: false; reason: string }> {
  canvas.begin();
  const result = await run(canvasPrompt({ asked: input.asked, state: input.state }), {
    schema: CanvasSay,
    label: "spool canvas",
    // GENEROUS, because every turn is a block appearing. A pass capped at the
    // structured default would stop mid-screen, and a screen that stops mid-way
    // reads as broken rather than as finished.
    maxTurns: 40,
    sideTools: canvasTools(canvas),
    onStep: (step) => canvas.progress(step.label),
    ...(input.abort ? { abort: input.abort } : {}),
  });

  if (!result.ok) {
    canvas.settle({ ok: false, reason: result.reason });
    return { ok: false, reason: result.reason };
  }
  canvas.settle({ ok: true, say: result.value.say });
  return { ok: true, say: result.value.say };
}
