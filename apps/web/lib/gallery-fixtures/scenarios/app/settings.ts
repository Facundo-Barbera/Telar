// GALLERY (delete with /gallery) — project-settings + global-accounts scenes.
//
// ProjectSettings (settings-view.tsx) fetches /api/projects (the manifest form),
// /api/accounts (the account picker), /api/projects/<n>/mcp (stored tokens),
// /api/mcp/oauth/status (OAuth/liveness), and /api/permissions/<p> (always-allow
// rules); DELETE (danger zone) is benign. The aurora scene wires the full MCP
// OAuth spread (connected / needs-auth / stdio-local / disabled). The global
// settings page mirrors PageHeader + AccountsSettings, which fetches /api/accounts
// + /api/usage.
import type { GalleryScene } from "../../scene";
import {
  accountsScene,
  auroraMcpStatusScene,
  auroraMcpTokensScene,
  auroraPermissionsScene,
  auroraRow,
  brokenRow,
  finchRow,
  usageScene,
} from "./projects";

// Project settings (aurora) — editable form + the rich MCP servers card +
// permissions + danger.
export const projectSettingsScene: GalleryScene = {
  projects: { body: { projects: [finchRow, auroraRow] } },
  accounts: accountsScene,
  mcpTokens: auroraMcpTokensScene,
  mcpStatus: auroraMcpStatusScene,
  permissions: auroraPermissionsScene,
};

// Project settings, invalid manifest — the form is replaced by a destructive
// Alert, but MCP / Permissions / Danger still render (manifest:null row).
export const projectSettingsManifestErrorScene: GalleryScene = {
  projects: { body: { projects: [brokenRow] } },
  accounts: accountsScene,
  mcpTokens: { body: { tokens: {} } },
  mcpStatus: { body: { servers: {} } },
  permissions: { body: { rules: [] } },
};

// Global settings — accounts + plan-limit meters + add-account form.
export const settingsAccountsScene: GalleryScene = {
  accounts: accountsScene,
  usage: usageScene,
};

// Global settings, no usage captured yet — accounts present, plan {} (the
// "No usage captured yet" empty framing).
export const settingsAccountsEmptyScene: GalleryScene = {
  accounts: accountsScene,
  usage: { body: { plan: {}, ledger: [] } },
};
