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
import type { ChatSummary } from "@/lib/store";

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

// GALLERY v2 — app-view scenes + session seeds + showcase data (additive).
import type { GalleryScene } from "./scene";
import { SHOWCASE } from "./showcase";
import {
  dashboardScene,
  dashboardIdleScene,
  dashboardErrorScene,
} from "./scenarios/app/dashboard";
import {
  projectsScene,
  projectsEmptyScene,
  projectsErrorScene,
  projectDetailAuroraScene,
  projectDetailEmptyScene,
  projectDetailMissingScene,
  projectDetailManifestErrorScene,
} from "./scenarios/app/projects";
import {
  projectSettingsScene,
  projectSettingsManifestErrorScene,
  settingsAccountsScene,
  settingsAccountsEmptyScene,
} from "./scenarios/app/settings";
import { loomsScene, loomsEmptyScene, loomsErrorScene } from "./scenarios/app/looms";
import {
  sessionPlainSeed,
  sessionEmptySeed,
  sessionPlannerSeed,
} from "./scenarios/app/session";

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

// ===========================================================================
// GALLERY v2 — App views + Component showcase registries (ADDITIVE). The 35
// loom bundles above and resolveGalleryFetch are UNCHANGED. Everything below is
// new surface: full non-cockpit pages (served by the active-scene resolver) and
// the isolated composite components (fed SHOWCASE data). Lane G imports these
// EXACT names + types.
// ===========================================================================

// Re-export the active-scene API + scene types so lane G (interceptor + stage)
// and the validate test import them from the one barrel.
export {
  resolveGalleryAppFetch,
  setActiveScene,
  getActiveScene,
} from "./scene";
export type { GalleryScene, GalleryEndpoint } from "./scene";
// SHOWCASE is imported above (used by the component registry); re-export the
// same binding so lane G can pull it from this barrel.
export { SHOWCASE };

// --- App-view entries ------------------------------------------------------

// Which REAL default-export page (or mirrored session stage) an app entry
// renders. The stage switches on this.
export type GalleryAppViewKey =
  | "dashboard"
  | "projects"
  | "project-detail"
  | "project-settings"
  | "looms"
  | "session-plain"
  | "session-empty"
  | "session-planner"
  | "settings-accounts";

// The mirrored-session-stage props (session-plain / -empty / -planner). Mirror
// of app/projects/[name]/sessions/[id]/page.tsx's server-computed wiring, passed
// as plain data (the client stage never imports the server registry/store).
export type GallerySessionSeed = {
  project: string;
  account: string;
  accounts: Array<{ name: string; displayTier?: string }>;
  initialChat?: InitialChat;
  initialTitle?: string;
  initialRole?: "planner";
  planner?: boolean;
  sessions: ChatSummary[];
  activeId: string;
};

export type GalleryAppEntry = {
  id: string; // "app-*" slug — disjoint from the 35 loom ids + every other entry
  label: string;
  description: string;
  view: GalleryAppViewKey;
  scene: GalleryScene; // set active BEFORE the child page's fetch effects run
  params?: Record<string, string>; // page params (e.g. { name: "aurora" })
  session?: GallerySessionSeed; // present only for the three session views
};

// --- Component-showcase entries --------------------------------------------

export type GalleryComponentKey =
  | "loom-card"
  | "state-badge"
  | "project-card"
  | "thread-tree"
  | "attempt-card"
  | "decision-log"
  | "verifier-report"
  | "gate-row"
  | "critic-cards"
  | "plan-graph"
  | "operator-card"
  | "charter-panel"
  | "acceptance-panel"
  | "blocked-escalation"
  | "discuss-escalation"
  | "permission-card"
  | "spec-bundle"
  | "agent-tabs"
  | "tool-step"
  | "status-sheet"
  | "page-header"
  | "empty-state"
  | "register-dialog"
  | "primitives";

export type GalleryComponentEntry = {
  id: string; // "cmp-*" slug — disjoint from every other entry
  label: string;
  description: string;
  component: GalleryComponentKey;
  variants: string[]; // labelled variant columns the stage renders
  scene?: GalleryScene; // set active only for entries whose component self-fetches
};

const A: GalleryAppEntry[] = [
  {
    id: "app-dashboard",
    label: "Dashboard",
    description: "Active looms + needs-attention + recent sessions + projects + plan usage.",
    view: "dashboard",
    scene: dashboardScene,
  },
  {
    id: "app-dashboard-idle",
    label: "Dashboard · idle",
    description: "No active looms (idle CTA), no sessions, projects present, no usage captured.",
    view: "dashboard",
    scene: dashboardIdleScene,
  },
  {
    id: "app-dashboard-error",
    label: "Dashboard · load error",
    description: "Looms + projects loads fail (500) → the dashboard's EmptyState error framing.",
    view: "dashboard",
    scene: dashboardErrorScene,
  },
  {
    id: "app-projects",
    label: "Projects index",
    description: "Healthy ProjectCards + a manifest-error ProjectErrorCard.",
    view: "projects",
    scene: projectsScene,
  },
  {
    id: "app-projects-empty",
    label: "Projects · empty",
    description: "No projects registered — the register CTA.",
    view: "projects",
    scene: projectsEmptyScene,
  },
  {
    id: "app-projects-error",
    label: "Projects · error",
    description: "Registry unreachable (500).",
    view: "projects",
    scene: projectsErrorScene,
  },
  {
    id: "app-project-detail",
    label: "Project detail",
    description: "Aurora: sessions + looms + the Manifest rail (gates / guardrails / urls / MCP health).",
    view: "project-detail",
    scene: projectDetailAuroraScene,
    params: { name: "aurora" },
  },
  {
    id: "app-project-detail-empty",
    label: "Project detail · empty",
    description: "Registered but no sessions and no looms yet (both empty states).",
    view: "project-detail",
    scene: projectDetailEmptyScene,
    params: { name: "finch" },
  },
  {
    id: "app-project-detail-missing",
    label: "Project detail · not found",
    description: "Unknown project → 'Project not found'.",
    view: "project-detail",
    scene: projectDetailMissingScene,
    params: { name: "finch" },
  },
  {
    id: "app-project-detail-manifest-error",
    label: "Project detail · manifest error",
    description: "Invalid telar.yaml → a destructive rail Alert.",
    view: "project-detail",
    scene: projectDetailManifestErrorScene,
    params: { name: "quill" },
  },
  {
    id: "app-project-settings",
    label: "Project settings",
    description: "Editable form + MCP servers (connected / needs-auth / stdio-local / disabled) + Permissions + Danger.",
    view: "project-settings",
    scene: projectSettingsScene,
    params: { name: "aurora" },
  },
  {
    id: "app-project-settings-manifest-error",
    label: "Project settings · manifest error",
    description: "Invalid manifest: the form is replaced by an Alert; MCP / Permissions / Danger still render.",
    view: "project-settings",
    scene: projectSettingsManifestErrorScene,
    params: { name: "quill" },
  },
  {
    id: "app-looms",
    label: "Looms index",
    description: "The LoomCard list across running / ready / done / needs-review / failed / blocked.",
    view: "looms",
    scene: loomsScene,
  },
  {
    id: "app-looms-empty",
    label: "Looms · empty",
    description: "No looms yet — the plan-a-loom CTA.",
    view: "looms",
    scene: loomsEmptyScene,
  },
  {
    id: "app-looms-error",
    label: "Looms · error",
    description: "Looms load error.",
    view: "looms",
    scene: loomsErrorScene,
  },
  {
    id: "app-session-plain",
    label: "Session · resumed",
    description: "A resumed project session (mirrored stage): transcript in the real SessionsRail + SessionView.",
    view: "session-plain",
    scene: {},
    session: sessionPlainSeed,
  },
  {
    id: "app-session-empty",
    label: "Session · new",
    description: "A fresh project session (mirrored stage): the empty 'Work in this repo' framing.",
    view: "session-empty",
    scene: {},
    session: sessionEmptySeed,
  },
  {
    id: "app-session-planner",
    label: "Session · planner",
    description: "A loom-planning session (mirrored stage): the Loom-Session banner + planner framing.",
    view: "session-planner",
    scene: {},
    session: sessionPlannerSeed,
  },
  {
    id: "app-settings-accounts",
    label: "Settings · accounts",
    description: "Global settings (mirrored stage): AccountsSettings with accounts + plan-limit meters + add-account.",
    view: "settings-accounts",
    scene: settingsAccountsScene,
  },
  {
    id: "app-settings-accounts-empty",
    label: "Settings · no usage",
    description: "Accounts present, 'No usage captured yet' (plan {}).",
    view: "settings-accounts",
    scene: settingsAccountsEmptyScene,
  },
];

// The register-dialog is the one showcase component whose flow self-fetches app
// endpoints (POST /api/browse for the native picker, POST /api/projects to
// register) — give it a scene so both are contained.
const registerDialogScene: GalleryScene = {
  browse: { body: { path: "/Users/you/code/petal" } },
  projects: { body: { projects: [] } },
  benignMutations: true,
};

const C: GalleryComponentEntry[] = [
  {
    id: "cmp-loom-card",
    label: "LoomCard",
    description: "Row / tile / needs-attention-with-error, across states.",
    component: "loom-card",
    variants: ["row", "tile", "needs-attention"],
  },
  {
    id: "cmp-state-badge",
    label: "StateBadge",
    description: "Every WorkUnitState (queued … done … failed … blocked).",
    component: "state-badge",
    variants: SHOWCASE.loomStates.map((l) => l.state),
  },
  {
    id: "cmp-project-card",
    label: "ProjectCard",
    description: "Healthy ProjectCard + manifest-error ProjectErrorCard.",
    component: "project-card",
    variants: ["healthy", "manifest-error"],
  },
  {
    id: "cmp-thread-tree",
    label: "ThreadTree",
    description: "A decomposition with children in mixed states + an orphaned sub-goal row.",
    component: "thread-tree",
    variants: ["mixed"],
  },
  {
    id: "cmp-attempt-card",
    label: "AttemptCard",
    description: "Running / passed-verdict / failed-with-blocker.",
    component: "attempt-card",
    variants: ["running", "passed", "failed"],
  },
  {
    id: "cmp-decision-log",
    label: "DecisionLog",
    description: "Plan / ok / fail / block / observe timeline dots.",
    component: "decision-log",
    variants: ["timeline"],
  },
  {
    id: "cmp-verifier-report",
    label: "VerifierReportCard",
    description: "Pass / fail + design findings + evidence image.",
    component: "verifier-report",
    variants: ["pass", "fail"],
  },
  {
    id: "cmp-gate-row",
    label: "GateRunRow",
    description: "Green pass / red fail / running / timed-out.",
    component: "gate-row",
    variants: ["pass", "fail", "running", "timed-out"],
  },
  {
    id: "cmp-critic-cards",
    label: "Critic rows",
    description: "CriticVerdictRow + CriticFindingRow: clean pass / blocking findings / advisory.",
    component: "critic-cards",
    variants: ["pass", "blocking", "advisory"],
  },
  {
    id: "cmp-plan-graph",
    label: "PlanGraph",
    description: "Nodes across pending / active / done (Plan derived via the real deriveGodView).",
    component: "plan-graph",
    variants: ["mixed"],
  },
  {
    id: "cmp-operator-card",
    label: "OperatorCard",
    description: "Running / done / failed / blocked / fan-out (Operator via the real deriveThreadOperator).",
    component: "operator-card",
    variants: ["running", "done", "failed", "blocked", "fan-out"],
  },
  {
    id: "cmp-charter-panel",
    label: "CharterPanel",
    description: "Full charter (decomposition / budget / scope) / absent.",
    component: "charter-panel",
    variants: ["full", "absent"],
  },
  {
    id: "cmp-acceptance-panel",
    label: "AcceptancePanel",
    description: "Directly acceptable / woven-gated / steer-open / reject-open + DoneConfirmation.",
    component: "acceptance-panel",
    variants: ["acceptable", "woven-gated", "steer", "reject"],
  },
  {
    id: "cmp-blocked-escalation",
    label: "BlockedEscalation",
    description: "BlockedEscalation + ParkExplanation + BlockedAnswerForm.",
    component: "blocked-escalation",
    variants: ["park", "answer"],
  },
  {
    id: "cmp-discuss-escalation",
    label: "DiscussEscalation",
    description: "The pre-discuss escalation surface.",
    component: "discuss-escalation",
    variants: ["pre-discuss"],
  },
  {
    id: "cmp-permission-card",
    label: "PermissionCard",
    description: "Pending (with narrow/broad rule options) / allowed / denied.",
    component: "permission-card",
    variants: ["pending", "allowed", "denied"],
  },
  {
    id: "cmp-spec-bundle",
    label: "SpecBundle",
    description: "SpecBundle + AssertionRow: contract present / synthesized / with contractErrors.",
    component: "spec-bundle",
    variants: ["contract", "synthesized", "errors"],
  },
  {
    id: "cmp-agent-tabs",
    label: "AgentTabsStrip",
    description: "Main + subagents, running / done / error, main-needs-attention.",
    component: "agent-tabs",
    variants: ["strip"],
  },
  {
    id: "cmp-tool-step",
    label: "ToolStepRow",
    description: "Read / edit / bash / task, plus a todo list.",
    component: "tool-step",
    variants: ["read", "edit", "bash", "task", "todo"],
  },
  {
    id: "cmp-status-sheet",
    label: "Status chips",
    description: "ProviderIcon + UsagePill + StatusBadge + HealthDot compact sheet.",
    component: "status-sheet",
    variants: ["sheet"],
  },
  {
    id: "cmp-page-header",
    label: "PageHeader",
    description: "Title-only / with description / with actions / with a leading back-link.",
    component: "page-header",
    variants: ["title", "description", "actions", "back"],
  },
  {
    id: "cmp-empty-state",
    label: "EmptyState",
    description: "Default / error (destructive icon) / with an action button.",
    component: "empty-state",
    variants: ["default", "error", "action"],
  },
  {
    id: "cmp-register-dialog",
    label: "RegisterProjectDialog",
    description: "Opened: browse (POST /api/browse) + register form (POST /api/projects), served by the scene.",
    component: "register-dialog",
    variants: ["open"],
    scene: registerDialogScene,
  },
  {
    id: "cmp-primitives",
    label: "UI primitives",
    description: "Button / Badge / Input / Textarea / Select / Dialog / Switch / Progress / Skeleton / Spinner / Alert / Tabs.",
    component: "primitives",
    variants: ["sheet"],
  },
];

export const GALLERY_APP_VIEWS: GalleryAppEntry[] = A;
export const GALLERY_COMPONENTS: GalleryComponentEntry[] = C;

const APP_BY_ID = new Map(GALLERY_APP_VIEWS.map((e) => [e.id, e]));
const CMP_BY_ID = new Map(GALLERY_COMPONENTS.map((e) => [e.id, e]));

export function getGalleryAppView(id: string): GalleryAppEntry | undefined {
  return APP_BY_ID.get(id);
}

export function getGalleryComponent(id: string): GalleryComponentEntry | undefined {
  return CMP_BY_ID.get(id);
}
