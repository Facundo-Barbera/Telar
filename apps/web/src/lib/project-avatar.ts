/**
 * The fallback half of a project's avatar: a tinted initial, derived from the
 * NAME so every surface that draws one derives the same hue. Pure functions in
 * a lib file because the sidebar row, the project picker and any future table
 * must not be able to disagree about what colour "Telar" is.
 */

/** FNV-1a over UTF-16 code units — stable, cheap, and good enough to spread a
 *  handful of project names around the wheel. */
export function projectHue(name: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < name.length; index += 1) {
    hash ^= name.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 360;
}

/** The first GRAPHEME, not the first code unit — "Ålesund" is Å and an emoji
 *  name keeps its whole emoji. Uppercased for latin; everything else is
 *  already its own mark. */
export function projectInitial(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  const segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : undefined;
  const first = segmenter ? (segmenter.segment(trimmed)[Symbol.iterator]().next().value?.segment ?? trimmed[0]!) : trimmed[0]!;
  return first.toUpperCase();
}

/** The engine-served bytes behind `Project.icon`. `?v=` carries the
 *  content-derived key, which is what makes the immutable cache honest. */
export function projectIconUrl(projectId: string, icon: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/icon?v=${encodeURIComponent(icon)}`;
}
