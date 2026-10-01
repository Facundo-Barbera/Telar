import type { Artifact, Item } from "@telar/engine-client";

const ARTIFACT_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; form-action 'none'; base-uri 'none'";

export const ARTIFACT_SANDBOX = "allow-scripts";

export const MIN_FRAME_HEIGHT = 48;
export const MAX_FRAME_HEIGHT = 1600;

export type ArtifactHeight = { artifactFrame: string; height: number };

export function clampFrameHeight(height: unknown): number | undefined {
  if (typeof height !== "number" || !Number.isFinite(height)) return undefined;
  return Math.min(MAX_FRAME_HEIGHT, Math.max(MIN_FRAME_HEIGHT, Math.ceil(height)));
}

const escapeScript = (value: string) => JSON.stringify(value).replaceAll("<", "\\u003c");

export function artifactDocument(content: string, frame: string): string {
  const body = content.replace(/^\s*<!doctype[^>]*>/i, "");
  const report = `<script>(()=>{const post=()=>parent.postMessage({artifactFrame:${escapeScript(frame)},height:document.documentElement.scrollHeight},"*");new ResizeObserver(post).observe(document.documentElement);addEventListener("load",post);post();})()</script>`;
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}"><meta charset="utf-8"><style>html,body{margin:0;background:transparent}</style>${body}${report}`;
}

export function latestArtifacts(items: Iterable<Pick<Item, "detail">>): Map<string, Artifact> {
  const latest = new Map<string, Artifact>();
  for (const item of items) {
    if (item.detail.type !== "artifact") continue;
    const artifact = item.detail.artifact;
    const known = latest.get(artifact.id);
    if (!known || artifact.version > known.version) latest.set(artifact.id, artifact);
  }
  return latest;
}
