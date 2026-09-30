import { LOCAL_HOST_ID, rewriteApiPath } from "@/platform/engine/host-client";


export function projectHue(name: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < name.length; index += 1) {
    hash ^= name.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 360;
}

export function projectInitial(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  const segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : undefined;
  const first = segmenter ? (segmenter.segment(trimmed)[Symbol.iterator]().next().value?.segment ?? trimmed[0]!) : trimmed[0]!;
  return first.toUpperCase();
}

export function projectIconUrl(projectId: string, icon: string, hostId: string = LOCAL_HOST_ID): string {
  return rewriteApiPath(`/api/projects/${encodeURIComponent(projectId)}/icon?v=${encodeURIComponent(icon)}`, hostId);
}
