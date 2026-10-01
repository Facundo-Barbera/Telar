export function monogramHue(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 360;
}

export function monogramInitial(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "?";
  const segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : undefined;
  const first = segmenter ? (segmenter.segment(trimmed)[Symbol.iterator]().next().value?.segment ?? trimmed[0]!) : trimmed[0]!;
  return first.toUpperCase();
}
