// GALLERY (delete with /gallery) — the STORY SPINE for the app-view scenes plus
// the projects-index + project-detail scenes. The two-project convention
// (finch = a semver library; aurora = an analytics web app) from the 35 loom
// bundles carries through here: the same projects, accounts, and sessions appear
// on the dashboard, the project pages, the sessions, and the settings usage — so
// clicking between entries reads as ONE coherent workspace. Every shape is the
// EXACT wire body its real route emits (see resolveGalleryAppFetch).
import type { GalleryScene } from "../../scene";
import {
  at,
  makeAccount,
  makeChatSummary,
  makeManifest,
  makePlanSnapshot,
  makePlanWindow,
  makeProjectEntry,
} from "../../builders";
import { allLooms, auroraLooms, finchLooms } from "./looms";

// --- Manifests -------------------------------------------------------------

// finch — a plain TS semver library. No dev server (a library), a test gate +
// typecheck gate, and a verifyCommand (proves the deliverable without a server).
export const finchManifest = makeManifest({
  name: "finch",
  root: "/Users/you/code/finch",
  account: "personal",
  gates: [
    { name: "test", run: "bun test" },
    { name: "typecheck", run: "tsc --noEmit" },
  ],
  guardrails: { disallowedTools: ["WebFetch"], protectedPaths: ["src/version.ts"] },
  verifyCommand: "bun test",
});

// aurora — a Next.js analytics dashboard. Has a dev server + urls, and a rich
// per-project MCP set spanning every OAuth state the settings/detail surfaces
// render: connected (linear), needs-auth (sentry), stdio-local (postgres),
// disabled (figma, enabled:false).
export const auroraManifest = makeManifest({
  name: "aurora",
  root: "/Users/you/code/aurora",
  account: "work",
  baseBranch: "main",
  gates: [
    { name: "test", run: "bun test" },
    { name: "lint", run: "bun run lint" },
  ],
  guardrails: { disallowedTools: [], protectedPaths: ["prisma/schema.prisma"] },
  urls: { dev: "http://localhost:3000", prod: "https://aurora.example.com" },
  devCommand: "bun run dev",
  mcpServers: {
    linear: {
      transport: "http",
      url: "https://mcp.linear.app/sse",
      auth: { type: "oauth", scopes: ["read", "write"] },
    },
    sentry: {
      transport: "http",
      url: "https://mcp.sentry.dev/sse",
      auth: { type: "oauth" },
    },
    postgres: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-postgres", "postgres://localhost/aurora"],
    },
    figma: {
      transport: "http",
      url: "https://mcp.figma.com/sse",
      auth: { type: "oauth" },
      enabled: false,
    },
  },
});

// --- Project rows (/api/projects) ------------------------------------------

export const finchRow = makeProjectEntry({
  name: "finch",
  root: "/Users/you/code/finch",
  manifest: finchManifest,
});

export const auroraRow = makeProjectEntry({
  name: "aurora",
  root: "/Users/you/code/aurora",
  manifest: auroraManifest,
});

// A registered project whose telar.yaml failed to parse — manifest:null + a
// message (exactly what listProjects returns on a bad manifest).
export const brokenRow = makeProjectEntry({
  name: "quill",
  root: "/Users/you/code/quill",
  manifest: null,
  error: "telar.yaml: `gates` must be an array of { name, run } — got a string at gates[0].",
});

// --- Accounts (/api/accounts) ----------------------------------------------

export const accountsList = [
  makeAccount({ name: "personal", displayTier: "Max 20x" }),
  makeAccount({ name: "work", provider: "claude", displayTier: "Team" }),
  makeAccount({ name: "codex", provider: "codex", authMode: "api-key", tokenEnv: "OPENAI_API_KEY" }),
];

export const accountsScene = {
  body: { accounts: accountsList, default: "personal" },
};

// --- Plan usage (/api/usage) -----------------------------------------------

export const planByAccount: Record<string, ReturnType<typeof makePlanSnapshot>> = {
  personal: makePlanSnapshot({
    subscriptionType: "max",
    fiveHour: makePlanWindow({ utilization: 38 }),
    sevenDay: makePlanWindow({ utilization: 54, resets_at: new Date(at(500_000)).toISOString() }),
    sevenDayOpus: makePlanWindow({ utilization: 72, resets_at: new Date(at(500_000)).toISOString() }),
  }),
  work: makePlanSnapshot({
    subscriptionType: "team",
    fiveHour: makePlanWindow({ utilization: 12 }),
    sevenDay: makePlanWindow({ utilization: 29, resets_at: new Date(at(600_000)).toISOString() }),
  }),
};

export const usageScene = { body: { plan: planByAccount, ledger: [] as unknown[] } };

// --- Chats (/api/chats) ----------------------------------------------------

export const finchChats = [
  makeChatSummary({
    id: "gallery__chat-finch-1",
    project: "finch",
    account: "personal",
    title: "Wire range-satisfies into the comparator",
    preview: "Added satisfies(version, range) with ^, ~ and hyphen-range support; all comparator tests green.",
    createdAt: at(-4000),
    updatedAt: at(-200),
    costUsd: 0.42,
    turns: 9,
  }),
  makeChatSummary({
    id: "gallery__chat-finch-2",
    project: "finch",
    account: "personal",
    title: "Prerelease precedence bug",
    preview: "Traced 1.0.0-rc.1 sorting above 1.0.0 to a missing prerelease branch in compareIdentifiers.",
    createdAt: at(-9000),
    updatedAt: at(-8600),
    costUsd: 0.18,
    turns: 4,
  }),
];

export const auroraChats = [
  makeChatSummary({
    id: "gallery__chat-aurora-1",
    project: "aurora",
    account: "work",
    title: "Cohort retention heatmap",
    preview: "Sketching the weekly cohort-retention grid for the overview page; leaning on the existing chart primitives.",
    createdAt: at(-3600),
    updatedAt: at(-120),
    costUsd: 1.87,
    turns: 21,
  }),
];

// The dashboard's "recent sessions" is a cross-project mix, newest-first.
export const recentChats = [auroraChats[0]!, finchChats[0]!, finchChats[1]!];

// --- MCP status + tokens (project detail / settings) -----------------------

// /api/mcp/oauth/status wire shape: { servers: { [name]: HttpStatus } }. Only
// http servers appear; stdio (postgres) is absent (rendered "Local" from
// transport). figma is disabled so it isn't probed.
export const auroraMcpStatusScene = {
  body: {
    servers: {
      linear: { requiresOAuth: true, connected: true, health: "connected" as const },
      sentry: { requiresOAuth: true, connected: false, health: "needs-auth" as const },
    },
  },
};

// /api/projects/<n>/mcp — which servers hold a stored manual token.
export const auroraMcpTokensScene = { body: { tokens: { linear: true, sentry: false } } };

// /api/permissions/<p> — persisted "always allow" rules for aurora.
export const auroraPermissionsScene = {
  body: {
    rules: [
      "Bash(bun test:*)",
      "Read(//Users/you/code/aurora/**)",
      "Edit(//Users/you/code/aurora/app/**)",
    ],
  },
};

export const finchPermissionsScene = { body: { rules: ["Bash(bun test:*)"] } };

// ---------------------------------------------------------------------------
// SCENES — projects index + project detail.
// ---------------------------------------------------------------------------

// Projects index — a healthy pair + a manifest-error row.
export const projectsScene: GalleryScene = {
  projects: { body: { projects: [finchRow, auroraRow, brokenRow] } },
};

export const projectsEmptyScene: GalleryScene = {
  projects: { body: { projects: [] } },
};

export const projectsErrorScene: GalleryScene = {
  projects: { body: { projects: [] }, status: 500 },
};

// Project detail (finch): the page fetches /api/projects (finds finch),
// /api/chats?project=finch, /api/looms (filters to finch), and the Manifest
// rail's ManifestCard fetches /api/mcp/oauth/status.
export const projectDetailScene: GalleryScene = {
  projects: { body: { projects: [finchRow, auroraRow] } },
  chats: { body: { chats: finchChats } },
  looms: { body: { looms: finchLooms, active: [] } },
  mcpStatus: { body: { servers: {} } },
};

// Aurora detail — exercises the MCP health rail (connected + needs-auth dots).
export const projectDetailAuroraScene: GalleryScene = {
  projects: { body: { projects: [finchRow, auroraRow] } },
  chats: { body: { chats: auroraChats } },
  looms: { body: { looms: auroraLooms, active: [] } },
  mcpStatus: auroraMcpStatusScene,
};

export const projectDetailEmptyScene: GalleryScene = {
  projects: { body: { projects: [finchRow] } },
  chats: { body: { chats: [] } },
  looms: { body: { looms: [], active: [] } },
  mcpStatus: { body: { servers: {} } },
};

export const projectDetailMissingScene: GalleryScene = {
  projects: { body: { projects: [auroraRow] } }, // finch absent → "Project not found"
  chats: { body: { chats: [] } },
  looms: { body: { looms: allLooms, active: [] } },
  mcpStatus: { body: { servers: {} } },
};

export const projectDetailManifestErrorScene: GalleryScene = {
  projects: { body: { projects: [brokenRow] } },
  chats: { body: { chats: [] } },
  looms: { body: { looms: [], active: [] } },
  mcpStatus: { body: { servers: {} } },
};
