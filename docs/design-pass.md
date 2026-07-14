# Design pass — view-by-view upgrade log

Working session: the product owner walks /gallery entry by entry with the
orchestrator; per view we log what to upgrade. Items are batched into upgrade
rounds (workflow-built, adversarially verified — prod behavior and the moat
never regress). Bigger redesign ideas become MOCK VARIANTS in the gallery
(fixture-backed, clearly labeled) so alternatives can be compared side by side
before any prod change.

Format per entry:
- **view:** gallery entry id
- **verdict:** keep / polish / rework / mock-alternative
- **items:** concrete changes (copy, layout, hierarchy, affordances, states)
- **round:** which upgrade round shipped it (filled when landed)

---

## Round: /demo-gallery walkthrough (UI v2 proposals, 2026-07-13)

- **view:** chat-working-indicator (1.4)
- **verdict:** polish
- **items:** light-theme panel — shimmer labels ("Starting turn", "Thinking",
  "Running Bash") wash out to near-invisible; production Shimmer gradient is
  dark-tuned, not token-driven. Lane-local theme-aware shimmer dispatched;
  production Shimmer needs the same tokenization when the design ships.
- **round:** demo-gallery round 1 — landed fc7d86c

- **view:** chat-session-cost (1.6)
- **verdict:** rework
- **items:** (a) breakdown must open on HOVER as a floating anchored overlay —
  click-to-expand inline reflows the whole bar/UI, rejected; click may pin.
  (b) same light-panel washout on the breakdown rows as 1.4 — fix legibility.
- **round:** demo-gallery round 1 — landed fc7d86c

- **view:** sidebar-full / account wheels (3)
- **verdict:** keep + polish ("love it, great UI" — owner)
- **items:** account wheels: (a) grab-and-drop reorder so the owner chooses
  display order (real persistence = settings fact when it ships); (b) COMPACT
  mode as DEFAULT — only the wheels, horizontal row; expand reveals per-account
  detail; reorder works in compact too.
- **round:** demo-gallery round 1 — landed fc7d86c (new focused entry:
  sidebar-account-wheels)

- **view:** CTX pill (session bar) — new idea (owner)
- **verdict:** new entry
- **items:** Claude Code /context equivalent as a HOVER on the CTX label:
  anchored overlay (same grammar as the 1.6 cost hover — hover opens, click
  pins, zero reflow) showing context-window composition: system prompt, tools/
  MCP, memory files, messages, free space, autocompact threshold — token
  counts + percentages + segmented usage bar.
- **round:** demo-gallery round 2 — landed ae3c97d (new entry:
  chat-context-breakdown; CTX pill in the session-bar demo now carries the
  hover)

- **view:** sidebar-account-wheels (compact row)
- **verdict:** polish
- **items:** keep the production hover effects on the wheels — per-wheel hover
  detail (account · plan, 5h/weekly usage) in ALL modes (compact row, expanded
  list, collapsed rail); must coexist with the grab/drag affordance.
- **round:** demo-gallery round 3 — landed 84c6671 (WheelTip in all three
  modes, hidden while dragging; mirrors production PlanRing tooltip content)

- **view:** sidebar-account-wheels — WheelTip placement ("not ideal", owner)
- **verdict:** polish
- **items:** compact-row tooltip renders ON TOP of the wheel strip and
  collides with the sidebar row above; must float clear of the anchor (above
  the strip with a gap, or outside the sidebar edge), never covering the
  hovered wheel, its siblings, or adjacent sidebar items; no clipping at the
  sidebar boundary.
- **round:** demo-gallery round 4 — landed 2ab4b16 (fixed-position
  collision-aware tip: top-side in compact/expanded, right-side outside the
  rail)

- **view:** chat-working-indicator light panel — REGRESSION ("white mode",
  owner, 2nd report)
- **verdict:** rework (fix must be structural this time)
- **items:** round-1 theme-aware shimmer did NOT hold: light panel still shows
  washed-out shimmer labels while plain text flips fine. The shimmer must
  derive color from the same mechanism as normal text (class-based/
  currentColor; e.g. solid class-colored text + animated mask sweep), never
  from vars resolved outside the panel scope. Legible at every animation
  phase in both panels; audit every chat-lane shimmer usage.
- **round:** demo-gallery round 5 — landed 4c6aec0. TRUE root cause:
  background-clip:text + color:transparent ignores element color AND WebKit
  does not re-resolve inherited inline var overrides inside the clipped
  gradient — mechanism failure, unfixable by token swaps. New shimmer = solid
  class-colored base text + aria-hidden foreground copy revealed by a moving
  mask (additive only; every failure mode legible). Production Shimmer needs
  the same rework at product-wiring time.
  3rd report + live-DOM probe (getComputedStyle): the masked shimmer VERIFIES
  correct; the still-washed elements are un-classed tool-name spans
  ("shrink-0 font-medium") computing lab(98.26) inside the light panel —
  inherited computed white from the dark shell, because theme-panel wrappers
  inject vars but never re-declare `color`. Round 6 = structural: every
  theme wrapper (all lanes) sets text-foreground; probe re-run to confirm.
  LESSON for walkthrough rounds: visual/DOM verification, not tsc, closes
  display bugs.
  Round 6 landed c70fa7a; probe re-run CONFIRMS: light-panel spans now
  compute oklch(0.145), dark-shell spans lab(98.26). Closed.

- **view:** sidebar-account-wheels compact strip — hover regressions (owner)
- **verdict:** polish
- **items:** (a) hover GripVertical icon must NOT appear over compact wheels —
  grab the wheel directly (cursor-grab only); (b) the hover tooltip stopped
  opening after the round-4 WheelTip rewrite — restore; (c) remove the hover
  lift (wheel animates upward). Expanded rows may keep their grip handle.
- **round:** demo-gallery round 7 — landed c07d297, probe-verified (0 grip
  icons, 0 lift classes, tip opens on-screen via pointerover). Root cause of
  (b): the round-3 hover-lift transform made the ancestor the containing
  block for the fixed-position tip — hover re-based its coords off-screen.
  LESSON: no transforms on ancestors of fixed-position overlays.

- **view:** sidebar-account-wheels compact strip — hover halo offset (owner)
- **verdict:** polish
- **items:** "shadow below the circle" on hover = the rounded-full wrapper
  lays the wheel out as inline content, reserving descender space, so the
  hover:bg-sidebar-accent halo is taller than the wheel and pokes out below.
  Fix: flex-center the wrapper (kill baseline gap) so the halo is concentric.
- **round:** demo-gallery round 8 — landed 0946174, probe-verified: wrapper
  34px = svg 30px + p-0.5 padding exactly, display:flex; halo concentric.
  Rail wrapper had the same gap and got the same fix.

- **view:** chat-subagent-lifecycle / chat-subagent-tray (1.1)
- **verdict:** mock-alternative (owner request)
- **items:** build a full SESSION BLOCK with the 1.1 treatments in context —
  a realistic agent turn (message, thinking, tool steps) where sub-agent
  tasks spawn mid-turn, complete, and dismiss; variant A (graceful dismiss →
  done pill) and variant B (docked tray) switchable in place; replayable.
- **round:** demo-gallery round 9 (in flight)

- **view:** chat-session-cost session bar (1.6 + CTX)
- **verdict:** polish
- **items:** (a) CTX and cost pills sit at different heights — align them
  (same height/baseline in the bar); (b) both breakdowns are hover-triggered
  now, so the expand chevron (down arrow) on the pill(s) is a stale
  affordance — remove it wherever it appears on the CTX/cost pills.
- **round:** rounds 10+12 — chevron removed 9f0cd3d; alignment fixed bb74aa5
  (round 10 audited badge classes and missed it — the offset lived in the
  WRAPPERS' cross-axis alignment; round 12 fixed from probe measurements,
  re-probe confirms both badges at identical top/height).

- **view:** 1.1 REFRAME (owner): target is the AGENT TAB STRIP, not chips
- **verdict:** rework (re-purpose, don't rebuild)
- **items:** 1.1's "lingering sub-agent tasks" = the top bar of agent tabs
  (Main | <task> | <task> …) that stays cluttered after sub-agents complete.
  Re-purpose the built treatments onto that strip: running sub-agents appear
  as tabs (switchable, live); on completion a tab gracefully dismisses into
  an expandable "N done" pill at the strip end (variant A) or an overflow
  tray (variant B). Transcripts stay reachable via the pill/tray — tabs are
  navigation, not ephemera. Session block gets the strip in its header so
  the in-context judgment targets the right surface.
- **round:** demo-gallery round 11 — landed c9d3b65. SubagentTabStrip mirrors
  production agent-tabs.tsx anatomy (Main first, truncated titles, roving
  tabIndex); running tabs live/switchable, done tabs collapse into the
  strip-end pill (A) or overflow tray (B), FAILED tabs stay pinned; session
  block header now carries the strip, A/B switch swaps strip treatment.

- **view:** 1.1 tab strip (post-round-11) — owner feedback
- **verdict:** polish + new variant
- **items:** (a) the strip lost the previous chips' informative animations —
  a regression in feel ("not bad, but could be a bit better"): bring the chip
  choreography into the tabs (spawn animation, pulsing status mark, live
  elapsed, settle→collapse dismiss into the pill); (b) NEW VARIANT C: a
  session SIDEBAR for sub-agents — right rail with rich animated cards
  (status, title, elapsed, activity), completed settle into a history
  section, click → transcript; add to session block switch as A/B/C.
- **round:** demo-gallery round 13 (in flight)

- **view:** 1.1 DECISION (owner): variant C — SESSION SIDEBAR wins
- **verdict:** keep (C chosen; strip variants A/B retired for 1.1)
- **items:** one gap: no simple way back to the MAIN chat from a sub-agent
  transcript. Add a pinned "Main" row at the top of the rail (always visible,
  highlighted when active) + a back affordance on the transcript view itself
  (banner/breadcrumb "viewing <agent> — back to main", Esc returns).
- **round:** demo-gallery round 14 — landed d1dc600 (pinned MainRow anchor,
  SubagentBanner breadcrumb w/ Esc, Main reachable from collapsed edge; A/B
  entries marked retired).

- **view:** loom-started notification banner (session view) — owner request
- **verdict:** rework (proposals wanted)
- **items:** the persistent "Loom started … View god-view [×]" banner solves a
  momentary event with permanent chrome and never reflects the loom's actual
  state. Variants to judge: A) live loom PILL in the session bar (hover =
  status overlay w/ threads/gates + god-view link; tone follows state —
  amber on park, green on ready = doctrine touchpoints surfaced); B) inline
  event row in-stream at the start turn (scrolls away); C) docked live card,
  collapsible to the pill, re-expands highlighted on escalation/ready.
  Recommendation: A (+B as the historical record).
  MULTI-LOOM addendum (owner): design for N looms per session from the start.
  A = ONE aggregate pill (count + most-urgent rollup, tone = max urgency,
  hover lists each loom as a row); B = rows carry loom short-ids, N is
  natural; C = cards stack into a tray, only the escalating loom re-expands.
  Demo timelines spawn a 2nd loom mid-run to show the rollup.
- **round:** demo-gallery round 15 — landed 30c2355 (loom-notify-pill /
  -inline / -card; shared replayable timeline incl. 2nd loom spawn at ~3.6s;
  aggregate pill reuses the zero-reflow hover grammar; awaiting owner pick).
  Owner: "I like it but we should not show data of the loom right now since
  we are still shaping it" — round 16 strips loom internals (thread dots,
  gate mini-bars, activity lines) from all three variants: state word +
  title/short-id + elapsed + god-view link only; tone/rollup stay; overlay
  reserves the slot for richer data post loom-UI design.
  Round 16 landed b7cbaa8 (models stripped, MiniBar/ThreadDots removed,
  reserved placeholder line in the overlay).

- **view:** PROJECT VIEW (per-project hub) — owner: "we forgot one important
  view"
- **verdict:** new design round (round 17) — never covered by any lane
- **items:** redesign the project page (sessions list + detail, New session,
  looms of the project) in the new UI-v2 language: density, search-first,
  grouping, hover pills, scroll reduction; harmonize with the applied lists/
  sidebar. Two labeled variants for owner verdict, then a follow-up apply.
- **round:** demo-gallery round 17 — landed 1565ea3 (project-hub-a
  work-first / project-hub-b command view; awaiting owner verdict, then a
  follow-up apply for the winner).
  OWNER VERDICT: neither fully — HYBRID (round 19, project-hub-c): B's TABS
  structure + A's visually-appealing dense grouped list; sessions and looms
  NOT mixed (separate tabs); NO right-side preview pane (context too hard to
  gather); SETTINGS becomes a tab on the project page (fold the concern-4
  project-settings side-nav design in). A/B marked retired.
  Round 19 landed 93e8844 (project-hub-c owner-selected; session rows with a
  loom jump to the Looms tab and highlight it; settings side-nav embedded;
  awaiting final owner OK, then the project-page apply round).

- **view:** MINI-CHAT DOCK (owner idea): Facebook-style docked session chats
- **verdict:** new mockup (round 18)
- **items:** floating mini-chat that follows you app-wide: minimized heads
  (bottom-right, session identity + unread/working badge) expand to a small
  docked panel using the 1.7 COMPACT ChatSurface (minimal chrome, queue-able
  input); multiple sessions stack; pop-out to the full session; app-shell
  portal so it survives navigation. Mockup first, wiring after verdict.
- **round:** demo-gallery round 18 — landed e783668 (chat-mini-dock: heads
  w/ unread + working ring + parked tint, ~340x480 compact panels capped at
  2, queue-capable composer, fake-nav proves persistence across routes).
  OWNER: "I like the mini dock" + heads should TOGGLE (click open head =
  minimize) — round 20 landed 349034a.
  OWNER FINAL: "I like both the mini chats and the hybrid view, let's apply
  those too" — both go to production in apply round 2 (with the CTX overlay
  clamp from the polish queue).

## Post-apply polish queue (found live on the applied UI, round 19)

- **view:** session bar CTX overlay (applied, production)
- **verdict:** fix + content rework
- **items:** (a) the /context hover overlay goes OUT OF BOUNDS at the right
  viewport edge — round-4 pattern: fixed-position from anchor, viewport-
  clamped, flip on overflow (both bar overlays). (b) OWNER reference
  screenshot (Claude Code /context): header "Context window" + used/window
  (pct), slim segmented bar, swatch legend rows (Messages / System tools /
  Skills / System prompt / Memory files / Free space muted / deferred rows
  with — / expandable rows with counts), tokens + pct right-aligned.
  Categories computed from Telar's OWN session assembly (system prompt, MCP
  tool defs, message usage); ~ estimates ok; omit sourceless categories.
- **round:** apply round 2 (queued behind ui-v2-apply)
  APPLY ROUND 2 LANDED (after a false restart — /compact killed my task
  tracking, not the run): 10ff67c (both bar overlays fixed-position from
  anchor + viewport-clamped + flip; CTX content matches /context anatomy
  with HONEST categories only: Messages ~chars/4, System+tools = used −
  messages, Free space, lifetime splits as dash rows; per-category
  attribution NOT SDK-reported so omitted), 3ee5650 (mini-dock wired
  app-wide: heads + panels + real send, localStorage persistence, dock
  affordance in session header; live tail is per-turn, not token-by-token —
  no shared client stream store), 48b82ff (project-hub-c to production:
  Sessions | Looms | Settings tabs, ?tab= URL state, old settings route
  307s, deep links intact).

## Round 21+22 — project Git tab (owner request)

- **view:** project hub, new Git tab
- **verdict:** owner asked for git state as a first-class project surface:
  worktree tracking + fast cleanup (AI work generates many), issues/PRs
  loaded into Telar later, maybe a file tree.
- **items:** round 21 delivered THREE entries (cf8bb6e); owner: "I was
  thinking that the git view was going to be unified" — round 22 merged
  them into ONE dense view (6abd662, project-git-unified): header strip;
  worktrees centerpiece (loom-owner chips, done+merged ⇒ RECLAIMABLE, bulk
  clean-up confirm, typed force for dirty); branches+activity band;
  Issues|PRs read-only w/ first-class gh-not-connected state; files as
  collapsed git-aware tree. DATA: worktrees/branches/commits real (git
  plumbing + registry naming); sizes ~du; issues/PRs gh-CLI auth-gated
  (future); per-file last-touched-by is a GAP (store keeps filesTouched as
  a COUNT — needs paths in the schema). Owner: entry summary text was
  burying the demo — 93cc7ff clamps all gallery summaries to 2 lines
  (show-more) and trims the blurb. AWAITING OWNER VERDICT on the unified
  view.

## Post-apply polish round 2 (owner screenshots, live loom page)

- **view:** loom page (applied) — Threads tab + Chat tab
- **verdict:** fixed (28b5efc)
- **items:** (a) thread-card content escaped the center grid track and
  painted under the opaque Activity aside + right rail (grid tracks were
  correct; the cards lacked min-w-0/truncate) — content now truncates
  in-cell; (b) Chat tab embedded the full standalone session chrome (back
  button, identity header, account/usage bar) — new `embedded` prop on
  SessionView suppresses standalone chrome (also hides dock-minimize);
  loom chat is now transcript + composer only. NOTE: DiscussEscalation on
  the blocked page may want the same `embedded` flag — unreviewed.

## Settings completion (owner: "Settings page is missing a few things")

- **view:** global /settings
- **verdict:** shipped (63c4bd2) — the sections withheld by the no-placebo
  rule now have real backing: lib/ui-prefs.ts (useSyncExternalStore +
  localStorage, dependency-free) + lib/notify.ts.
- **items:** Appearance (System/Light/Dark; dark was hard-coded on <html> —
  hand-rolled next-themes pattern w/ pre-paint init script); Agent defaults
  (permission mode + model seed NEW sessions only; per-project memory wins;
  UI default, never an engine flag); Notifications (loom needs-you / ready,
  transition-only, hidden-tab-only, permission flow w/ honest denied
  state). GAPS: notifications need a mounted session view (global loom
  subscription = follow-up); charter/dead-end/gate events have no client
  source yet — toggles omitted, not faked.

## Round 23 — Git tab sub-views + loom follow-ups

- **view:** project Git tab (demo) + blocked-page chat + notifications
- **verdict:** owner rejected round-22's single scroll ("too much data
  inside a single view") but keeps ONE Git tab; approved the loom fix.
- **items:** fd66b55 reworks project-git-unified in place: internal
  switcher Worktrees | Branches | Remote | Files, one dense section at a
  time, persistent header strip w/ reclaimable headline, replay flips in
  hidden sections get an attention dot. AWAITING OWNER VERDICT; production
  Git tab HELD until then. 65d13cd: escalation-discussion chat now passes
  `embedded` (chrome-light, matches loom Chat tab). 64f31c6: global loom
  notifications — app-wide provider is the ONLY firing site (stripped from
  session-loom; single-point beats dedupe windows), ~30s poll of root
  looms, transition-only, no storm on load, zero work when prefs disabled.

## Round 24 — Git tab "mini GitHub" polish

- **view:** project Git tab (demo) sub-views
- **verdict:** owner: switcher direction approved ("Git is a bit better");
  branches chip cloud rejected; wants issues/PRs rendered; files touch-up;
  overall framing "we are trying to make a mini github here".
- **items:** 7bf5260 — BRANCHES chip cloud -> GitHub-grade table (mono
  name, default badge, tip commit line, mirrored ahead/behind bars,
  merged/stale chips, per-row + bulk delete; commit log demoted to a
  compact strip below). REMOTE now connected-first (empty state behind the
  toggle): issues w/ state icons, label chips, comment counts; PRs w/
  head->base, CI check cluster, review chip, linked-loom chip; both
  searchable. FILES -> navigable breadcrumb browser (GitHub pattern),
  per-path last-commit subject + age, dirty badges bubble to parents.
  AWAITING OWNER VERDICT on the polished shape.

## Git tab — PRODUCTION APPLY (owner approved round 24)

- **view:** /projects/<name>?tab=git
- **verdict:** shipped — d72c5f4 (API) + 85919e9 (UI), 1 fix round.
- **items:** real plumbing: git worktree/for-each-ref/log via execFile
  (no shell; 0x1F delimiters — NUL in argv silently breaks Node), loom
  join via registry naming, gh CLI remote (connected:true verified against
  Facundo-Barbera/Telar), breadcrumb file API (traversal-guarded,
  realpath-confined). CLEANUP: 7 refusal paths live-verified side-effect-
  free (main checkout, server worktree force-proof; dirty/unmerged need
  force + typed basename confirm; branch delete -d only); happy paths
  proven on throwaway scratch worktrees only; active-loom refusal
  code-verified (faking one would mean writing ~/.telar). GAPS: sizeMb
  null (du skipped for speed — headline degrades honestly), remote lists
  empty (repo has no issues/PRs yet), per-file last-touched-by omitted
  (core stores a count, not paths — needs schema change), demo replay/
  attention-dots dropped (were synthetic-state devices).

## Remote goes full — issue/PR detail + writes (owner: "like fully?")

- **view:** Git tab > Remote sub-view
- **verdict:** shipped — d87ad57 (API) + 83c8539 (UI), 1 fix round.
- **items:** 7 new endpoints (issue/PR detail w/ comments, reviews, checks,
  capped file diffs; POST create-issue / comment / close-reopen; PR
  comment). List -> in-place detail (breadcrumb back, ?tab=git preserved),
  markdown via the chat renderer, optimistic comments, two-step
  close/reopen, New-issue modal. PR merge deliberately NOT offered.
  SAFETY EPISODE: the first run's agent was classifier-blocked for
  planning an autonomous GitHub write (smoke-test issue) — correct block;
  rerun shipped with ZERO agent writes: argv builders asserted unexecuted,
  invalid-payload 400s curled, reads exercised via -R cli/cli. The OWNER
  performs the first real write from the UI (the human-triggered path the
  doctrine wants anyway). GAPS: connected:true detail unproven against
  telar's own repo (it has no issues/PRs yet); huge text diffs labeled
  binary (gh omits patch for both); >100-file PR pagination untested.

## Session liveness + auto-dock (prod bug, owner-reported)

- **verdict:** shipped — 21419a1 (server) + b6ade49 (client).
- **items:** root cause was persistence timing, not caching (all chat
  routes ƒ-dynamic; list API provably live). Fix: register-at-create
  (upsertChatStub at both init sites + early "saved" emit — session
  visible w/ running row from turn START; end-of-turn upserts, title can
  only improve, rename always wins) + live delta ring (bounded in-memory
  current-block ring; /events replays file skeleton then drains ring —
  re-entered views and dock panels now stream tokens; single-process
  assumption documented). AUTO-DOCK (owner spec): leaving a standalone
  active session docks a working head; embedded loom surfaces never
  auto-dock; re-entering removes only auto-docked heads; turn-finish
  keeps head + unread badge; pop-out cannot re-dock. Known edges: rare
  subagent-interleave can degrade one block to pop-at-finalize (content
  never lost); unread baseline misses if a turn finishes before first
  host load.

## Multi-machine batch: quick-wins + machine doctor + app-driven logins

- **verdict:** shipped — fd72d44/30bb8d1/0b0cf75 (quick-wins),
  53d4435 (doctor), 988c8b7 (login driver). Core suite 1157 → 1178.
- **items:** QUICK-WINS: core accountHealth (existence-only fs classifier,
  never reads secrets; Claude keychain honestly "unknown"), home-relative
  configDir storage + migrate-on-load, relocateProject (core only, no UI
  yet), loginHint; web health badges + classified usage failures +
  fail-fast chat preflight (400 over silent base-login fallback); codex
  honesty (dead cost pill hidden, prefix titles, interrupted-stream
  persistence, honest slash-command copy). DOCTOR: /api/doctor +
  Settings section + first-run dashboard card (empty registry only) —
  probes bun/git/gh/claude/codex binaries, gh auth (name only, token
  never surfaced), every account via accountHealth w/ login-command
  remedy, Playwright chromium cache ("bunx playwright install chromium"
  remedy), TELAR_HOME real-vs-dev. LOGIN DRIVER: both provider CLIs
  proven pipe-drivable (codex device-auth self-completes; claude waits
  on stdin for the OAuth code) — core spawnProviderLogin + SSE route +
  LoginPanel (live log, Open-URL, device code, paste-code, health
  re-check); Terminal.app osascript escape hatch kept but no provider
  needs it. 14 hermetic fake-CLI tests; real logins never driven by
  agents. Known edges: claude health stays "unknown" post-login
  (keychain) — success keys off exit-0; SSE login map is per-process.

## Desktop caveats: bundled playwright-mcp + separate dev data

- **verdict:** shipped — f422a0c (bundle) + ab5c00f (dev dir).
- **items:** build-web.sh materializes a symlink-dereferenced
  playwright-mcp closure (17M) into the standalone dir; electron-builder
  extraResources must point AT the node_modules dir (its traversal skips
  dirs named node_modules — same trick as the .bun store); main.js sets
  TELAR_PLAYWRIGHT_MCP_BIN only when packaged and unset; --smoke now
  asserts PLAYWRIGHT_MCP_BUNDLED_OK fail-closed. Dev servers default
  TELAR_HOME to ~/.telar-dev (explicit override wins; build/start/pack
  stay on ~/.telar); gate seeded ~/.telar-dev once from ~/.telar.
  Packaged .app re-smoked green; bun.lock needed no re-record. Honest
  remaining machine requirement: Playwright BROWSER binaries — now a
  doctor check, not a caveat doc footnote.
