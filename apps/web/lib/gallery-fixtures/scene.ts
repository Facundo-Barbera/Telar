// GALLERY (delete with /gallery) — the ACTIVE-SCENE resolver (gallery v2). NEW
// FILE. The v1 interceptor (resolveGalleryFetch) keys on a loom id embedded in
// the URL, so it can answer per-loom seams (/api/looms/<id>/spec …). But the
// full app pages self-fetch COLLECTION endpoints with NO id in the URL
// (/api/looms, /api/projects, /api/chats, /api/usage, /api/accounts,
// /api/mcp/oauth/status, /api/projects/<n>/mcp, /api/permissions/<p>,
// POST /api/browse). Those need a per-ENTRY answer, so the app-view stage sets an
// active GalleryScene BEFORE its child page's fetch effects run, and the
// interceptor consults resolveGalleryAppFetch(input, getActiveScene()) after
// resolveGalleryFetch returns passthrough.
//
// resolveGalleryAppFetch is PURE (no I/O — it mirrors resolveGalleryFetch's
// pathnameOf helper). setActiveScene/getActiveScene wrap the ONE module-let ref
// (the only mutable state; the stage owns its lifecycle exactly like page.tsx).
//
// Client-safety: this module `import type`s every shape, so it pulls ZERO runtime
// code from @telar/core / lib/store — it only reads strings + returns plain
// objects.
import type {
  AccountProfile,
  Loom,
  ProjectManifest,
  RegistryEntry,
} from "@telar/core";
import type { ChatSummary, PlanSnapshot } from "@/lib/store";
import type { HttpStatus } from "@/components/settings/mcp-health";
import type { GalleryFetchResult } from "./index";

// One served endpoint. `status` drives the empty-vs-error split: a 200 with an
// empty body ([]/{}) renders a view's empty state; a 500 renders its error
// state. Absent status = 200.
export type GalleryEndpoint<T> = { body: T; status?: number };

// The bag of collection answers ONE app-view entry needs. Every field is
// optional — an entry supplies only the endpoints its page actually fetches; an
// unsupplied endpoint falls through to passthrough (which, under the gallery
// layout, then hits the benign interceptor floor / real 404). Bodies are the
// EXACT wire shapes the real routes emit, so the real pages parse them unchanged.
export type GalleryScene = {
  looms?: GalleryEndpoint<{ looms: Loom[]; active: string[] }>;
  projects?: GalleryEndpoint<{
    projects: Array<{
      entry: RegistryEntry;
      manifest: ProjectManifest | null;
      error: string | null;
    }>;
  }>;
  chats?: GalleryEndpoint<{ chats: ChatSummary[] }>;
  usage?: GalleryEndpoint<{ plan: Record<string, PlanSnapshot>; ledger?: unknown }>;
  accounts?: GalleryEndpoint<{ accounts: AccountProfile[]; default: string }>;
  // /api/mcp/oauth/status — wire shape is { servers: {...} } (normalizeStatus
  // reads `.servers`), so the endpoint body carries that envelope verbatim.
  mcpStatus?: GalleryEndpoint<{ servers: Record<string, HttpStatus> }>;
  mcpTokens?: GalleryEndpoint<{ tokens: Record<string, boolean> }>; // /api/projects/<n>/mcp
  permissions?: GalleryEndpoint<{ rules: string[] }>; // /api/permissions/<p>
  browse?: GalleryEndpoint<{ path?: string; cancelled?: boolean }>; // POST /api/browse
  // Every other write (POST/PATCH/DELETE) → { ok: true } unless this is
  // explicitly false (then the write passes through). Default: benign.
  benignMutations?: boolean;
};

// Mirror of resolveGalleryFetch's pathnameOf — slice the "/api/..." tail off an
// absolute or relative URL, dropping any query/hash so ?project=&archived= etc.
// never defeat an exact path match.
function pathnameOf(url: string): string {
  const clean = url.split(/[?#]/, 1)[0] ?? url;
  const idx = clean.indexOf("/api/");
  return idx >= 0 ? clean.slice(idx) : clean;
}

function json(body: unknown, status?: number): GalleryFetchResult {
  return status === undefined ? { kind: "json", body } : { kind: "json", status, body };
}

// PURE. Given an intercepted request and the active scene, returns how the
// gallery should answer it, or { kind: "passthrough" } when the scene is null or
// the URL is one this resolver doesn't own.
export function resolveGalleryAppFetch(
  input: { url: string; method: string; body?: string },
  scene: GalleryScene | null,
): GalleryFetchResult {
  if (!scene) return { kind: "passthrough" };
  const path = pathnameOf(input.url);
  const method = input.method.toUpperCase();

  const answer = <T>(ep: GalleryEndpoint<T> | undefined): GalleryFetchResult =>
    ep ? json(ep.body, ep.status) : { kind: "passthrough" };

  if (method === "GET") {
    if (path === "/api/looms") return answer(scene.looms);
    if (path === "/api/projects") return answer(scene.projects);
    if (path === "/api/chats") return answer(scene.chats);
    if (path === "/api/usage") return answer(scene.usage);
    if (path === "/api/accounts") return answer(scene.accounts);
    if (path === "/api/mcp/oauth/status") return answer(scene.mcpStatus);
    if (/^\/api\/projects\/[^/]+\/mcp$/.test(path)) return answer(scene.mcpTokens);
    if (/^\/api\/permissions\/[^/]+$/.test(path)) return answer(scene.permissions);
    return { kind: "passthrough" };
  }

  // POST /api/browse always resolves from the scene's browse endpoint when the
  // entry declares one (the native picker's { path } | { cancelled } shape),
  // independent of benignMutations.
  if (method === "POST" && path === "/api/browse" && scene.browse) {
    return json(scene.browse.body, scene.browse.status);
  }

  // Every other write is contained: { ok: true } by default so a mutation in a
  // rendered page never reaches the real server, unless the entry opts out.
  if (method === "POST" || method === "PATCH" || method === "DELETE" || method === "PUT") {
    return scene.benignMutations === false ? { kind: "passthrough" } : json({ ok: true });
  }

  return { kind: "passthrough" };
}

// ---------------------------------------------------------------------------
// The active-scene ref — the ONLY mutable state in the gallery fixture layer.
// The app-view stage calls setActiveScene(entry.scene) synchronously at the top
// of render (before any child fetch effect fires) and clears it on unmount; the
// interceptor reads it via getActiveScene().
// ---------------------------------------------------------------------------
let activeScene: GalleryScene | null = null;

export function setActiveScene(scene: GalleryScene | null): void {
  activeScene = scene;
}

export function getActiveScene(): GalleryScene | null {
  return activeScene;
}
