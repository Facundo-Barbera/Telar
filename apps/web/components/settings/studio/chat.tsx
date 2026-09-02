"use client";

/**
 * THE DESIGNER — a conversation about the draft, with memory.
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
 * IT IS A CONVERSATION, NOT A WIDGET. The transcript uses the app's own
 * `Message`/`MessageContent` (components/ui/message.tsx) and the input is the
 * app's own `ComposerEditor` (components/composer-editor.tsx) — the same
 * contenteditable a session types into, with its multi-line behaviour, its
 * Enter-to-send and Shift+Enter-for-a-newline, and its 50rem measure. It used
 * to be a single-line `Input` in a strip, which made the one part of this pane
 * you TALK to the least conversational surface in the app.
 *
 * The busy state is the header's tone rather than a sentence, the same way a
 * running session reports itself. An empty transcript is not dead space
 * either: it is the one place on the pane that says what the studio does, and
 * it hands over four openings to press.
 *
 * ONE REQUEST AT A TIME, but now with a way out: Stop aborts the fetch — the
 * engine's harness may still run to completion server-side, but its answer is
 * discarded and the input unlocks immediately. A response that fails
 * validation earns ONE automatic corrective retry carrying the validation
 * error; the usual cause is a single malformed hex, and the model fixes it
 * when told.
 */

import { useEffect, useRef, useState } from "react";
import { ArrowUpIcon, SparklesIcon, SquareIcon } from "lucide-react";
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
import { Message, MessageContent } from "@/components/ui/message";
import { ComposerEditor, type ComposerEditorHandle } from "@/components/composer-editor";
import { Panel, PanelBody, PanelHeader } from "@/components/ui/panel";

const api = createEngineApi();

const PLACEHOLDER = "Describe a look, or a change…";

/** Four openings, because a blank prompt is the hardest one to answer. They
 *  are moods rather than instructions — the brief the model does best with. */
const OPENINGS = ["cedar and dusk", "deep sea at night", "paper and ink", "warm autumn library"];

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
  const editor = useRef<ComposerEditorHandle>(null);
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

  /** Nothing has been asked yet — the invitation shows instead of a transcript
   *  of one line talking to itself. */
  const fresh = lines.length === 1 && lines[0]?.text === OPENING.text;

  const say = (kind: Line["kind"], text: string) => {
    const id = (nextId.current += 1);
    setLines((current) => [...current, { id, kind, text }]);
  };

  const stop = () => abortRef.current?.abort();

  /** `spoken` is what an opening chip presses with; everything else sends
   *  whatever is in the input. */
  const send = async (spoken?: string) => {
    const brief = (spoken ?? instruction).trim();
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
    <Panel className={cn("min-h-0", className)}>
      <PanelHeader
        icon={<SparklesIcon />}
        label="Designer"
        tone={busy ? "active" : "none"}
        actions={busy ? <span className="text-primary">Drafting…</span> : undefined}
      />

      {fresh ? (
        // THE INVITATION. The one place on the pane that states the contract,
        // and the only copy that survived the redesign's cull.
        <PanelBody className="flex flex-col items-center justify-center gap-3 px-6 py-10 text-center">
          <span className="text-muted-foreground/60 [&_svg]:size-5">
            <SparklesIcon />
          </span>
          <div className="space-y-1">
            <p className="text-sm font-medium">Describe a look</p>
            <p className="text-xs text-muted-foreground">Previewed live. Nothing is kept until you Apply.</p>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-1.5 pt-1">
            {OPENINGS.map((opening) => (
              <button
                key={opening}
                type="button"
                disabled={busy}
                onClick={() => void send(opening)}
                className="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:bg-accent hover:text-foreground disabled:opacity-50"
              >
                {opening}
              </button>
            ))}
          </div>
        </PanelBody>
      ) : (
        <PanelBody ref={transcript} className="flex flex-col gap-5 px-4 py-4">
          {lines.map((line) => (
            <Message key={line.id} from={line.kind === "you" ? "user" : "assistant"}>
              <MessageContent
                from={line.kind === "you" ? "user" : "assistant"}
                className={cn(line.kind === "trouble" && "rounded-lg bg-destructive/10 px-3 py-2 text-destructive")}
              >
                {line.text}
              </MessageContent>
            </Message>
          ))}
          {busy && (
            <Message from="assistant">
              <MessageContent from="assistant" className="text-muted-foreground">
                Drafting…
              </MessageContent>
            </Message>
          )}
        </PanelBody>
      )}

      {/* The composer a session gets: the same editor, the same measure, the
          same keys. Enter sends, Shift+Enter is a newline — claimed here
          because ComposerEditor hands the key to its parent first. */}
      <div className="shrink-0 border-t border-border px-4 py-3">
        <div className="mx-auto w-full max-w-[50rem]">
          <div className="flex items-end gap-2 rounded-xl border border-border bg-background p-2 focus-within:border-ring">
            <ComposerEditor
              ref={editor}
              value={instruction}
              onChange={setInstruction}
              placeholder={PLACEHOLDER}
              disabled={busy}
              className="max-h-40 min-h-9 flex-1 px-1.5 py-1.5 text-sm"
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.shiftKey) return;
                event.preventDefault();
                void send();
              }}
            />
            {busy ? (
              <Button size="icon-sm" variant="outline" className="size-8 shrink-0" onClick={stop} aria-label="Stop drafting">
                <SquareIcon />
              </Button>
            ) : (
              <Button
                size="icon-sm"
                className="size-8 shrink-0"
                disabled={instruction.trim().length === 0}
                aria-label="Send"
                onClick={() => void send()}
              >
                <ArrowUpIcon />
              </Button>
            )}
          </div>
        </div>
      </div>
    </Panel>
  );
}
