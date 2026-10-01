export type Size = { width: number; height: number };
export type View = { scale: number; x: number; y: number };

const MIN_SCALE = 0.05;
const MAX_SCALE = 8;
const READABLE_TEXT_PX = 11;
export const CARD_MAX_HEIGHT = 480;
const PANEL_PADDING = 24;
const PANEL_MAX_FIT = 3;

const clampScale = (scale: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));

/** The scale below which the diagram's typical text drops under READABLE_TEXT_PX. */
export function readableScale(svg: string): number {
  const sizes = [...svg.matchAll(/font-size\s*[:=]\s*["']?\s*(\d+(?:\.\d+)?)(?:px)?/gi)].map((match) => Number(match[1])).filter((size) => size > 0);
  sizes.sort((a, b) => a - b);
  const typical = sizes.length > 0 ? sizes[Math.floor(sizes.length / 2)]! : 16;
  return Math.min(2, READABLE_TEXT_PX / typical);
}

const centred = (content: Size, box: Size, scale: number): View => ({
  scale,
  x: (box.width - content.width * scale) / 2,
  y: Math.max(0, (box.height - content.height * scale) / 2),
});

export function fitView(content: Size, box: Size, maxScale = PANEL_MAX_FIT, padding = PANEL_PADDING): View {
  const scale = clampScale(Math.min(maxScale, (box.width - 2 * padding) / content.width, (box.height - 2 * padding) / content.height));
  return centred(content, box, scale);
}

/** A card shows the drawing at no more than natural size and never below readable; wider is clipped and panned. */
export function cardLayout(content: Size, cardWidth: number, minScale: number): { view: View; height: number; clipped: boolean } {
  const fit = cardWidth / content.width;
  const scale = clampScale(Math.max(Math.min(fit, 1), minScale));
  const height = Math.min(CARD_MAX_HEIGHT, Math.ceil(content.height * scale));
  const clipped = content.width * scale > cardWidth + 0.5 || content.height * scale > height + 0.5;
  const x = content.width * scale <= cardWidth ? (cardWidth - content.width * scale) / 2 : 0;
  return { view: { scale, x, y: 0 }, height, clipped };
}

/** Zooms by `factor` keeping the point under `at` (box coordinates) where it is. */
export function zoomAt(view: View, factor: number, at: { x: number; y: number }): View {
  const scale = clampScale(view.scale * factor);
  const ratio = scale / view.scale;
  return { scale, x: at.x - (at.x - view.x) * ratio, y: at.y - (at.y - view.y) * ratio };
}

/** A new version keeps the reader's zoom when it is about the same size as the one they were looking at. */
export function similarSize(before: Size, after: Size, tolerance = 0.15): boolean {
  return Math.abs(after.width - before.width) <= before.width * tolerance && Math.abs(after.height - before.height) <= before.height * tolerance;
}
