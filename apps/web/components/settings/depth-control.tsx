"use client";

/**
 * DEPTH — how far the elevation ladder travels.
 *
 * The ladder itself is three tokens in globals.css (--shadow-1/2/3), mixed
 * from one ink and tuned per half. This row moves the two multipliers in front
 * of them, through `data-depth` on <html>, which is why it is a Row and not a
 * tool: there is nothing to compose and nothing to preview separately — the
 * app IS the preview, and the thing being judged is whether a card looks like
 * it is sitting on the page.
 *
 * A DRAFT CONTROL, NOT A LIVE ONE. Depth is taste: it means the same thing in
 * a browser tab as in a desktop window, it travels in a Look
 * (`LookAppearance`), and a look built around flat hairlines is a different
 * look from the same palette under deep shadow. So it obeys the pane's one
 * rule — it edits the draft and waits on Apply — rather than joining
 * Translucency and Glass, which are facts about a MACHINE.
 *
 * ITS OWN FILE ON PURPOSE. The Appearance pane is being restructured from tabs
 * into stacked groups (#399); a self-contained row that takes `draft` and
 * `onDraft`, exactly as `ShowThroughTool` does, moves between those two shapes
 * as one import and one line.
 */

import { LayersIcon } from "lucide-react";
import type { Depth } from "@/lib/appearance";
import { patchDraftDepth, type StudioDraft } from "@/lib/studio-draft";
import { Dropdown, Row } from "./settings-shell";

/** The three answers, in the order the ladder travels rather than
 *  alphabetically — a reader picking one is picking a position on a scale. */
const OPTIONS: { value: Depth; label: string; text: string }[] = [
  { value: "flat", label: "Flat — hairlines only", text: "Flat" },
  { value: "soft", label: "Soft — the default", text: "Soft" },
  { value: "deep", label: "Deep — a longer shadow", text: "Deep" },
];

export function DepthControl({ draft, onDraft }: { draft: StudioDraft; onDraft: (next: StudioDraft) => void }) {
  return (
    <Row
      label="Depth"
      icon={LayersIcon}
      hint="How far raised surfaces — cards, the composer, menus — sit off the page."
      {...(draft.depth === "soft" ? {} : { onRevert: () => onDraft(patchDraftDepth(draft, "soft")) })}
      control={
        <Dropdown<Depth>
          value={draft.depth}
          onChange={(next) => onDraft(patchDraftDepth(draft, next))}
          options={OPTIONS}
          label="Depth"
        />
      }
    />
  );
}
