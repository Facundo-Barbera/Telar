"use client";

/**
 * THE DESIGNER CHAT — a conversation about the draft, with memory.
 *
 * Each send carries the base brief, the CURRENT DRAFT, and the RECENT
 * TRANSCRIPT (buildStudioPrompt). The draft makes the next message an edit
 * rather than a new theme; the transcript is what lets "like that, but colder"
 * and standing constraints ("keep the borders hairline") survive across turns
 * — the model used to see only pixels, and re-inferred intent every time.
 *
 * THE ANSWER LANDS AS A THREE-WAY MERGE. The model saw a snapshot; the reader
 * may have kept editing during the sixty-second wait. `mergeDesignIntoDraft`
 * applies only what the model CHANGED relative to that snapshot onto whatever
 * the draft has become — so a mid-flight hand edit survives, and so does a
 * renamed label.
 *
 * THE TRANSCRIPT PERSISTS beside the draft (lib/studio-draft.ts): navigating
 * away and back resumes the same conversation over the same draft, because
 * the record of WHY the draft looks like it does is part of the work.
 *
 * ONE REQUEST AT A TIME, but now with a way out: Stop aborts the fetch — the
 * engine's harness may still run to completion server-side, but its answer is
 * discarded and the input unlocks immediately. A response that fails
 * validation earns ONE automatic corrective retry carrying the validation
 * error; the usual cause is a single malformed hex, and the model fixes it
 * when told.
 */

import { useEffect, useRef, useState } from "react";
import { SendHorizontalIcon, SparklesIcon, SquareIcon } from "lucide-react";
import { createEngineApi, EngineApiError } from "@/lib/engine/client";
import { applyDesign, buildDesignPrompt, DESIGN_SCHEMA } from "@/lib/theme-designer";
import {
  buildStudioPrompt,
  designSummary,
  mergeDesignIntoDraft,
  readStudioChat,
  writeStudioChat,
  type StudioChatLine,
  type StudioDraft,
  type StudioMode,
} from "@/lib/studio-draft";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const api = createEngineApi();

const PLACEHOLDER = "Describe a look — “cedar and dusk”, or a change — “warmer”…";

type Line = StudioChatLine & { id: number };

const OPENING: StudioChatLine = {
  kind: "studio",
  text: "Describe a look and I will draft it — the app itself previews the draft. Ask for changes after; I edit what is there, and I remember what you asked for.",
};

/** The MESSAGE, not a flag — the ways this fails are different things to do
 *  about it: fix the Text generation setting, start the engine, or simply say
 *  it differently. */
function failureMessage(cause: unknown): string {
  if (cause instanceof DOMException && cause.name === "AbortError") return "Stopped.";
  if (cause instanceof EngineApiError) {
    if (cause.code === "textgen_failed") return "The engine's model didn't answer — check the Text generation setting (Settings → Application).";
    if (cause.code === "engine_unavailable") return "The cockpit cannot reach its engine right now.";
    return cause.message;
  }
  return "That design could not be made.";
}

export function DesignerChat({
  draft,
  onDraft,
  mode,
  className,
}: {
  draft: StudioDraft;
  onDraft: (next: StudioDraft) => void;
  mode?: StudioMode;
  className?: string;
}) {
  // Restored from storage on mount (client-only component — the parent gates
  // on `mounted`), persisted on every change, ids re-minted for render.
  const [lines, setLines] = useState<Line[]>(() => {
    const kept = readStudioChat();
    const source = kept.length > 0 ? kept : [OPENING];
    return source.map((line, index) => ({ ...line, id: index }));
  });
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const transcript = useRef<HTMLDivElement>(null);
  const nextId = useRef(0);
  /** The draft as it stands NOW — tracked via effect. The merge needs it
   *  because the response arrives long after the send-time closure. */
  const draftRef = useRef(draft);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);
  const abortRef = useRef<AbortController>(null);

  useEffect(() => {
    if (nextId.current === 0) nextId.current = lines.length;
    // Initial id watermark only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The newest line is the one worth reading; a dock that had to be scrolled
  // to see the answer would hide the only output this control has.
  useEffect(() => {
    const node = transcript.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [lines, busy]);

  // Persist without the render ids; the opening line alone is not worth a key.
  useEffect(() => {
    const bare = lines.map(({ kind, text }) => ({ kind, text }));
    writeStudioChat(bare.length === 1 && bare[0]?.text === OPENING.text ? [] : bare);
  }, [lines]);

  // An abandoned request must not write into a pane that no longer exists.
  useEffect(() => () => abortRef.current?.abort(), []);

  const say = (kind: Line["kind"], text: string) => {
    const id = (nextId.current += 1);
    setLines((current) => [...current, { id, kind, text }]);
  };

  const stop = () => abortRef.current?.abort();

  const send = async () => {
    const brief = instruction.trim();
    if (brief.length === 0 || busy) return;
    setInstruction("");
    say("you", brief);
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;
    // What the model is shown — the merge later diffs its answer against this.
    const snapshot = draftRef.current;
    const history = lines.map(({ kind, text }) => ({ kind, text }));
    const prompt = buildStudioPrompt(snapshot, brief, buildDesignPrompt, { mode, history });
    try {
      const ask = (extra?: string) =>
        api.complete(
          { prompt: extra ? `${prompt}\n\n${extra}` : prompt, schema: DESIGN_SCHEMA, effort: "medium" },
          { signal: controller.signal },
        );
      let { result } = await ask();
      let outcome = applyDesign(result);
      if (outcome.error !== undefined) {
        // One corrective retry: the usual failure is a single malformed value,
        // and the model repairs it when the error is named.
        ({ result } = await ask(`YOUR PREVIOUS ANSWER WAS REJECTED: ${outcome.error} Answer again, valid against the schema — every token a #RRGGBB hex.`));
        outcome = applyDesign(result);
      }
      if (outcome.error !== undefined) {
        say("trouble", outcome.error);
        return;
      }
      onDraft(mergeDesignIntoDraft(draftRef.current, snapshot, outcome));
      say("studio", designSummary(outcome));
    } catch (cause: unknown) {
      say("trouble", failureMessage(cause));
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  };

  return (
    <div className={cn("flex min-h-0 flex-col overflow-hidden rounded-xl bg-card text-card-foreground ring-1 ring-foreground/10", className)}>
      <div className="flex items-center gap-1.5 border-b border-border px-3 py-2">
        <SparklesIcon className="size-3.5 text-muted-foreground" />
        <span className="text-xs font-medium">Designer</span>
        <span className="ml-auto text-[0.6875rem] text-muted-foreground">
          {busy ? "Drafting… this can take a minute" : "Edits the draft — nothing lands until Apply"}
        </span>
      </div>

      <div ref={transcript} className="flex max-h-96 min-h-24 flex-1 flex-col gap-1.5 overflow-y-auto px-3 py-2.5">
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
        {busy ? (
          <Button size="sm" variant="outline" onClick={stop} aria-label="Stop drafting">
            <SquareIcon /> Stop
          </Button>
        ) : (
          <Button size="sm" variant="outline" disabled={instruction.trim().length === 0} onClick={() => void send()}>
            <SendHorizontalIcon /> Send
          </Button>
        )}
      </div>
    </div>
  );
}
