# Design system audit — web cockpit, iOS app, desktop chrome

Read-only audit, 2026-09-11, at `9ce8d454`. No app source changed.

**The headline: the colour layer is a byte-exact port between the two
platforms, and the type layer does not exist on either.** Every one of the 29
mapped colour roles converts from `globals.css` oklch to `Theme.swift` hex with
zero drift. Meanwhile the web writes 481 arbitrary `text-[…]` sizes on a
four-step sub-12px ramp that `globals.css` never names, and iOS writes 257
`.system(size:)` literals on the *same* ramp that `Theme.swift` never names —
and because `.system(size:)` is absolute, all 257 ignore Dynamic Type.

Two corrections to the brief, both affecting scope:

- `docs/design/` and the t3code survey are **not in this tree**. t3code survives
  only as an architecture reference (`docs/engine-contract-v2.md:40`,
  `docs/browser-v2-plan.md:41-43`). The visual port is in commit messages
  (`b0701ab9`, `36396df8`).
- **PR #232 is not merged into `main`.** `git merge-base --is-ancestor 6898610d
  HEAD` fails. `bandCaption` does not exist here. Its commit message is quoted
  below as the project's own statement of the rule, not as landed code.

Counts differ from the brief: `globals.css` declares **119** distinct variables
(not 183 — that number counts light + dark restatements), and `components/ui/`
holds **31** primitives (not 34).

---

## (a) Token inventory and the web↔iOS map

### What each layer defines

| Layer | web `globals.css` | iOS `Theme.swift` | Verdict |
|---|---|---|---|
| Colour roles | 29 semantic + 8 subject + 8 kind + 5 chart | 22 (`canvas`…`dangerGlyph`) | **exact match where both exist** |
| Elevation rungs | 4 dark (canvas/rail/card/popover) | 3 (no popover) | iOS short one rung |
| Radii | `--radius` 10px → 6 derived steps + `--control-radius` | 6 authored constants | parallel, values disagree |
| Type scale | **none** — 0 size tokens | 8 font tokens (`body`…`monoSmall`) | **the gap** |
| Spacing | Tailwind default only | none (inline) | untokenised both sides |
| Shadows | `--shadow-tint` | none | iOS has no elevation colour |
| Motion | none (durations inline) | none | untokenised both sides |
| Accent / font / translucency | 8 accents, 7+7 faces, 2 size sliders, translucency, frost, theme library | **none** | see §(g) |

### Colour: the map, verified numerically

Every row below is `globals.css` oklch converted to sRGB and compared against
the `Theme.swift` literal. `EXACT` means byte-identical.

| web token (`globals.css`) | sRGB | iOS token (`Theme.swift`) | |
|---|---|---|---|
| `--background` :115 / :337 | `#fcfcfc` / `#0a0a0a` | `canvas` :7 | EXACT |
| `--card` :117 / :339 | `#ffffff` / `#161616` | `surface` :8, `card` :22 | EXACT |
| `--popover` :119 / :341 | `#ffffff` / `#1c1c1c` | — | **no iOS rung** |
| `--muted` :138 / :361 | `#f4f4f5` / `#252525` | `fill` :9, `codeBackground` :11 | EXACT |
| `--secondary` :136 / :359 | `#f1f1f3` / `#252525` | `messageSurface` :10, `subtle` :25 | EXACT |
| `--accent` :145 / :363 | `#f0f0f1` / `#2f2f2f` | `subtleStrong` :26 | EXACT |
| `--sidebar` :321 / :428 | `#f6f6f6` / `#101010` | `sheet` :21 | EXACT |
| `--foreground` :116 / :338 | `#27272a` / `#f5f5f5` | `text` :12 | EXACT |
| `--muted-foreground` :144 / :362 | `#696973` / `#a1a1a1` | `textMuted` :13 | EXACT |
| `--primary` :127 / :350 | `#2f58b9` / `#6594fa` | `accent` :14 | EXACT |
| `--border` :255 / :410 | `#e4e4e7` / 10% white | `border` :30 | EXACT |
| `--warning` :169 / :373 | `#8e5b01` / `#f2a635` | `statusAmber` :15 | EXACT |
| `--destructive` :170 / :374 | `#b71822` / `#ff645e` | `statusRed` :20 | EXACT |
| `--success` :168 / :372 | `#02744e` / `#2ac48a` | `statusEmerald` :19 | EXACT |
| `--info` :166 / :370 | `#007386` / `#22bedc` | `statusSky` :17 | EXACT |
| `--verify` :167 / :371 | `#794ed7` / `#a486fd` | `statusViolet` :18 | EXACT |

Nothing in this table needs touching. It is the part of the system that works,
and it is why colour appears nowhere in the polish list.

### Type: the scale both platforms use and neither names

Measured usage, sorted by size. The two ramps are the same ramp.

| px | web utility | web uses | iOS uses | proposed name |
|---|---|---|---|---|
| 8 | — | 0 | 3 | (drop) |
| 9 | `text-[0.5625rem]` | 39 | 16 | `--text-2xs` / `.caption2` |
| 10 | `text-[0.625rem]` | **199** | 33 | `--text-xxs` / `.caption2` |
| 11 | `text-[0.6875rem]` | **243** | **56** | `--text-2xs`+ / `.caption` |
| 12 | `text-xs` | **486** | 52 | `text-xs` / `.caption` |
| 13 | `text-[0.8125rem]` | 12 | 40 | `--text-xs+` / `.footnote` |
| 14 | `text-sm` | 196 | 21 | `text-sm` / `.subheadline` |
| 15–18 | `text-base`/`lg` | 20 | 30 | `.body` / `.headline` |
| 20+ | `text-2xl`…`4xl` | 5 | 2 | display |

**481 arbitrary web sizes, 257 iOS literals, one unnamed ramp.** iOS has 8 font
tokens covering it (`Theme.swift:47-59`) used **54 times** against those 257
literals — a 1:5 adoption ratio. And three spellings coexist for one size:
`Theme.meta` (19 uses), bare `.font(.caption)` (3), `.system(size: 12)` (52).

### Radii: documented hierarchy vs shipped hierarchy

`globals.css:305-313` states the intent in prose: *"8px controls, 10px fields
and popovers, 18px cards and dialogs."* Actual usage:

| utility | computed | uses | documented role |
|---|---|---|---|
| `rounded-md` | 8px | **236** | controls ✓ |
| `rounded-lg` | 10px | 83 | fields/popovers ✓ |
| `rounded-xl` | **14px** | **58** | **not in the hierarchy at all** |
| `rounded-2xl` | 18px | 7 | cards/dialogs — but only 7 sites |
| `rounded-full` | — | 87 | — |

Cards are drawn at 14px in practice and documented at 18px. iOS
`Theme.radiusCard = 14` (`Theme.swift:37`) agrees with web *practice* and
contradicts web *doctrine* — so the doctrine is what is wrong.

`--control-radius` / `--radius-control` (`globals.css:99-100`, `:313`) carries a
seven-line rationale and has **zero call sites**; `rounded-control` appears
nowhere. `rounded-md` happens to compute to the same 8px, which is why nobody
noticed.

---

## (b) Literals per file — the polish targets

### Web: arbitrary `text-[…]` per file (top 12 of 481)

| file | count |
|---|---|
| `components/session/github-detail-surface.tsx` | 32 |
| `components/spool/tray.tsx` | 24 |
| `components/browser-live.tsx` | 24 |
| `components/session/diff-surface.tsx` | 21 |
| `components/right-panel.tsx` | 21 |
| `components/session/github-surface.tsx` | 20 |
| `components/transcript.tsx` | 18 |
| `components/composer-controls.tsx` | 14 |
| `components/settings/provider-instance-card.tsx` | 13 |
| `components/settings/packages-panel.tsx` | 13 |
| `components/session/session-row.tsx` | 13 |
| `components/settings/provider-models-tab.tsx` | 11 |

Other web literal classes are **not** a problem and should be left alone:
13 hex literals total, of which 10 are legitimate brand/default values
(`session/provider-icon.tsx:6` `#D97757` is Claude's orange;
`settings/studio/tools.tsx:105` `#1e1e2e` is a theme-editor seed). Arbitrary
`rounded-[…]`: 18 sites, most of them deliberate `min()` clamps inside
`button.tsx`.

### iOS: `.system(size:)` per file (top 12 of 257)

| file | count |
|---|---|
| `Views/SessionView.swift` | 22 |
| `Views/NewSessionView.swift` | 21 |
| `Views/Panel/NotebookSurface.swift` | 20 |
| `Views/Panel/LatexSurface.swift` | 20 |
| `Views/Panel/DataSurface.swift` | 18 |
| `Views/TranscriptViews.swift` | 17 |
| `Views/InboxView.swift` | 16 |
| `Views/DiffView.swift` | 15 |
| `Views/SettingsKit.swift` | 12 |
| `Views/Panel/FilesSurface.swift` | 12 |
| `Views/Panel/TextFileView.swift` | 9 |
| `Views/Panel/CellOutputView.swift` | 9 |

`cornerRadius:` literals: 25 numeric sites against 6 `Theme.radius*` tokens
used 20 times. `SessionView.swift:830,843` uses `cornerRadius: focused ? 20 :
27` — two magic numbers in no scale.

iOS colour literals are near-zero and all defensible: `ProjectAvatar.swift:36,38`
(generated hue per project), `MarkdownText.swift:116` (a `UIColor` the markdown
renderer needs outside SwiftUI).

---

## (c) Component drift

| concept | variants that exist | evidence | should merge to |
|---|---|---|---|
| **Section caption** | `CAPTION` declared **3× identically** | `app-sidebar.tsx:216`, `spool/warehouse-nav.tsx:43`, `loom/looms-nav.tsx:19` — and `spool/idiom.test.ts:2506-2514` is a test that *asserts the three strings match*, pinning the duplication instead of removing it | one export |
| **Button** | 306 raw `<button>` vs 194 `<Button>` | `spool/stance.tsx` (34 raw), `browser-live.tsx` (20), `spool/room.tsx` (15) | `<Button>`; 20 files have `onClick` and no `focus-visible` at all |
| **Card** | `ui/card.tsx` has **2 importers**, both `app/looms/*` | every card the user actually sees is hand-rolled: `approval-card.tsx:75` (`rounded-xl border-warning/40 bg-warning/5`), `spool/tray.tsx:688` (`rounded-xl bg-card shadow-sm ring-1`), `session-row.tsx:280` (`rounded-md bg-sidebar-accent`) | needs a decision, not a sweep |
| **Empty state** | `common/empty-state.tsx` has **2 importers**, both `app/looms/*`; 20 further `border-dashed` containers at 5 different radii | `right-panel.tsx` (lg), `spool/board.tsx` (xl), `spool/lobby.tsx` (md ×3), `run/run-config-editor.tsx` (md) | `EmptyState` |
| **Spinner** | 41 `<Spinner>` vs 38 raw `Loader2` + `animate-spin` | `ui/spinner.tsx` exists and is bypassed half the time | `<Spinner>` |
| **Progress** | `ui/progress.tsx` — **0 importers** | dead | delete or adopt |
| **Dead primitives** | `avatar`, `button-group`, `progress`, `scroll-area` — 0 importers each | | delete |
| **Status colour** | one definition, correctly | `--success`/`--warning`/`--destructive`/`--info`/`--verify`, and `globals.css:148-165` forbids a sixth ramp | nothing to do |
| **iOS muted text** | **3 identical tokens**, 187 call sites | `Theme.swift:13` `textMuted` (102), `:23` `textMuted2` (36), `:24` `textTertiary` (49) — all `light: 0x696973, dark: 0xA1A1A1` | one token |
| **iOS dead tokens** | `statusIndigo` (`:16`) is a **copy-paste duplicate of `statusAmber`** (`:15`), 0 uses; `statusViolet` (`:18`) 0 uses | | delete both |

---

## (d) Motion

Five durations in use (`duration-100` ×10, `-200` ×6, `-150` ×2, `-300`, `-500`)
plus two inline `cubic-bezier(.22,1,.36,1)` easings
(`right-panel.tsx:1378,1702`, `composer.tsx:992`). No duration token on either
platform.

**Reduce-motion coverage is the gap.** Web has 3 `motion-safe:` and 3
`motion-reduce:` guards against **39 `animate-spin` and 5 `animate-pulse`**:

- guarded: `transcript.tsx:1056`, `ui/shimmer.tsx:44`, `right-panel.tsx:1378,1702`,
  `composer.tsx:992`, `lib/use-streaming-reveal.ts:5`
- unguarded: every other spinner and pulse, including `ui/spinner.tsx` itself
  (41 call sites inherit the omission) and `ui/skeleton.tsx` (`animate-pulse`,
  no variant)

`globals.css:749-752` globally kills `animate-in`/`animate-out` via
`animation-name: none !important` — a WebKit 26.x renderer-crash workaround, not
a motion preference. It is correct and load-bearing; leave it.

iOS honours `accessibilityReduceMotion` in exactly 2 places
(`Theme.swift:80` `SteppedPulseDot`, `StreamingMarkdown.swift:74`) against 15
`withAnimation`/`.animation(` sites, 12 of which are unguarded
(`SessionView.swift` ×6, `TranscriptViews.swift` ×5, `InboxView.swift` ×1).

---

## (e) Accessibility

**Contrast passes on both platforms.** Computed from the token values, WCAG 2.x
on every surface each token can land on:

| token | light | dark |
|---|---|---|
| web `--muted-foreground` on canvas | 5.29:1 | 7.66:1 |
| …on `--sidebar` / `--sidebar-accent` | 5.02 / **4.60** | — / 5.93 |
| …on `--muted` / `--accent` | 4.94 / 4.77 | — / 5.18 |
| iOS `textMuted` on `canvas` / `subtle` | 5.29 / 4.81 | 7.66 / 5.93 |
| iOS `text` on `canvas` | 14.52 | 18.16 |
| iOS status ramp (5 tokens) on `canvas` | 5.27–6.46 | 6.82–9.69 |

The 4.60:1 floor on a hovered sidebar row is exactly what `globals.css:139-143`
claims, and it holds. No colour change is warranted anywhere.

What does not pass:

- **Web focus rings.** 204 `focus-visible:` declarations, but 20 files carry
  `onClick` with none and no `<Button>` import — `composer-menu.tsx`,
  `workspace-environment.tsx`, `composer-question-drawer.tsx`, `spool/room.tsx`,
  `spool/task-row.tsx`, `spool/lobby.tsx`, `spool/warehouse-nav.tsx`,
  `common/list-controls.tsx`, `run/run-panel.tsx`, `loom/looms-nav.tsx`,
  `loom/mini-braid.tsx`, `session/conversation-message.tsx`,
  `session/workspace-inspector.tsx`, `session/cell-output.tsx`, and 6 panel
  surfaces. Same root cause as the 306 raw `<button>`s.
- **iOS Dynamic Type.** Zero `relativeTo:` and zero `@ScaledMetric` in the whole
  app. All 257 `.system(size:)` sites are fixed points. A reader at an enlarged
  text setting gets a grown navigation bar and an unchanged interface.
- **iOS icon labels.** 51 `accessibilityLabel` against ~120 `Image(systemName:)`.
  Worst: `Panel/NotebookSurface.swift` (18 glyphs), `TranscriptViews.swift` (16),
  `SessionView.swift` (12).

---

## (f) Desktop chrome — clean, leave it

`apps/desktop/window-chrome.js:10-18` names 56px as a cross-process contract,
`globals.css:994-1024` derives `--titlebar-inset: 76px` from the same geometry
with an explicit "PX, NEVER REM" rule and an issue reference (#203), and
`window-chrome.test.js` covers it. Three sites, one number, documented in all
three. Nothing to do.

---

## (g) The web↔iOS gaps a user would feel

Ranked by how quickly a person moving between the two notices.

1. **The look you chose does not travel.** Web offers 8 accents, 7 sans + 7 mono
   faces, two size sliders, translucency, frost and a theme library
   (`lib/appearance.ts:145-156`, `settings/appearance-section.tsx` 29k,
   `settings/looks-section.tsx` 19k). iOS `SettingsView.swift` has **no
   appearance section at all** — its only rows are Cockpits, Name, This Mac,
   Notifications. Pick rose on the desktop, open the phone, it is indigo.
2. **Text size.** The web reader who set interface size to 18px gets it; the
   iOS reader who set Larger Text gets a grown nav bar and an unchanged app.
3. **The composer.** Web `composer.tsx` is the `--control-radius` family; iOS
   `SessionView.swift:830,843` is `cornerRadius: focused ? 20 : 27` — a focus
   animation the web does not have, on radii no scale contains.
4. **The approval card.** Web `approval-card.tsx:75` is one `CARD` const
   (`rounded-xl border-warning/40 bg-warning/5`) — a warning-tinted card. iOS
   `RequestViews.swift` has 6 size literals and reaches `Theme.dangerFill`
   (`statusRed.opacity(0.14)`), so the same object is amber on one platform and
   red on the other.
5. **The transcript row.** iOS `TranscriptViews.swift` has 17 size literals
   across 9/10/11/12/13px; web `transcript.tsx` has 18 arbitrary sizes across
   the same range. Neither is wrong relative to the other — both are unnamed.
6. **The popover rung.** iOS has no `popover` surface, so menus sit on `card`
   (`#161616`) where the web would use `#1c1c1c`. Visible as slightly flatter
   menus in dark mode.

The project has already stated the rule this all resolves to, in
`6898610d` (PR #232, unmerged):

> Three bands named themselves three ways… None of those was wrong on its own;
> together they were three treatments of "small grey word above some rows",
> differing only in having been written on different days. The desktop made the
> same mistake and fixed it by giving every caption one token (`CAPTION`,
> app-sidebar.tsx).
>
> 10px has no Dynamic Type style, so it maps to `.caption2` rather than a hard
> size — **a caption that does not grow with the reader's text setting is the
> one piece of a row that cannot be read when everything around it can.**

---

## (h) Polish list

### One PR each — do now

| # | What a user sees | Where | Fix | Size |
|---|---|---|---|---|
| 1 | Nothing, until they enlarge text: then the iOS app does not respond | 257 sites, top 12 in §(b) | Add 4 tokens to `Theme.swift:47-59` (`captionTiny/caption/footnote/subhead`), map 9→`.caption2`, 10/11→`.caption`, 12/13→`.footnote`, sweep per file | **L** (12 PRs) |
| 2 | A spinner keeps spinning for a reader who asked for less motion | `ui/spinner.tsx:7`, `ui/skeleton.tsx:9` | Add `motion-safe:` to both primitives — fixes 41 + all skeleton sites at once | **S** |
| 3 | Three files can drift apart on the next edit | `app-sidebar.tsx:216`, `spool/warehouse-nav.tsx:43`, `loom/looms-nav.tsx:19` | Export `CAPTION` once; delete `spool/idiom.test.ts:2506-2514` (it pins duplication rather than preventing it) | **S** |
| 4 | Tabbing through the Spool and the panels loses the focus ring | the 20 files in §(e) | Swap raw `<button>` → `<Button variant="ghost">`, or add the ring class | **M** |
| 5 | Two greys that are the same grey, in three names | `Theme.swift:13,23,24` — 187 call sites | Collapse to `textMuted`; mechanical rename | **S** |
| 6 | An amber status token named "indigo" | `Theme.swift:16,18` | Delete `statusIndigo` and `statusViolet` (0 uses each) | **S** |
| 7 | Dead weight in the primitive list | `ui/{avatar,button-group,progress,scroll-area}.tsx` | Delete — 0 importers | **S** |
| 8 | Nothing; a token with a rationale and no call sites | `globals.css:99-100,313` | Either adopt `rounded-control` in `button.tsx`/`badge.tsx` or delete both names | **S** |
| 9 | Web: 481 arbitrary sizes that cannot be swept safely today | §(b) top 12 | Add `--text-2xs/xxs/xs+` to the `@theme` block first, *then* sweep per file | **M**, after the token lands |

### Worth a design pass first

| # | The decision | Why it is not a sweep |
|---|---|---|
| 10 | **One card family.** `ui/card.tsx` has 2 importers, both `app/looms/*`; the transcript, approval, sidebar and Spool cards are 4 hand-rolled shapes at 3 radii | Choosing one means deciding whether a warning card is a `Card` with a tint or its own thing — a product call. Also settles 14px-vs-18px and lets `globals.css:305-313` be corrected. **L** |
| 11 | **Appearance on iOS.** Accent at minimum; the 8 hues are already computable from `Theme.accent` | Needs a sync story (does the phone follow the paired cockpit, or hold its own?) before any code. **L** |
| 12 | **The composer's radius.** iOS animates 27→20 on focus; web does not move | Either the web gains the affordance or iOS loses it. Do not "fix" iOS to match by default — the focus animation may be the better behaviour. **M** |
| 13 | **Radius doctrine.** Correct `globals.css:305-313` to the shipped 8/10/14 ladder, or migrate 58 `rounded-xl` sites to `rounded-2xl` | The comment is currently wrong; which side moves is a taste call. **M** |
| 14 | **iOS popover rung.** Add a 4th dark step (`#1c1c1c`) for menus and sheets | Small, but changes every menu; worth seeing before committing. **S** |

### Leave

- **The whole colour layer.** 29/29 exact, contrast verified 4.60–18.16:1, and
  `globals.css:12-18` explicitly states the values are not free parameters.
- **Desktop titlebar geometry** (§(f)) — three sites, one number, tested.
- **`globals.css:749-752`** `animate-in/out` kill — a renderer-crash workaround.
- **The 13 web hex literals** — brand colours and theme-editor seeds.
- **iOS `ProjectAvatar`/`MarkdownText` colour literals** — generated hue and a
  `UIColor` boundary.
- **Spacing.** Untokenised on both platforms, and no evidence of drift that a
  user would see. Not worth a scale nobody asked for.

---

## (i) The three to do first

1. **#2 — `motion-safe:` on `ui/spinner.tsx` and `ui/skeleton.tsx`.** Two lines,
   fixes 41 spinner call sites and every skeleton at once, and it is the only
   item here that is a straightforward accessibility bug with a one-line fix.

2. **#1, starting with `Views/SessionView.swift` and
   `Views/TranscriptViews.swift`.** The largest real defect found: Dynamic Type
   does not work anywhere in the iOS app. Add the four tokens, convert the two
   files a user spends all their time in (39 of 257 literals), and the rest
   becomes a mechanical queue. `6898610d` already argues the case and shows the
   shape.

3. **#3 + #5 together — the two duplicate-token sweeps.** `CAPTION` ×3 on web
   and `textMuted`/`textMuted2`/`textTertiary` on iOS are the same mistake on
   both platforms, both mechanical, both prerequisites for #9 and #1 not
   re-introducing drift. Delete the test that pins the web duplication.

Deliberately not first: #9, the web type sweep. 481 sites is the biggest number
in this document, but the web's sizes are at least *consistently* wrong —
`text-[0.6875rem]` renders the same everywhere. The iOS literals actively break
a system accessibility setting. Token first, sweep later.
