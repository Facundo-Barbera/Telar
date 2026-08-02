// GALLERY (delete with /gallery) — dashboard (app/page.tsx) scenes. The
// dashboard self-fetches /api/looms, /api/projects, /api/chats, /api/usage; each
// variant below answers all four so the REAL DashboardPage renders populated,
// idle, or error framing with no server contact.
import type { GalleryScene } from "../../scene";
import { allLooms, activeLoomIds } from "./looms";
import { finchRow, auroraRow, recentChats, usageScene } from "./projects";

// Populated: active looms + needs-attention + recent sessions + projects + usage.
export const dashboardScene: GalleryScene = {
  looms: { body: { looms: allLooms, active: activeLoomIds } },
  projects: { body: { projects: [finchRow, auroraRow] } },
  chats: { body: { chats: recentChats } },
  usage: usageScene,
};

// Idle: no active looms (idle CTA), no sessions (plan-something empty), projects
// present, no usage captured.
export const dashboardIdleScene: GalleryScene = {
  looms: { body: { looms: [], active: [] } },
  projects: { body: { projects: [finchRow, auroraRow] } },
  chats: { body: { chats: [] } },
  usage: { body: { ledger: { session: {}, weekly: {}, byAccount: {} } } },
};

// Error: both the looms and projects loads fail (500 → the page's EmptyState
// error surfaces).
export const dashboardErrorScene: GalleryScene = {
  looms: { body: { looms: [], active: [] }, status: 500 },
  projects: { body: { projects: [] }, status: 500 },
  chats: { body: { chats: [] } },
  usage: { body: { ledger: { session: {}, weekly: {}, byAccount: {} } } },
};
