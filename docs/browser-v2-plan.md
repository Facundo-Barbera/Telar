# Browser integration v2 — audit, gaps, 1Password design, PR plan

Written 2026-09-03 against worktree branch `telar/browser-integration-v2-audit-gaps-vs-old-75c5b5`.
Research-only: nothing here is implemented. Where a question had no one to answer it, the
decision is stated inline and marked **DECIDED**.

## 0. What exists today (baseline, with receipts)

- **Engine-owned headless Chromium** via `@playwright/mcp`, spawned
  `--headless --isolated --browser chromium --image-responses allow --viewport-size …`
  (`apps/engine/src/browser/transport.ts:246-263`). `--isolated` ⇒ **no cookie/profile
  persistence**: every browser launch starts logged out.
- **One scope per session**, LRU pool of 6, busy scopes never evicted
  (`apps/engine/src/browser/index.ts:47`, `pool.ts`).
- **14 tools** (`apps/engine/src/browser/tools.ts:72-87`): `browser_list_tabs`, `browser_tabs`,
  `browser_navigate`, `browser_navigate_back`, `browser_snapshot`, `browser_click`,
  `browser_type`, `browser_fill_form`, `browser_select_option`, `browser_press_key`,
  `browser_hover`, `browser_take_screenshot`, `browser_console_messages`,
  `browser_network_requests`. The header comment (tools.ts:13-16) states the exclusions are
  deliberate: no `browser_evaluate`, no `browser_handle_dialog`, no file uploads.
- **Worker-hosted `telar-browser` MCP socket**, one per-turn bearer token, both providers
  (`apps/engine/src/browser/socket.ts`). Gate: reads declared `file_read` (auto-accept on the
  mode ladder), mutations `tool_call` (`apps/engine/src/worker.ts:314`,
  `packages/engine-client/src/protocol/requests.ts:147-159` `autoResolution`).
- **Cockpit panel**: tabs folded from journalled `browser.state.changed` + screenshot polling
  of the daemon's runtime; the live viewport is *deliberately absent*
  (`apps/web/components/right-panel.tsx:372-382`, `apps/engine/src/state.ts` `browserState`).
- **Desktop Electron host exists but is ORPHANED.** `apps/desktop/browser-manager.js` (915
  lines) still ships: per-scope `WebContentsView` tabs, agent-cursor DOM overlay with click
  ping (lines 675-728), persistent partition `persist:telar-integrated-browser` (line 269),
  hibernation + LRU, all 14 tools; served by `browser-control-server.js` (loopback + bearer).
  `main.js:425-428` hands `TELAR_DESKTOP_BROWSER_CONTROL_PORT/TOKEN` to the engine child —
  **and nothing in `apps/engine` reads those variables**. Agents always get headless; the
  human never sees the agent browse.
- `op` CLI: **not installed** on this machine. `/Applications/1Password.app` **is installed**,
  and its Chrome native-messaging manifest (`com.1password.1password.json`) exists. No sign-in
  or item read was attempted (audit only).

## 1. Inventory

Old Telar = the pre-engine stack: `apps/web_old/lib/{browser-mcp,server/browser-runtime,server/desktop-browser-host,use-controlled-browser}.ts` + `components/right-panel/browser-surface.tsx` (read at `bd6a1059^`), landed in `6422bdc0` (Aug 2), refined `1ac68050`, `16d18e66`; plus the Verifier path (`f422a0cb`, Jul 14; allowlist still visible at `packages/core/src/verifier.ts:22-37`). t3code = clone at `/tmp/t3code-ref` (Electron `<webview>` + CDP via `webContents.debugger`; tools `preview_*` in `apps/server/src/mcp/toolkits/preview/tools.ts`; engine `apps/desktop/src/preview/Manager.ts`).

| Capability | Old Telar | Current Telar | t3code | Proposed |
|---|---|---|---|---|
| Core nav/click/type/fill/snapshot | ✅ 14 tools (`browser-mcp.ts`) | ✅ same 14 (`tools.ts`) | ✅ `preview_*` (locators + raw x/y) | keep |
| Headless, detached-session browsing | ✅ (`browser-runtime.ts`, playwright-mcp) | ✅ engine-owned (`browser/index.ts`) | ❌ needs connected desktop host | keep — this is Telar's moat |
| Agent drives the **visible** desktop browser | ✅ broker routed to desktop host (`desktop-browser-host.ts`) | ❌ orphaned (env unread) | ✅ (`<webview>` is the browser) | **restore** (PR4) |
| Live viewport in cockpit / co-browsing | ✅ `browser-surface.tsx`: tab strip, URL bar, native viewport embed | ❌ screenshot polling only | ✅ always-interactive webview | **restore** (PR4) |
| Agent cursor overlay human can watch | ✅ desktop manager | ⚠️ code exists, unreachable | ✅ `AgentBrowserCursor.tsx` | restore via PR4 |
| Cookie/session persistence | ⚠️ desktop partition `persist:` only | ❌ `--isolated` | ✅ `persist:t3code-preview-<sha>` per profile | **per-session profile + named profiles** (PR2) |
| Multiple browser profiles | ❌ | ❌ | ✅ user-facing, 24 max (`browserProfile.ts`), not model-switchable | named profiles, human-assigned per session (PR2) |
| JS dialog handling | ✅ verifier only (`browser_handle_dialog`) | ❌ | ❌ | add (PR2) |
| `wait_for` | ✅ verifier only | ❌ | ✅ `preview_wait_for` | add (PR2) |
| File download | ❌ | ❌ | ❌ | **add → session attachments** (PR3) |
| File upload | ❌ | ❌ | ❌ | **add ← session attachments** (PR3) |
| JS evaluate | ✅ verifier only | ❌ (stated exclusion) | ✅ `preview_evaluate` (64 KB caps) | ❌ **DECIDED: keep excluded** — an eval is an unjournallable mutation and the secret-redaction story (§3) cannot survive it |
| Network capture | ⚠️ list (url/method/status) | ⚠️ same | ⚠️ same, no HAR | HAR-lite to attachments (PR5) |
| Request interception | ❌ | ❌ | ❌ | not planned |
| Video recording of a run | ❌ | ❌ | ✅ `preview_recording_*` (webm evidence artifact) | add via `--save-video` → attachments (PR5) |
| Human takeover / handback | ⚠️ human could always click the embedded view | ❌ | ⚠️ preemption + controller badge, no handoff tool (`Manager.ts` control epochs) | explicit control state + agent-visible errors (PR4) |
| Screenshot → model | ✅ | ✅ (`--image-responses allow`) | ✅ + parallel `interactiveElements[]` list | keep; snapshot refs already cover targeting |
| Approval gating per action | ⚠️ web-side `MUTATING_TOOLS` set, provider gate | ✅ journalled engine requests, reads auto-accept | ❌ none browser-specific (default thread mode is full access) | keep — already best-in-class |
| Password manager / secrets | ❌ | ❌ | ❌ (grep: zero hits) | **1Password path — §3, PR1** |
| Per-session isolation | ✅ scope broker (`16d18e66`) | ✅ scopeKey = sessionId | ⚠️ per-profile, not per-session | keep |

## 2. Gap list (ranked by user value)

1. **Credentials — the agent cannot log in to anything** (and with `--isolated`, stays logged
   out even after a human helps). Sketch: §3. — **L**
2. **Nobody can see the agent browse.** Wire the engine to the desktop control server that
   already ships (`TELAR_DESKTOP_BROWSER_CONTROL_*` → an `AttachedBrowser`-style capability
   preferred over headless when present); cockpit embeds the live viewport via the existing
   `telar:browser:*` IPC. — **L**
3. **No session persistence.** Drop `--isolated`; give each scope
   `--user-data-dir <sessionDir>/browser-profile`. — **S**
4. **No `browser_wait_for`.** Passthrough of the playwright-mcp tool ({text|textGone} only,
   never {time} — the verifier's own rule, `verifier.ts:30`). — **S**
5. **No dialog handling** — an `alert()`/`confirm()`/`beforeunload` wedges the tab silently.
   Passthrough `browser_handle_dialog` + surface the open dialog in snapshot output. — **S**
6. **No downloads.** Point playwright-mcp's output dir at the session, register finished
   downloads as session attachments + journal row. — **M**
7. **No uploads.** `browser_upload({attachmentId, target})`: resolve the session attachment's
   path (`state.ts:925`), forward to playwright-mcp `browser_file_upload`. — **S/M**
8. **No human-takeover contract.** Control state (`human|agent`) per scope; agent calls
   during human control return an `isError` result naming it; handback resumes. — **M**
9. **No run evidence** — video + HAR-lite for "what did the agent actually do". — **M**
10. **Codex roster asymmetry** (deferred-work 2026-08-29: no `strictMcpConfig` equivalent) —
    unchanged by this plan, noted for its owner. — n/a

## 3. 1Password design (the key section)

### Audit of routes

**(a) 1Password extension inside Electron — REJECTED, two independent hard blockers.**
Electron (repo pins `^43.1.1`, `apps/desktop/package.json`) supports only a DevTools-focused
subset of extension APIs via `session.loadExtension`; `chrome.runtime.connectNative` /
native messaging is not implemented ([Electron docs](https://www.electronjs.org/docs/latest/api/extensions),
[electron#7681](https://github.com/electron/electron/issues/7681),
[electron#8692](https://github.com/electron/electron/issues/8692)). Even with the
`electron-chrome-extensions` shim, 1Password's native-messaging host **verifies the calling
browser's code signature** and refuses unknown/unsigned Chromiums (`BrowserVerificationFailed`
— [1Password community](https://www.1password.community/discussions/1password/connect-to-additional-browsers-signed-chromium/83421),
[security whitepaper](https://support.1password.com/1password-browser-security/)). A Telar
build is not on that allowlist and never will be. And it would only ever cover the Electron
host — the engine's headless Chromium (the detached-session moat) gets nothing.

**(b) 1Password CLI (`op`) — VIABLE.** Desktop-app integration (`Settings → Developer →
Integrate with 1Password CLI`) lets `op` piggyback the app's unlock state; each read can
prompt Touch ID ([docs](https://developer.1password.com/docs/cli/app-integration/),
[biometric unlock](https://developer.1password.com/docs/cli/use-biometric-unlock/)).
`op item list --categories Login --format json` returns **metadata only** (title, vault,
`urls[]`); `op read "op://vault/item/field"` / `op item get <id> --fields … --reveal` return
the secret. Headless fallback: `OP_SERVICE_ACCOUNT_TOKEN` (service account — no biometric,
works detached). The `@1password/sdk` is service-accounts-only, so it cannot replace the CLI
for the interactive/biometric case; not needed in v1. This machine: app installed, CLI not —
so the feature must degrade gracefully when `op` is absent.

**(c) Universal Autofill — REJECTED.** It targets the frontmost focused macOS window and is
invoked by the user (⌘\); the engine's browser is a headless offscreen Chromium and the
Electron views are backgrounded `WebContentsView`s. Nothing to focus, nothing to invoke, no
programmatic API, no way to domain-bind. Not drivable.

**(d) Hybrid: CLI + a "Fill from 1Password" approval card — RECOMMENDED.** (b) supplies the
secret path; the cockpit card supplies item choice, so the agent only ever asked to "log in".
§3b (how Codex did it) does not change this recommendation: the only 1Password mechanism that
beats it — Secure Agentic Autofill, route (e) — is a closed early-access partnership, and
Codex's own integrated browser still has nothing.

### §3b. How Codex did it (audited 2026-09-03)

Three separate mechanisms, none of which is "1Password inside the agent's own browser":

1. **The Codex browser that has credentials is the user's real Chrome.** The app bundles a
   Chrome *plugin*: an extension pair + native-messaging host — verified locally at
   `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.openai.codexextension.json`
   pointing at `~/.codex/plugins/cache/openai-bundled/chrome/latest/extension-host/macos/arm64/
   "ChatGPT for Chrome"`. Because the driven browser is signed Chrome, **the user's own
   1Password extension simply keeps working** — Codex ships zero 1Password code (`strings`
   over the host binary: 0 hits for `1password|onepassword|op://|autofill|credential`).
   Credential moments are handled by *policy*, not code: the bundled `docs/confirmations.md`
   makes "final step: submit change password" a **hand-off-required** action ("ask the user
   to take over"), "save passwords in browser" always-confirm, and `docs/browser-safety.md`
   classes typing sensitive data into a form as transmission needing confirmation. So: human
   takes over the tab, human's extension fills, agent resumes.
2. **Codex's integrated browser has NO 1Password support.** The ask is an open, unanswered
   enhancement — [openai/codex#32081](https://github.com/openai/codex/issues/32081).
3. **For dev secrets (not web logins): the 1Password Environments MCP server** (May 2026,
   [1Password blog](https://1password.com/blog/1password-trusted-access-layer-for-openai-codex)).
   A local MCP server in 1Password's own tooling; the 1Password **desktop app is required**
   and authorizes **every access**; the MCP channel never carries values — 1Password injects
   variables into the target process env at runtime, so secrets never appear in code,
   terminals, or model context. This validates our §3 shape exactly (broker resolves at use
   time, model sees references only, desktop app is the trust anchor) — but it fills a
   process environment, not a login form.

**Route (e): 1Password Secure Agentic Autofill** ([developer page](https://www.1password.dev/agentic-autofill),
[Browserbase partnership, Oct 2025](https://siliconangle.com/2025/10/08/1password-tackles-ai-credential-risks-new-agentic-autofill-integration-browserbase/)):
the 1Password **extension running inside the agent's headless browser** performs the fill;
approval is a biometric prompt on the user's own 1Password desktop app; credentials travel
over a Noise-framework channel with forward-rotating keys, straight from vault to form —
the agent, the LLM, and the orchestrator never see them. **Honest comparison**: this is
architecturally safer than our CLI design (Telar's worker holds plaintext in memory for the
duration of the fill; under (e) nobody but 1Password does). But it is **early access,
Browserbase-only, no public API or SDK** — a third-party desktop app cannot adopt it today,
and the extension half would re-hit the Electron/native-messaging blockers of route (a) if
self-hosted. **DECIDED**: build (d) now with the §3 redaction guarantees as the compensating
control; keep the tool surface (`browser_fill_secret` with refs and kinds, values never in
args) unchanged so the executor can be swapped for Agentic Autofill if/when 1Password opens
it. PR4's visible browser additionally gives Telar the Codex-style fallback for free: the
human takes over the tab, fills with their own tools, hands back.

### The design (DECIDED)

**Model-facing tool** — one, added to `BROWSER_TOOLS`:

```
browser_fill_secret({
  fields: [{ target, element?, kind: "username" | "password" | "otp" | "field",
             field?: string }],          // field: 1P field label when kind="field"
  item?: string,                          // optional hint: item title or op:// ref
  submit?: { target }                     // optional: press this after filling
})
```

The model passes snapshot refs and *kinds*, never values. The tool result on success is prose:
`Filled username and password from "<item title>" on <origin>.` — no secret material.

**Resolution flow** (worker + daemon):
1. Socket receives the call; it is classified **not read-only** and additionally
   **never auto-resolvable** (below).
2. Engine reads the active tab's origin (from the scope's own tab state — not from model
   input; the model cannot lie about where the fill lands).
3. `op item list --categories Login --format json` → candidates whose `urls[]` match the tab
   origin by **registrable domain** (1Password's own rule). `item` hint reorders candidates;
   it never widens them.
4. Open an engine request — the existing `request` mechanism, new kind `secret_access`
   (`packages/engine-client/src/protocol/requests.ts`): `autoResolution()` returns `null` for
   it **in every mode, full-access included**, exactly like `user_input` (requests.ts:148).
   Detail carries: item candidates (title, vault, matched domain), tab origin, field kinds,
   and the domain-match verdict. iOS renders open requests already; a new kind + title is the
   only contract change it sees, and approving is all it needs to do.
5. Human picks a candidate and accepts (cockpit card shows item title + domain match badge;
   decline and cancel behave like any request).
6. Worker resolves values — `op item get <id> --format json --reveal` (or `op read` per
   field) — and forwards them inside a `browser_fill_form`/`browser_type` call **over the
   local stdio pipe to playwright-mcp**. Values exist in worker memory for the duration of
   the call and in the op→worker→playwright pipes. Then `submit` if given.

**Redaction guarantees** (each becomes a test in PR1):
- **Journal**: the request detail and the timeline row record `{item: title, fields:
  ["username","password"], origin}` — never a value. The `browser_fill_secret` args the model
  sent contain no values by construction.
- **Transcript / `content.delta` / model context**: the only thing that returns to the
  provider is the prose result above. The secret never enters any MCP result, so it cannot
  enter the provider's transcript.
- **Screenshots**: no screenshot is taken by the fill itself. Password inputs render masked
  by the page. `kind:"otp"` and visible text fields are the residual risk — the scope carries
  a `secretsFilledAt` mark and `browser_take_screenshot`/`browser_snapshot` results are
  allowed (they're how the model confirms login worked) but the **filled values are never
  echoed into snapshot text** because playwright snapshots render password inputs masked and
  we do not fill secrets into non-secret `kind:"field"` targets unless the human approved
  that exact field label on the card.
- **`browser_network_requests`** already returns url/method/status only — no bodies
  (playwright-mcp behavior; also true in old Telar and t3code). PR5's HAR-lite keeps that
  rule: no request bodies for any request within 30 s after a fill, ever, and no cookie
  headers at all.
- **No `browser_evaluate`** exists or will exist (§2) — the classic exfil hole stays closed.
- `op` is spawned with an explicit env (no inherited `OP_*` surprises), stdout parsed and
  dropped; nothing of it is logged.

**Domain binding**: an item fills only into a tab whose origin's registrable domain matches
one of the item's `urls[]`. Zero candidates ⇒ the card is never opened; the model gets
`isError`: `No 1Password Login item matches <origin>.` **DECIDED: no human override in v1**
(mismatched fill is 1Password's own refusal posture; an override card invites phishing-shaped
mistakes).

**Failure modes** (all `isError` results, never throws — socket.ts:236 rule):
- `op` not installed → `1Password CLI is not installed` + hint; no card.
- Vault locked / biometric declined / integration off → `op` exits non-zero → `1Password is
  locked or the CLI integration is disabled.` The card is opened only *after* metadata listing
  succeeds, so a locked vault fails fast without parking the session.
- Human declines the card → standard decline text.
- Tab navigated between approval and fill → origin re-checked at fill time; mismatch aborts
  with `The page changed while waiting for approval.`
- Detached/headless machine with no desktop app → works iff `OP_SERVICE_ACCOUNT_TOKEN` is
  configured for the engine (documented; no card-less path — the card still gates).

## 4. Surpass list (better than old Telar AND t3code)

1. **1Password fill with a human-gated item pick** — neither predecessor has any credential
   story (t3code grep: zero hits; old Telar: none).
2. **Per-session persistent browser profiles** — a session's logins survive turns and
   restarts (`--user-data-dir` per scope); t3code persists per *profile*, old Telar only in
   the one shared desktop partition; nobody scopes to the session.
3. **`browser_download` → session attachments** — downloads land in the session's existing
   attachments store with a journal row; absent in old, current, and t3code.
4. **`browser_upload` from session attachments** — closes the loop the other way; absent
   everywhere.
5. **Visible browser + agent cursor + explicit control handoff** — t3code has preemption but
   no handback contract and no approval trail; Telar gets controller state journalled, agent
   errors that *name* human control, and the human handing the tab back.
6. **Dialog handling** — absent in t3code entirely; old Telar had it only in the verifier.
7. **Run evidence: video + HAR-lite as attachments** — t3code's recording is a client-side
   `MediaRecorder` artifact; Telar's rides `--save-video`/network log into the journalled
   attachment store, so detached runs get it too.
8. **All of it detached** — every capability above works with no UI attached, which t3code
   structurally cannot do (its browser *is* the client).

## 5. PR sequence (each independently shippable)

**PR1 — `feat(engine,web): 1Password credential fill, human-gated`**
- `apps/engine/src/secrets/onepassword.ts` (new): `op` adapter — availability probe,
  `listLoginCandidates(origin)`, `readItemFields(id, fields)`; injected spawn seam.
- `packages/engine-client/src/protocol/requests.ts`: `secret_access` kind; `autoResolution`
  returns `null` for it in every mode. `items.ts`: `SecretAccessDetail`.
- `apps/engine/src/browser/tools.ts`: `browser_fill_secret` schema; `helpers.ts`: classified
  mutating; `apps/engine/src/worker.ts`: gate path opens `secret_access` with candidates;
  fill executes via the existing transport.
- `apps/web/components/approval-card.tsx`: card variant with item radio list + domain badge.
- Tests: op adapter (fake spawn: locked, missing, list, read); domain matcher (registrable
  domain, subdomain, mismatch); **redaction** (journal + request detail + tool result contain
  no value string, asserted against a sentinel secret); ladder (full-access still parks);
  socket lists the tool for both providers.

**PR2 — `feat(engine): browser profiles that persist, wait_for, dialogs`**
- `apps/engine/src/browser/transport.ts`: drop `--isolated`; `--user-data-dir` per scope
  under the session dir; option to keep `--isolated` for throwaway scopes.
- `tools.ts`: `browser_wait_for` ({text|textGone} only), `browser_handle_dialog`
  passthroughs; `helpers.ts` read-only classification (wait_for read-only; dialog mutating).
- Tests: transport args; profile dir per scope; tool passthrough + classification.

**PR3 — `feat(engine): downloads and uploads through session attachments`**
- `transport.ts`: `--output-dir` per scope; watch for completed downloads.
- `tools.ts`: `browser_upload({attachmentId, target})`; download registration →
  `state.ts` attachments index + journal event; result names the attachment id.
- Tests: download lands + indexed + journalled; upload resolves attachment path; traversal
  impossible (engine mints filenames, state.ts:925 precedent).

**PR4 — `feat(desktop,engine,web): the visible browser returns`**
- `apps/engine/src/drivers.ts` (+ new `browser/desktop.ts`): consume
  `TELAR_DESKTOP_BROWSER_CONTROL_{PORT,TOKEN}`; capability router prefers the desktop host
  when reachable, falls back headless; `apps/desktop/browser-manager.js`: control state
  (`human|agent`) + interrupt-on-human-input; cockpit: live viewport panel via existing
  `telar:browser:*` IPC + "hand it back" affordance.
- Tests: router fallback; manager control epochs (extend `browser-manager.test.js`);
  control-server auth already covered.

**PR5 — `feat(engine): run evidence — video and HAR-lite`**
- `transport.ts`: `--save-video` opt-in per scope; finalize into attachments on release.
- Network log: fold `browser_network_requests` history into a HAR-lite JSON attachment at
  turn end; enforce §3's no-bodies-near-secrets rule.
- Tests: artifacts appear as attachments; redaction window.

## Sources
- [Electron extension support](https://www.electronjs.org/docs/latest/api/extensions) · [electron#7681](https://github.com/electron/electron/issues/7681) · [electron#8692](https://github.com/electron/electron/issues/8692)
- [1Password browser security](https://support.1password.com/1password-browser-security/) · [signed-Chromium refusal](https://www.1password.community/discussions/1password/connect-to-additional-browsers-signed-chromium/83421)
- [op CLI app integration](https://developer.1password.com/docs/cli/app-integration/) · [biometric unlock](https://developer.1password.com/docs/cli/use-biometric-unlock/)
- [1Password × Codex (Environments MCP)](https://1password.com/blog/1password-trusted-access-layer-for-openai-codex) · [Secure Agentic Autofill](https://www.1password.dev/agentic-autofill) · [Browserbase partnership](https://siliconangle.com/2025/10/08/1password-tackles-ai-credential-risks-new-agentic-autofill-integration-browserbase/) · [openai/codex#32081](https://github.com/openai/codex/issues/32081)
