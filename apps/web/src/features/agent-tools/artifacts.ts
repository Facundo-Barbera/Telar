import type { Artifact, Item } from "@telar/engine-client";

const ARTIFACT_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; form-action 'none'; base-uri 'none'";

export const ARTIFACT_SANDBOX = "allow-scripts";

export const MIN_FRAME_HEIGHT = 48;
export const MAX_FRAME_HEIGHT = 720;

export type ArtifactHeight = { artifactFrame: string; height: number };

export function clampFrameHeight(height: unknown): number | undefined {
  if (typeof height !== "number" || !Number.isFinite(height)) return undefined;
  return Math.min(MAX_FRAME_HEIGHT, Math.max(MIN_FRAME_HEIGHT, Math.ceil(height)));
}

export type LookTokens = { scheme: "light" | "dark"; background: string; foreground: string; muted: string; line: string; accent: string };

export function contentHeight(doc: Document): number {
  const body = doc.body;
  const style = getComputedStyle(body);
  let last = body.lastElementChild;
  while (last?.tagName === "SCRIPT") last = last.previousElementSibling;
  const range = doc.createRange();
  range.selectNodeContents(body);
  const tail = [last ? getComputedStyle(last).marginBottom : "0", style.paddingBottom, style.borderBottomWidth, style.marginBottom].reduce((sum, value) => sum + (parseFloat(value) || 0), 0);
  return range.getBoundingClientRect().bottom + (doc.defaultView?.scrollY ?? 0) + tail;
}

const escapeScript = (value: string) => JSON.stringify(value).replaceAll("<", "\\u003c");

const safeToken = (value: string) => value.replace(/[;{}<>]/g, "");

function lookStyle(look: LookTokens): string {
  const tokens = (["background", "foreground", "muted", "line", "accent"] as const).map((name) => (look[name] ? `--${name}:${safeToken(look[name])};` : "")).join("");
  return `<style>:where(:root){color-scheme:${look.scheme};${tokens}scrollbar-width:thin;scrollbar-color:color-mix(in oklab,currentColor 30%,transparent) transparent}:where(body){margin:0;padding:12px 14px;font:13px/1.5 system-ui,-apple-system,sans-serif;color:var(--foreground,CanvasText);background:transparent}</style>`;
}

export function artifactDocument(content: string, frame: string, look: LookTokens): string {
  const body = content.replace(/^\s*<!doctype[^>]*>/i, "");
  const report = `<script>(()=>{document.currentScript.remove();const measure=${contentHeight.toString()};const post=()=>parent.postMessage({artifactFrame:${escapeScript(frame)},height:measure(document)},"*");const watch=new ResizeObserver(post);watch.observe(document.documentElement);watch.observe(document.body);new MutationObserver(post).observe(document.body,{childList:true,subtree:true,characterData:true});addEventListener("load",post);document.fonts.ready.then(post);post();})()</script>`;
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}"><meta charset="utf-8">${lookStyle(look)}${body}${report}`;
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
