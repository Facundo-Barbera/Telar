# Telar-owned MCP OAuth login (Phase F)

**Status:** Draft for build · 2026-07-10
**Problem:** Some MCP servers (Supabase, GitHub, …) bind their OAuth login to the
*client that logged in*. When the agent SDK (Claude Code) does the login, the token
lands in **that account's** keychain — so switching Telar's execution account
(`personal` → `work`) loses the MCP session. Account switching breaks the MCP.
**Goal:** Telar owns the MCP OAuth login as the OAuth **client**, storing the token
in its **account-decoupled, project-scoped** secret store — so one login works for
every execution account and every agent SDK.
**Related:** `runtime-architecture.md` §B · `mcp.ts` · ROADMAP Phase F

---

## 1. Why this fits the existing architecture

`packages/core/src/mcp.ts` is already **the only place MCP tokens are read**, they
live under `mcp:<project>:<key>` in the secret store, and `resolveProjectMcpServers`
injects them into each server's headers **on their own path, never via the account**
(the decoupling is by construction). Today the token is a static string the user
pastes. This feature just changes **who fills it**: Telar's own OAuth client instead
of a paste or the SDK's account-bound login.

Because Telar injects a **valid `Authorization: Bearer` at the transport config**,
the server answers `200` and the underlying SDK **never triggers its own
account-bound OAuth** — Telar preempts it. That is what makes this work for *any
SDK* and *any execution account*.

## 2. The flexibility problem — a 3-tier client-identity ladder

The 2025-11-25 MCP spec made **DCR optional (`MAY`)**, **CIMD the default**, and
**pre-registration `SHOULD`**. Servers vary wildly (GitHub/Supabase/Entra/Slack do
NOT do DCR). Claude Code fails on them because it *only* does DCR. Telar resolves
client identity per server, trying in order — first that the AS supports wins:

1. **CIMD (Client ID Metadata Documents)** — Telar hosts a client-metadata document
   at a stable URL; the AS fetches it by URL. No registration call. Used when the AS
   advertises CIMD support. (Forward-looking; the new default.)
2. **DCR (RFC 7591)** — if AS metadata advertises a `registration_endpoint`, POST
   client metadata → get a `client_id` (+ maybe secret + `registration_access_token`).
   **Persist** it per (project, server) so we register once, not every connect.
3. **Manual / pre-registered** — the user supplies `client_id` (+ optional secret)
   configured once against the server's dashboard (like `mcp-remote`'s
   `--static-oauth-client-info`). The **guaranteed fallback** — this is what unblocks
   Supabase today.

## 3. Config schema (telar.yaml)

Extend the `http` variant of `McpServerConfig` (schemas.ts) with an optional `auth`:

```ts
auth?: {
  type: "oauth";
  scopes?: string[];
  // Manual/pre-registered fallback (tier 3). Absent → CIMD/DCR only.
  clientId?: string;
  clientSecret?: McpSecretRef;   // confidential clients only
  // Optional pins/overrides for servers with non-standard discovery:
  authorizationServer?: string;  // skip PRM discovery, use this issuer
  redirectPath?: string;         // default "/api/mcp/oauth/callback"
};
```

**OAuth is auto-detected, not declared** (this is how VS Code / Cursor / Claude
Code work). Telar probes an http server (`probeMcpAuth`); a `401` + `WWW-Authenticate`
(or a resolvable PRM well-known) means it needs OAuth, and the UI surfaces **Connect**
automatically — no yaml `auth` block and no toggle required. The `auth` block above is
**optional overrides only**: a manual `clientId` fallback for when DCR/CIMD aren't
available (tier 3), plus `scopes` / `authorizationServer` pins. Its absence does NOT
disable OAuth. **Injection is keyed on a stored OAuth record**, not on the block: once
connected, `resolveProjectMcpServers` auto-injects `Authorization: Bearer <token>`
(never over an explicit header). Static `{ secret }` headers stay for non-OAuth
servers, unchanged.

## 4. Stored OAuth record

Kept out of `telar.yaml` (secret-free), in the secret store / a sibling JSON under
`~/.telar/`, keyed `mcp-oauth:<project>:<server>`:

```ts
type McpOAuthRecord = {
  project: string; server: string;
  resource: string;                 // canonical MCP server URI (RFC 8707 audience)
  as: { issuer: string; authorizationEndpoint: string; tokenEndpoint: string;
        registrationEndpoint?: string; supportsCimd?: boolean };
  client: { strategy: "cimd" | "dcr" | "manual"; id: string; secret?: string;
            registrationAccessToken?: string };
  tokens: { accessToken: string; refreshToken?: string; expiresAt?: number; scope?: string };
};
```
The live access token is mirrored to `mcp:<project>:<server>` so the existing
resolver keeps working untouched.

## 5. Flow

**Connect (once, in the browser):**
1. Probe the MCP server → `401` + `WWW-Authenticate` → fetch
   `/.well-known/oauth-protected-resource` (RFC 9728) → get `authorization_servers`.
   (Honor `auth.authorizationServer` override when discovery is nonstandard.)
2. Fetch AS metadata (RFC 8414). Resolve client identity via the §2 ladder.
3. PKCE (S256) auth-code: open the browser to the authorization endpoint with
   `code_challenge`, `state`, and the **`resource`** param (RFC 8707) = the canonical
   server URI. Redirect URI = `http://localhost:3131/api/mcp/oauth/callback`
   (localhost is spec-allowed).
4. Callback exchanges `code` + `code_verifier` (+ `resource`) at the token endpoint →
   access + refresh token → write `McpOAuthRecord` + mirror the access token.

**Use / refresh (every loom & session, any account):** `resolveProjectMcpServers`
injects the current access token. Before injecting, if `expiresAt` is within a small
window, refresh via `refreshToken` at the token endpoint and update the record.
(Requires making the MCP-materialization path async; dispatcher/executor already
await.) No background daemon until Phase C.

## 6. Security guardrails (from the spec)

- PKCE S256 mandatory; `state` validated; exact redirect-URI match.
- Validate the token **audience is this server** (`resource` / RFC 8707) — never a
  passthrough of some other token.
- Short-lived access tokens + refresh rotation for public clients.
- Secrets never enter `telar.yaml`; tokens live only in the secret store.

## 7. Build plan

**Stage A — core OAuth engine (no UI):**
- [ ] `schemas.ts`: add the `auth` block to the http `McpServerConfig`.
- [ ] `mcp-oauth.ts`: PRM/AS discovery, the CIMD→DCR→manual client ladder, PKCE
      helpers, auth-URL builder, code→token exchange, refresh; `McpOAuthRecord` store.
- [ ] `mcp.ts`: async materialization + refresh-on-resolve; auto-inject `Authorization`
      for `auth.type === "oauth"` servers.
- [ ] Unit tests with mocked fetch: discovery parsing, each client tier, PKCE,
      token/refresh, audience validation, expiry→refresh.

**Stage B — web connect flow + UI:**
- [ ] `GET /api/mcp/oauth/callback` (code exchange) + a connect-initiation route.
- [ ] "Connect" / "Reconnect" / "Disconnect" buttons per OAuth server in MCP settings
      (reuse the `declaredMcpSecretKeys`-driven UI), showing connected/expired state.
- [ ] Live-test against Supabase's MCP (manual `client_id` tier).

**Unblocks:** reliable MCP-backed verification inside looms (e.g. Supabase DB checks)
across every account — foundational for the moat.
