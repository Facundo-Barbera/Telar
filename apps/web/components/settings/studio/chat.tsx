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
import { CornerDownLeftIcon, ImagePlusIcon, SparklesIcon, SquareIcon, XIcon } from "lucide-react";
import { createEngineApi, EngineApiError } from "@/lib/engine/client";
import { compressImageFile } from "@/lib/image-backdrop";
import { dominantHues, samplePixels, themeFromPixels } from "@/lib/palette-from-image";
import { applyDesign, buildDesignPrompt, DESIGN_SCHEMA } from "@/lib/theme-designer";
import {
  buildStudioPrompt,
  designSummary,
  mergeDesignIntoDraft,
  readStudioChat,
  writeStudioChat,
  type StudioChatLine,
  type PromptPicture,
  type StudioDraft,
  type StudioMode,
} from "@/lib/studio-draft";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Message, MessageContent } from "@/components/ui/message";
import { ComposerEditor, type ComposerEditorHandle } from "@/components/composer-editor";
import { InputGroup, InputGroupAddon, InputGroupButton } from "@/components/ui/input-group";
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
  /** Pictures attached to the NEXT message. Each carries its own thumbnail and
   *  the colours read out of it — the model never sees the pixels (the engine's
   *  textgen takes a prompt and nothing else), so the palette IS the picture as
   *  far as the brief is concerned. */
  const [pictures, setPictures] = useState<{ id: number; name: string; url: string; colours: string[] }[]>([]);
  const [reading, setReading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const pictureId = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
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

  /** A picture becomes a swatch list. Compressed first so a 12MP photo is not
   *  decoded at full size just to be averaged, then sampled with the same
   *  reader the backdrop's "Take colours" uses — one answer to "what colours
   *  are in this?" for the whole pane. */
  const attach = async (files: readonly File[]) => {
    const images = files.filter((file) => file.type.startsWith("image/"));
    if (images.length === 0) return;
    setReading(true);
    for (const file of images) {
      try {
        const url = await compressImageFile(file);
        const pixels = await samplePixels(url);
        // THE PICTURE'S OWN HUES, not a theme derived from them. Handing the
        // model `--card: #1e1712` would be answering the design question
        // before it saw the brief; handing it the colours that are actually IN
        // the photograph leaves the design to the designer. A greyscale
        // picture honestly has no hue, and falls back to saying so with the
        // neutrals the reader would otherwise get.
        const hues = dominantHues(pixels, { count: 5 });
        const half = themeFromPixels(pixels).dark ?? {};
        const colours =
          hues.length > 0
            // HSL, because that is literally what was measured: `PaletteColor`
            // carries a hue in degrees and a MEAN HSL SATURATION, and its own
            // docs warn that the second is "not a CSS chroma". Writing it into
            // an oklch chroma slot pushed every swatch past the gamut and the
            // browser clamped them all to the same wall of colour.
            ? hues.map((hue) => `hsl(${hue.hue.toFixed(1)} ${Math.round(hue.chroma * 100)}% 55%)`)
            : [half.background, half.foreground].filter((value): value is string => typeof value === "string");
        const id = (pictureId.current += 1);
        setPictures((current) => [...current, { id, name: file.name, url, colours }]);
      } catch {
        say("trouble", `Could not read colours from ${file.name}.`);
      }
    }
    setReading(false);
  };

  /** `spoken` is what an opening chip presses with; everything else sends
   *  whatever is in the input. */
  const send = async (spoken?: string) => {
    const brief = (spoken ?? instruction).trim();
    const sent = pictures;
    if ((brief.length === 0 && sent.length === 0) || busy) return;
    setInstruction("");
    setPictures([]);
    say("you", brief || `Make a theme from ${sent.length === 1 ? "this picture" : "these pictures"}.`);
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;
    // What the model is shown — the merge later diffs its answer against this.
    const snapshot = draftRef.current;
    const history = lines.map(({ kind, text }) => ({ kind, text }));
    const asked = brief || `Make a theme from the attached ${sent.length === 1 ? "picture" : "pictures"}.`;
    const pictured: PromptPicture[] = sent.map((picture) => ({ name: picture.name, colours: picture.colours }));
    const prompt = buildStudioPrompt(snapshot, asked, buildDesignPrompt, { mode, history, pictures: pictured });
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
    <Panel
      className={cn("relative min-h-0", className, dragging && "ring-2 ring-primary")}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        void attach(Array.from(event.dataTransfer.files));
      }}
    >
      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-background/80 text-sm font-medium">
          Drop a picture to design from it
        </div>
      )}
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
            <p className="text-xs text-muted-foreground">
              Or drop a picture and design from its colours. Previewed live; nothing is kept until you Apply.
            </p>
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
      {/* THE SAME COMPOSER A SESSION HAS, built from the same primitives:
          `InputGroup` with its own chrome (the shadow is cast in
          --shadow-tint, not raw black — see globals.css), `ComposerEditor`,
          attachments in a block-start addon, and a block-end addon whose left
          side holds the tools and whose right holds the submit. The first cut
          of this invented its own rounded box with a circular send button,
          which is why it read as a different app. */}
      <div className="shrink-0 px-4 pt-1 pb-4">
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          aria-hidden
          onChange={(event) => {
            const picked = event.target.files ? Array.from(event.target.files) : [];
            // Cleared so picking the SAME file twice still fires a change.
            event.target.value = "";
            void attach(picked);
          }}
        />
        <div className="mx-auto w-full max-w-[50rem]">
          <InputGroup
            className={cn(
              "rounded-2xl border-border/80 bg-card/95 shadow-[0_18px_60px_-30px_var(--shadow-tint)] backdrop-blur-xl",
              dragging && "border-ring ring-2 ring-ring/40",
            )}
          >
            <label className="sr-only" htmlFor="designer-prompt">
              Describe a look
            </label>
            <ComposerEditor
              ref={editor}
              id="designer-prompt"
              value={instruction}
              placeholder={PLACEHOLDER}
              // NOT disabled while drafting: you can write the next change
              // while this one lands, exactly as a session lets you.
              onChange={setInstruction}
              onPasteFiles={(files) => void attach(files)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.shiftKey) return;
                event.preventDefault();
                void send();
              }}
            />
            {pictures.length > 0 && (
              <InputGroupAddon align="block-start" className="flex-wrap gap-1.5 px-2.5 pt-2.5">
                {pictures.map((picture) => (
                  <span key={picture.id} className="flex items-center gap-2 rounded-lg border border-border/60 bg-background/60 p-1 pr-1.5">
                    {/* eslint-disable-next-line @next/next/no-img-element -- a data URL held in state; there is nothing for next/image to fetch */}
                    <img src={picture.url} alt="" className="size-7 rounded object-cover" />
                    <span className="flex gap-0.5">
                      {picture.colours.slice(0, 5).map((colour, index) => (
                        <span key={index} className="size-3 rounded-full ring-1 ring-foreground/10" style={{ background: colour }} />
                      ))}
                    </span>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      className="size-5"
                      title={`Remove ${picture.name}`}
                      aria-label={`Remove ${picture.name}`}
                      onClick={() => setPictures((current) => current.filter((entry) => entry.id !== picture.id))}
                    >
                      <XIcon />
                    </Button>
                  </span>
                ))}
              </InputGroupAddon>
            )}
            <InputGroupAddon align="block-end" className="min-h-10 flex-wrap justify-between gap-1 border-t border-border/40 px-2 pt-1 pb-1.5">
              <div className="flex min-w-0 flex-wrap items-center gap-1">
                <InputGroupButton
                  variant="ghost"
                  size="icon-sm"
                  disabled={reading}
                  title="Attach a picture to design from"
                  aria-label="Attach a picture"
                  onClick={() => fileInput.current?.click()}
                >
                  <ImagePlusIcon className="size-4" />
                </InputGroupButton>
                {reading && <span className="text-xs text-muted-foreground">Reading the picture…</span>}
              </div>
              <InputGroupButton
                type="button"
                variant="default"
                size="icon-sm"
                aria-label={busy ? "Stop drafting" : "Send"}
                onClick={busy ? stop : () => void send()}
                className={cn(!busy && instruction.trim().length === 0 && pictures.length === 0 && "opacity-60")}
              >
                {busy ? <SquareIcon className="size-4" /> : <CornerDownLeftIcon className="size-4" />}
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </div>
      </div>
    </Panel>
  );
}
