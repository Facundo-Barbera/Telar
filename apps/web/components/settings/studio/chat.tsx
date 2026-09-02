"use client";

/**
 * THE DESIGNER CHAT — the settings pane's one-shot designer, made iterative.
 *
 * The Designer row on the old pane took a description and produced a theme
 * from nothing, every time: asking for "warmer" after it got you a theme built
 * around the word "warmer" instead of a warmer version of what you had. The
 * fix is not a better model, it is a better prompt — `buildStudioPrompt`
 * appends the CURRENT DRAFT to the same brief and tells the model it is
 * editing. So the transcript here is a real conversation, and the thing being
 * conversed about is the draft on the stage.
 *
 * THE TRANSCRIPT IS LOCAL AND UNSAVED. It is scaffolding for arriving at a
 * look, not a record worth keeping: the artefact is the draft, which becomes a
 * Look on Apply. Nothing here is written to storage, and reloading the pane
 * starts a fresh conversation over whatever the draft has become.
 *
 * ONE REQUEST AT A TIME. Each send spawns a CLI harness one-shot in the engine
 * — five to sixty seconds, cold start included — and two in flight would race
 * each other into the same draft, with the loser silently winning. The input
 * and the button both disable while one is out.
 *
 * FAILURES ARE TRANSCRIPT LINES, not a banner: they belong to the message that
 * caused them, and the next attempt should be able to see what the last one
 * said. The three engine failures are three different things to do about it,
 * so the message is kept rather than reduced to "something went wrong".
 */

import { useEffect, useRef, useState } from "react";
import { SendHorizontalIcon, SparklesIcon } from "lucide-react";
import { createEngineApi, EngineApiError } from "@/lib/engine/client";
import { applyDesign, buildDesignPrompt, DESIGN_SCHEMA } from "@/lib/theme-designer";
import { buildStudioPrompt, designSummary, mergeDesignIntoDraft, type StudioDraft } from "@/lib/studio-draft";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const api = createEngineApi();

const PLACEHOLDER = "Describe a change — “warmer”, “deeper night”, “cedar and dusk”…";

type Line = { id: number; kind: "you" | "studio" | "trouble"; text: string };

const OPENING: Line = {
  id: 0,
  kind: "studio",
  text: "Describe a look and I will draft it onto the stage. Ask for changes after — I edit what is there rather than starting again.",
};

/** The MESSAGE, not a flag — the three ways this fails are three different
 *  things to do about it: fix the Text generation setting, start the engine, or
 *  simply say it differently. */
function failureMessage(cause: unknown): string {
  if (cause instanceof EngineApiError) {
    if (cause.code === "textgen_failed") return "The engine's model didn't answer — check the Text generation setting.";
    if (cause.code === "engine_unavailable") return "The cockpit cannot reach its engine right now.";
    return cause.message;
  }
  return "That design could not be made.";
}

export function DesignerChat({ draft, onDraft, className }: { draft: StudioDraft; onDraft: (next: StudioDraft) => void; className?: string }) {
  const [lines, setLines] = useState<Line[]>([OPENING]);
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const transcript = useRef<HTMLDivElement>(null);
  const nextId = useRef(1);

  // The newest line is the one worth reading; a dock that had to be scrolled
  // to see the answer would hide the only output this control has.
  useEffect(() => {
    const node = transcript.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [lines, busy]);

  const say = (kind: Line["kind"], text: string) => {
    const id = nextId.current;
    nextId.current += 1;
    setLines((current) => [...current, { id, kind, text }]);
  };

  const send = async () => {
    const brief = instruction.trim();
    if (brief.length === 0 || busy) return;
    setInstruction("");
    say("you", brief);
    setBusy(true);
    try {
      // The draft as it stands RIGHT NOW rides in the prompt — that is what
      // makes the next message an edit rather than a new theme.
      const { result } = await api.complete({ prompt: buildStudioPrompt(draft, brief, buildDesignPrompt), schema: DESIGN_SCHEMA });
      const outcome = applyDesign(result);
      if (outcome.error !== undefined) {
        say("trouble", outcome.error);
        return;
      }
      onDraft(mergeDesignIntoDraft(draft, outcome));
      say("studio", designSummary(outcome));
    } catch (cause: unknown) {
      say("trouble", failureMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={cn("flex min-h-0 flex-col overflow-hidden rounded-xl bg-card text-card-foreground ring-1 ring-foreground/10", className)}>
      <div className="flex items-center gap-1.5 border-b border-border px-3 py-2">
        <SparklesIcon className="size-3.5 text-muted-foreground" />
        <span className="text-xs font-medium">Designer</span>
        <span className="ml-auto text-[11px] text-muted-foreground">{busy ? "Drafting… this can take a minute" : "Drafts onto the stage, never onto the app"}</span>
      </div>

      <div ref={transcript} className="flex max-h-56 min-h-24 flex-1 flex-col gap-1.5 overflow-y-auto px-3 py-2.5">
        {lines.map((line) => (
          <div key={line.id} className={cn("flex", line.kind === "you" ? "justify-end" : "justify-start")}>
            <span
              className={cn(
                "max-w-[85%] rounded-lg px-2.5 py-1.5 text-xs leading-snug",
                line.kind === "you" && "bg-secondary text-secondary-foreground",
                line.kind === "studio" && "text-muted-foreground",
                line.kind === "trouble" && "bg-destructive/10 text-destructive",
              )}
            >
              {line.text}
            </span>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-1.5 border-t border-border px-3 py-2">
        <Input
          className="h-8"
          value={instruction}
          placeholder={PLACEHOLDER}
          aria-label="Describe a change to the draft"
          disabled={busy}
          onChange={(event) => setInstruction(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            void send();
          }}
        />
        <Button size="sm" variant="outline" disabled={busy || instruction.trim().length === 0} onClick={() => void send()}>
          <SendHorizontalIcon /> {busy ? "Drafting…" : "Send"}
        </Button>
      </div>
    </div>
  );
}
