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
 * IT IS TASTE, AND IT WRITES THE STORE AT ONCE. Depth means the same thing in
 * a browser tab as in a desktop window and it travels in a Look
 * (`LookAppearance`) — a look built around flat hairlines is a different look
 * from the same palette under deep shadow. It used to edit the pane's draft and
 * wait on Apply; there is no draft (#471), so picking a stop retints the cards
 * behind this pane immediately, which is the only way to judge a shadow.
 *
 * ITS OWN FILE ON PURPOSE. A self-contained row that takes a value and a setter
 * moves between pane shapes as one import and one line.
 */

import { LayersIcon } from "lucide-react";
import { DEFAULT_DEPTH, type Depth } from "@/lib/appearance";
import { Dropdown, Row } from "./settings-shell";

/** The three answers, in the order the ladder travels rather than
 *  alphabetically — a reader picking one is picking a position on a scale. */
const OPTIONS: { value: Depth; label: string; text: string }[] = [
  { value: "flat", label: "Flat — hairlines only", text: "Flat" },
  { value: "soft", label: "Soft — the default", text: "Soft" },
  { value: "deep", label: "Deep — a longer shadow", text: "Deep" },
];

export function DepthControl({ value, onChange }: { value: Depth; onChange: (next: Depth) => void }) {
  return (
    <Row
      label="Depth"
      icon={LayersIcon}
      hint="How far raised surfaces — cards, the composer, menus — sit off the page."
      {...(value === DEFAULT_DEPTH ? {} : { onRevert: () => onChange(DEFAULT_DEPTH) })}
      control={<Dropdown<Depth> value={value} onChange={onChange} options={OPTIONS} label="Depth" />}
    />
  );
}
