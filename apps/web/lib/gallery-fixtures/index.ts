// GALLERY (delete with /gallery) — FROZEN barrel for the dev view gallery.
// Lane F implements; Lane G imports these EXACT names + types. Do not change the
// exported surface without renegotiating with the other lane.
//
// Requirement (4) reality: Loom / LoomEvent / AttemptRecord / GateResult are
// PLAIN TS TYPES in @telar/core (not zod). The fixture ENVELOPE is therefore
// compile-time-checked (this module is typed Loom / LoomEvent); every zod-backed
// NESTED structure (Charter, VerificationContract, ContractAssertion, Verdict,
// VerifierReport, PanelReport, ServersConfig, Provenance) is RUNTIME-validated by
// fixtures.validate.test.ts, which also runs the REAL validateContract()
// falsifiability invariant. That is the anti-drift proof.
import type { Loom, LoomEvent } from "@telar/core";
import type { SpecBundleData } from "@/components/looms/spec-bundle";
import type { InitialChat } from "@/components/session/session-view";

import { GALLERY_ID_PREFIX } from "./builders";
import { journeyBundles } from "./scenarios/journey";
import { scopingBundles } from "./scenarios/scoping";
import { charterBundles } from "./scenarios/charter";
import { runningBundles } from "./scenarios/running";
import { chatBundles } from "./scenarios/chat";
import { blockedBundles } from "./scenarios/blocked";
import { envBundles } from "./scenarios/env";
import { verifyBundles } from "./scenarios/verify";
import { reviewBundles } from "./scenarios/review";
import { readyBundles } from "./scenarios/ready";
import { terminalBundles } from "./scenarios/terminal";
import { drawersBundles } from "./scenarios/drawers";

// Re-export the sentinel prefix (the FROZEN barrel owns this name; it's DEFINED
// in builders.ts so the leaf factories can stamp ids without a cycle).
export { GALLERY_ID_PREFIX } from "./builders";

// Which top-level surface page.tsx (:408-448) would route this loom to.
export type GallerySurface =
  | "godview"
  | "scoping"
  | "charter"
  | "env"
  | "discuss"
  | "loom-cards"
  | "session";

export type GalleryGroup =
  | "journey"
  | "scoping"
  | "charter"
  | "running"
  | "blocked"
  | "env"
  | "verify"
  | "review"
  | "ready"
  | "terminal"
  | "drawers"
  | "chat";

// A recommended tab/interaction the reviewer clicks AFTER the entry opens. NAV
// HINT ONLY (LoomGodView owns its tab state; DiscussEscalation owns `discussing`
// and hard-requires no auto-start) — never injected as a prop.
export type GalleryViewHint =
  | "orchestrator"
  | "threads"
  | "verify"
  | "chat"
  | "open-decision-rationale"
  | "click-discuss";

export type GalleryFixtureBundle = {
  id: string; // catalog id === loom.id (GALLERY_ID_PREFIX + slug)
  label: string; // nav label
  group: GalleryGroup;
  description: string; // one-line "what to look at"
  surface: GallerySurface;
  loom: Loom; // root loom; loom.state drives page-style routing
  threads: Loom[]; // child threads (woven); [] for single
  feed: LoomEvent[]; // event feed deriveGodView(loom, threads, feed) consumes
  // Seam-backed GET payloads, served by the interceptor keyed on loom.id:
  spec?: SpecBundleData; // GET /api/looms/<id>/spec
  chat?: InitialChat | null; // GET /api/looms/<id>/chat -> { chat }
  evidence?: Record<string, string>; // evidence relPath -> data: URI (GET /evidence/<relPath>)
  // Stage-honored open state (the gallery stage owns these, exactly like page.tsx):
  openOperatorId?: string; // pre-open AgentViewDrawer on this operator id
  openSpec?: boolean; // pre-open SpecDrawer
  // Reviewer-click hints (documented in the entry chrome, NOT injected):
  viewHints?: GalleryViewHint[];
};

// Ordered catalog the gallery nav renders (grouped by `group`, catalog order).
export const GALLERY_FIXTURES: GalleryFixtureBundle[] = [
  ...journeyBundles,
  ...scopingBundles,
  ...charterBundles,
  ...runningBundles,
  ...chatBundles,
  ...blockedBundles,
  ...envBundles,
  ...verifyBundles,
  ...reviewBundles,
  ...readyBundles,
  ...terminalBundles,
  ...drawersBundles,
];

// O(1) lookup by id — used by the stage AND the fetch interceptor.
const BY_ID: Map<string, GalleryFixtureBundle> = new Map(
  GALLERY_FIXTURES.map((b) => [b.id, b]),
);

export function getGalleryFixture(id: string): GalleryFixtureBundle | undefined {
  return BY_ID.get(id);
}

// ---------------------------------------------------------------------------
// PURE seam resolver (no I/O). Given an intercepted request, returns how the
// gallery should answer it, or "passthrough" for any non-fixture URL. Handled:
//   GET /api/looms/<gallery-id>/spec            -> json  (bundle.spec ?? 404-shaped)
//   GET /api/looms/<gallery-id>/chat            -> json  ({ chat: bundle.chat ?? null })
//   GET /api/looms/<gallery-id>/evidence/<path> -> image (bundle.evidence[path] data URI)
//   GET /api/looms/<gallery-id>                 -> json  ({ loom: bundle.loom })
//   GET /api/looms/<gallery-id>/threads         -> json  ({ threads: bundle.threads })
//   ANY /api/looms/<gallery-id>/** (POST intervene, /events, /spec/<file>) -> benign json
//   ANY /api/chat**                             -> benign json (SessionView stub)
//   anything else                               -> { kind: "passthrough" }
// ---------------------------------------------------------------------------

export type GalleryFetchResult =
  | { kind: "json"; status?: number; body: unknown }
  | { kind: "image"; dataUri: string }
  | { kind: "passthrough" };

const BENIGN: GalleryFetchResult = { kind: "json", body: { ok: false, gallery: true } };

// Extract the request pathname from an absolute or relative URL — we only care
// about the "/api/..." tail, so slice from the first "/api/" occurrence.
function pathnameOf(url: string): string {
  const clean = url.split(/[?#]/, 1)[0] ?? url;
  const idx = clean.indexOf("/api/");
  return idx >= 0 ? clean.slice(idx) : clean;
}

export function resolveGalleryFetch(input: {
  url: string;
  method: string;
  body?: string;
}): GalleryFetchResult {
  const path = pathnameOf(input.url);

  // The SessionView chat runtime (planner / steerer / escalation) — always
  // stubbed benign while a gallery route is mounted; its stream is out of scope.
  if (path === "/api/chat" || path.startsWith("/api/chat/") || path.startsWith("/api/chat?")) {
    return BENIGN;
  }

  const m = /^\/api\/looms\/([^/]+)(?:\/(.*))?$/.exec(path);
  if (!m) return { kind: "passthrough" };

  const id = decodeURIComponent(m[1] ?? "");
  const rest = m[2] ?? "";

  // Only fixture ids are ever handled; every real loom id delegates to the real
  // fetch (real ids never carry the `gallery__` prefix — no collision).
  if (!id.startsWith(GALLERY_ID_PREFIX)) return { kind: "passthrough" };

  const bundle = getGalleryFixture(id);
  if (!bundle) return BENIGN; // a gallery-shaped id with no fixture — contain it, never hit the server

  if (rest === "") return { kind: "json", body: { loom: bundle.loom } };
  if (rest === "threads") return { kind: "json", body: { threads: bundle.threads } };
  if (rest === "spec") {
    return bundle.spec
      ? { kind: "json", body: bundle.spec }
      : { kind: "json", status: 404, body: { error: "no spec bundle" } };
  }
  if (rest === "chat") return { kind: "json", body: { chat: bundle.chat ?? null } };
  if (rest.startsWith("evidence/")) {
    const relPath = decodeURIComponent(rest.slice("evidence/".length));
    const dataUri = bundle.evidence?.[relPath];
    return dataUri
      ? { kind: "image", dataUri }
      : { kind: "json", status: 404, body: { error: "no such evidence" } };
  }

  // Everything else under a fixture loom (POST accept/steer/resume, /events,
  // /spec/<file>, /charter/approve, /env/*, /block/answer, …) — benign, never
  // reaches the real server.
  return BENIGN;
}
