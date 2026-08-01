# Palette candidates — the two Telar did not ship

**Status:** decided 2026-08-01. The shipped palette is **Warp**, and it lives in
`apps/web/app/globals.css`. This file is the record that a taste decision was made among real
alternatives rather than defaulted into, and it keeps the two runners-up in paste-ready form so
reversing the decision is an afternoon rather than a re-run.

## How to switch

1. Replace the bodies of `:root` and `.dark` in `apps/web/app/globals.css` with the two blocks from
   whichever candidate below. **Keep `--radius` and `--control-radius`** — `--control-radius` is
   geometry, not colour, and no candidate proposed changing it.
2. Reconcile the `@theme inline` bridges at the top of the same file. This is the step that fails
   silently if you skip it: Tailwind v4 only emits a utility for a `--color-*` name it can see in
   that block, so a raw token with no bridge is a token no class can reach and `text-success`
   compiles to nothing.
   - **Ember** renames the state layer to `--status-run` / `--status-verify` / `--status-ready` /
     `--status-review` / `--status-blocked`. Swap the four `--color-info|verify|success|warning`
     bridges for five `--color-status-*` ones, and note that every call site written against the
     shipped names has to move with them.
   - **Console** ships **no** status tokens at all. The four shipped bridges would then point at
     undeclared raw tokens — the utilities still emit, referencing a variable that resolves to
     nothing. Delete the four bridges, and accept that the state vocabulary goes back to hardcoded
     Tailwind ramps.
3. Check that every token `:root` declares and the light theme needs restored is **also declared in
   `.dark`**. There are no token copies to update — the demo gallery used to carry two hand-kept
   ones and no longer does. `apps/web/lib/demo-gallery/theme-island.ts` reads the loaded stylesheet
   at toggle time and derives a light island by diffing what `.dark` overrides against `:root`, so
   the copies cannot drift. The diff is also the one thing that can bite you: a token `:root`
   declares but `.dark` never overrides is invisible to the island, so it silently keeps the shell's
   value in every light stage. Ember and Console are symmetric today; keep them that way.
4. Re-check the comment in `apps/web/components/looms/godview.ts` that documents a token set — it
   names states, and the names are candidate-specific. Untouched by the palette phase, so it still
   describes whatever it described before; read it, do not assume it moved.

Nothing in any of these candidates touches permission wiring, hook registration,
`restrictTools`/`disallowedTools`/`settingSources`, or the loom ready→done gate.

---

## Ember — "Telar is one hue"

**Thesis.** Everything warm in the file is oklch hue 62 — fired clay, raw sienna, a tungsten bulb at
the end of a long day. Telar is named for a loom, and the loom's one irreducible moment is a human
accepting work an agent structurally cannot accept for itself; that moment should feel like a warm
light, not a system prompt, so the product's own voice is warm and the room it happens in is warm
too. The rule that keeps it from becoming a lifestyle app is **chroma is meaning**: the neutral
spine runs at chroma 0.005–0.020 (warm the way unbleached paper is warm, too quiet to read as a
signal), `--primary` and `--ring` stay near 0.10, and status colours run at 0.11–0.17. Warmth is the
room; saturation is the alarm.

**Why it did not ship.** It loses on the criterion it claims. Putting the brand inside the warm
status family compresses `--primary` against `--status-review` to OKLab ΔE **0.063** in light
(`#8f571e` vs `#896c01`) — that is "accepted" against "needs your review", the one distinction the
human-accept moat depends on — and `--status-blocked` against `--destructive` to **0.069**. Ember's
stated mitigation is that a solid chip and a tinted chip read differently, but both members of each
of those two pairs are tinted chips with identical treatment, so the mitigation does not cover its
own worst pair. Separately: all 45 of Ember's contrast claims verified exact, but it makes no claim
about `--input`, which lands at **1.61:1 light / 1.60:1 dark** and silently fails WCAG 1.4.11 in
both themes.

**Where the judge conceded.** Criterion 2 asks whether a palette survives a night of use, and a warm
charcoal genuinely does that better than the shipped chroma-0 black. Ember was rejected on state
separation, not on the room it makes. If you care more about how the app feels at 1am than about
whether `accepted` and `needs-review` sit 0.063 apart *in light mode* — which is not the default —
Ember is defensible.

```css
:root {
  /* TELAR IS ONE HUE. Everything warm in this file is oklch hue 62 — fired
     clay, raw sienna, the colour of a tungsten bulb at the end of a long day.
     Telar is named for a loom, and the loom's one irreducible moment is a human
     accepting work an agent structurally cannot accept for itself. That moment
     should feel like a warm light, not a system prompt, so the product's own
     voice is warm and the room it happens in is warm too.

     The rule that keeps this from becoming a lifestyle app — and, more
     practically, from colliding with the status language — is CHROMA IS
     MEANING. The neutral spine runs at chroma 0.005–0.020: warm the way
     unbleached paper is warm, far too quiet to read as a signal. --primary and
     --ring spend real chroma but stay near 0.10. Status colours run at 0.11–0.17
     because a signal should look like one. Warmth is the room; saturation is the
     alarm. That is why a solid clay `done` chip cannot be mistaken for the
     saturated orange `blocked` badge sitting next to it in the same row. */

  /* Light mode inverts dark's elevation trick: the page is warm paper and cards
     are pure white, so a surface gains height by getting BRIGHTER than what it
     sits on, exactly as dark gains it by getting lighter than black. */
  --background: oklch(0.988 0.005 62);
  --foreground: oklch(0.196 0.014 62);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.196 0.014 62);
  --popover: oklch(1 0 0);
  --popover-foreground: oklch(0.196 0.014 62);

  /* The brand at text weight. `text-primary` runs 30 call-sites on white, so
     light-mode primary has to be dark enough to read as body copy — at hue 62
     that lands on burnt sienna, which is the same pigment as dark's ember, just
     fired longer. 5.71:1 on background, 5.92:1 on card. */
  --primary: oklch(0.51 0.102 62);
  --primary-foreground: oklch(0.992 0.004 62);
  --secondary: oklch(0.966 0.008 62);
  --secondary-foreground: oklch(0.256 0.02 62);
  --muted: oklch(0.963 0.009 62);

  /* Darkened from stock 0.556 because muted-foreground on muted was failing AA
     at 4.34:1 — the single real contrast bug in the palette this replaces, and
     it fires on `bg-muted` under `text-muted-foreground`, the two heaviest
     tokens in the app. 4.92:1 now. */
  --muted-foreground: oklch(0.522 0.02 62);

  /* Accent is the only neutral allowed extra chroma: it is the hover/selected
     surface, and hover is where the warm should surface. */
  --accent: oklch(0.944 0.018 62);
  --accent-foreground: oklch(0.256 0.02 62);
  --destructive: oklch(0.548 0.212 27);

  /* THE STATUS LAYER — new, and it needs five matching --color-status-* aliases
     in @theme inline before any utility can reach it. It exists because 469
     production call-sites hand-derive this language from Tailwind's named ramps
     with no `dark:` variant, so every `text-amber-300` / `text-emerald-300` in
     state-badge.tsx currently fails contrast the moment someone switches to
     light. One token per state, tuned per theme, carries all four roles a status
     colour plays — dot fill, /10 tint, /40 border, and body text — because the
     token itself changes between themes instead of the class doing it. Hues are
     spaced so the four warm things in this product (failed 27, blocked 42,
     brand 62, review 90) sit ~20° apart and the brand is the only low-chroma
     member of the family. */
  --status-run: oklch(0.532 0.108 232);
  --status-verify: oklch(0.512 0.165 300);
  --status-ready: oklch(0.52 0.115 158);
  --status-review: oklch(0.545 0.111 90);
  --status-blocked: oklch(0.56 0.165 42);

  /* Light borders switch from opaque to alpha to match dark's behaviour: one
     value that composites correctly over paper, white cards and the sidebar
     alike, which matters when `* { border-border }` paints every element. 13%
     over background lands on #e3dfdc — the same weight as the flat #e5e5e5 it
     replaces, now carrying the surface's warmth. --input is pushed to 24%
     because a field boundary is a control affordance, not decoration, and the
     old value was nearly invisible. */
  --border: oklch(0.28 0.02 62 / 13%);
  --input: oklch(0.28 0.02 62 / 24%);

  /* Focus is the warm light made literal: `* { outline-ring/50 }` means every
     focusable thing in the app glows clay when you reach it. */
  --ring: oklch(0.602 0.108 62);

  /* Five actually-distinguishable series, not five greys. Ember leads because
     the brand should be series one; the rest walk the wheel at 55–100° spacing
     and are authored DARKER than their dark-mode counterparts, since a chart
     mark on white needs the opposite lightness of one on black. All clear 3:1
     on both background and card (4.58–7.10:1). */
  --chart-1: oklch(0.56 0.125 62);
  --chart-2: oklch(0.545 0.092 200);
  --chart-3: oklch(0.535 0.115 145);
  --chart-4: oklch(0.48 0.17 300);
  --chart-5: oklch(0.53 0.17 355);
  --radius: 0.625rem;

  --sidebar: oklch(0.976 0.007 62);
  --sidebar-foreground: oklch(0.196 0.014 62);

  /* Unconsumed today, but given the brand value rather than left as shadcn's
     stray blue-700 — if anything ever reaches for it, it lands in family. */
  --sidebar-primary: oklch(0.51 0.102 62);
  --sidebar-primary-foreground: oklch(0.992 0.004 62);
  --sidebar-accent: oklch(0.944 0.018 62);
  --sidebar-accent-foreground: oklch(0.256 0.02 62);
  --sidebar-border: oklch(0.28 0.02 62 / 13%);
  --sidebar-ring: oklch(0.602 0.108 62);
}

.dark {
  /* Dark is the primary mode and the one this palette was designed in first.
     The spine is not black — it is oklch hue 62 at chroma 0.008–0.019, a warm
     charcoal that reads as a lit room rather than a terminal void. The chroma is
     deliberately below anything that could be mistaken for a status colour: at
     0.008 you cannot name the hue, you can only tell it is not cold. */

  /* Four surfaces, one ladder: page 0.150 → sidebar 0.192 → card 0.206 →
     popover 0.230. The rail sits between the page and the cards it lists
     instead of tying with them at 0.205, so content reads as stacked on top of
     navigation without a single shadow. */
  --background: oklch(0.15 0.008 62);
  --foreground: oklch(0.966 0.006 62);
  --card: oklch(0.206 0.01 62);
  --card-foreground: oklch(0.966 0.006 62);
  --popover: oklch(0.23 0.012 62);
  --popover-foreground: oklch(0.966 0.006 62);

  /* THE ACCEPT COLOUR. --primary is what `done` wears (state-badge.tsx),
     what the sidebar's live-work pulse is, what the dock's send button is —
     everywhere the app speaks in its own voice rather than reporting a
     machine's. Chroma is held at 0.106, well under the 0.15+ the status tokens
     spend, which is the whole reason a solid clay `done` chip cannot be
     confused with the vivid `blocked` orange beside it: `done` is a lamp,
     `blocked` is a signal, and treatment (solid fill vs /10 tint + outline)
     already separates them structurally. --primary-foreground is a deep clay-
     black rather than neutral ink so the chip reads as warm all the way
     through. 9.01:1. */
  --primary: oklch(0.788 0.106 62);
  --primary-foreground: oklch(0.206 0.03 62);
  --secondary: oklch(0.272 0.012 62);
  --secondary-foreground: oklch(0.966 0.006 62);
  --muted: oklch(0.266 0.011 62);

  /* Lifted from stock 0.708 for one specific reason: `text-muted-foreground/70`
     runs 126 call-sites and was landing at 4.20:1, just under AA. At 0.742 the
     composite clears at 4.65:1 and the base token still sits at 8.57:1 on
     background, 6.65:1 on muted. /60 and below stay decorative-tier — see risks. */
  --muted-foreground: oklch(0.742 0.016 62);

  /* Accent is the only neutral allowed extra chroma: it is the hover/selected
     surface, and hover is where the warm should surface. Also lifted clear of
     --muted so a selected row and a hovered ghost button stop being identical. */
  --accent: oklch(0.294 0.019 62);
  --accent-foreground: oklch(0.966 0.006 62);

  /* Re-authored from oklch(0.704 0.191 22.216), which was outside sRGB and
     therefore being silently clipped by every browser rendering it. Same red
     intent, values a display can actually reach. */
  --destructive: oklch(0.672 0.185 25);

  /* THE STATUS LAYER — new, and it needs five matching --color-status-* aliases
     in @theme inline before any utility can reach it. See the :root block for
     why it exists; these are the dark values, tuned to sit as text on charcoal
     as well as fill a 6px dot. Hue spacing keeps the four warm things apart:
     failed 25, blocked 42, brand 62, review 90. */
  --status-run: oklch(0.752 0.12 232);
  --status-verify: oklch(0.735 0.135 300);
  --status-ready: oklch(0.79 0.15 158);
  --status-review: oklch(0.845 0.15 90);
  --status-blocked: oklch(0.735 0.162 42);

  /* Alpha borders are kept — one value composites correctly over background,
     sidebar, card and popover, which is exactly what `* { border-border }`
     across four elevations needs. But the white is warmed to hue 62 (a neutral
     white at 10% visibly cools every edge on a warm surface) and raised 10%→12%,
     because warm-on-warm has less luminance separation than white-on-neutral
     did and needed the extra point to hold the same edge. */
  --border: oklch(0.94 0.022 62 / 12%);
  --input: oklch(0.94 0.022 62 / 17%);

  /* Focus is the warm light made literal: `* { outline-ring/50 }` means every
     focusable thing in the app glows clay when you reach it. Replaces a flat
     grey that read as a disabled state. */
  --ring: oklch(0.742 0.112 62);

  /* Five actually-distinguishable series, not five greys — and unlike the set
     they replace, not byte-identical to the light ones. Ember leads because the
     brand should be series one; the rest walk the wheel at 55–100° spacing.
     All clear 3:1 on both background and card (5.92–9.80:1). */
  --chart-1: oklch(0.788 0.14 62);
  --chart-2: oklch(0.73 0.12 200);
  --chart-3: oklch(0.762 0.145 145);
  --chart-4: oklch(0.682 0.152 300);
  --chart-5: oklch(0.702 0.152 355);

  --sidebar: oklch(0.192 0.01 62);
  --sidebar-foreground: oklch(0.966 0.006 62);

  /* Unconsumed today, but given the brand value rather than left as
     oklch(0.488 0.243 264.376) — a stock shadcn blue-700 that was the only
     chromatic token in the dark theme and the only place light and dark
     disagreed on hue. If anything ever reaches for it, it lands in family. */
  --sidebar-primary: oklch(0.788 0.106 62);
  --sidebar-primary-foreground: oklch(0.206 0.03 62);
  --sidebar-accent: oklch(0.294 0.019 62);
  --sidebar-accent-foreground: oklch(0.966 0.006 62);
  --sidebar-border: oklch(0.94 0.022 62 / 12%);
  --sidebar-ring: oklch(0.742 0.112 62);
}
```

---

## Console — "saturation is spent only on machine state"

**Thesis.** A cool spine at hue 252 shared by both themes, every neutral carrying a small deliberate
blue-slate chroma so panels, rules and quiet metadata read as one machined material instead of
undyed grey. The hue never moves; only lightness and how much chroma a role is allowed to spend, and
chrome is capped around 0.045 because saturation in this app means *machine state* and chrome must
never compete with a status badge for that meaning. The sharpest consequence: `--primary` is
deliberately almost colourless. It fills the `done` badge and the default button, both things only a
person can issue, so they are marked with **value, not hue** — and no agent-driven state can borrow
the look by turning up its own saturation. Focus is the one piece of chrome allowed real chroma,
because focus is state too: it says where the keyboard is.

**Why it did not ship.** It is the most rigorous document in the set — 45 of 45 contrast claims
verified exact, and the only author who reasoned correctly about alpha compositing — and it ships
**zero** status tokens. That leaves its own thesis unimplemented: saturation is reserved for machine
state, and machine state stays hardcoded `bg-emerald-500`. A chrome-only retint is precisely the
"shadcn but slightly tinted" outcome this phase forbids.

**What shipped anyway.** One graft. Console's dark `--input` is opaque, and its reasoning is the
reason the shipped palette's is too: *a field boundary has to hold a fixed 3:1 whatever is behind
it, and a value that floats with its backdrop cannot promise that.* `border-input` is the sole
boundary of every `bg-transparent` field (`input.tsx`, `textarea.tsx`, `select.tsx`,
`input-group.tsx`), so this is the entire dark form surface. Console's own `--input` values are the
only ones in the set that genuinely clear the bar in **both** themes.

**The critique nobody fully answered.** Console argued that anchoring Telar at hue 264 makes it
"look like a t3code fork wearing its own logo" — and the shipped palette's light spine is t3code's
zinc, its anchor is t3code's 264, and its dark spine is byte-identical to what Telar had. If that
reads as derivative in use, the cheap fix is moving `--primary` to hue 258 or 272 and giving the
dark spine chroma 0.006; neither disturbs any verified contrast number materially.

```css
:root {
  /* Cool spine, hue 252, shared by both themes. Every neutral carries a small
     deliberate blue-slate chroma so panels, rules and quiet metadata read as
     one machined material instead of undyed grey. The hue never moves; only
     lightness and how much chroma a role is allowed to spend. Chrome is capped
     around 0.045 on purpose — saturation in this app means machine state, and
     chrome must never compete with a status badge for that meaning. */
  --background: oklch(0.975 0.005 252);
  --foreground: oklch(0.215 0.032 252);
  /* Three surface levels, matching dark's three. Light gets them by climbing
     toward white rather than lifting off black, so cards read as paper on a
     desk and the popover is the only true white on screen. */
  --card: oklch(0.995 0.002 252);
  --card-foreground: oklch(0.215 0.032 252);
  --popover: oklch(1 0 0);
  --popover-foreground: oklch(0.215 0.032 252);
  /* Primary is deliberately almost colourless. It fills the `done` badge and
     the default button, and both are things only a person can issue — so they
     are marked with value, not hue, and no agent-driven state can borrow the
     look by turning up its own saturation. */
  --primary: oklch(0.255 0.045 252);
  --primary-foreground: oklch(0.985 0.004 252);
  --secondary: oklch(0.952 0.009 252);
  --secondary-foreground: oklch(0.255 0.04 252);
  --muted: oklch(0.952 0.009 252);
  /* The heaviest token in the app (~1550 call sites) and the source of every
     scrollbar thumb. Darker than the stock 0.556, which cleared 4.5:1 on the
     page but only managed 4.34:1 on --muted — and text-muted-foreground over
     bg-muted is a combination this UI makes constantly. */
  --muted-foreground: oklch(0.487 0.03 252);
  /* A real step away from muted rather than a copy of it, so hover and
     selection are felt rather than inferred. */
  --accent: oklch(0.93 0.014 252);
  --accent-foreground: oklch(0.255 0.04 252);
  /* Slightly deeper than stock red-500 to buy back the contrast lost by
     dropping the page off pure white; text-destructive is 186 call sites. */
  --destructive: oklch(0.545 0.205 25);
  /* --border is the decorative hairline and stays quiet. --input is the only
     thing outlining a bare bg-transparent field, so it is a boundary a person
     has to be able to find: darkened until it clears 3:1 on page, card and
     popover alike, which the inherited 0.922 never did (1.26:1). */
  --border: oklch(0.898 0.013 252);
  --input: oklch(0.635 0.03 252);
  /* Focus is the one piece of chrome allowed real chroma, because focus is
     state too — it says where the keyboard is. Anchor hue 200, the instrument
     cyan that also leads the chart ramp; it sits in the widest gap the status
     language leaves open, 37 degrees clear of both emerald and sky. */
  --ring: oklch(0.565 0.09 200);
  /* Five series in the app's own state vocabulary — cyan, green, amber,
     violet, red — staggered in lightness as well as hue so they survive
     greyscale and red/green confusion. Replaces five indistinguishable greys. */
  --chart-1: oklch(0.56 0.09 200);
  --chart-2: oklch(0.485 0.122 152);
  --chart-3: oklch(0.63 0.125 78);
  --chart-4: oklch(0.45 0.19 300);
  --chart-5: oklch(0.53 0.185 18);
  --radius: 0.625rem;
  /* The rail is chrome, so it steps off the canvas: it recedes below the page
     here, and lifts in dark where there is no room below the background.
     Either way cards stay the highest content plane. */
  --sidebar: oklch(0.96 0.008 252);
  --sidebar-foreground: oklch(0.215 0.032 252);
  /* Unreferenced today — shadcn leftovers. Kept in step with --primary so that
     if anything ever reaches for them it inherits this palette's decision
     rather than the stock blue that was sitting in the dark block. */
  --sidebar-primary: oklch(0.255 0.045 252);
  --sidebar-primary-foreground: oklch(0.985 0.004 252);
  --sidebar-accent: oklch(0.93 0.014 252);
  --sidebar-accent-foreground: oklch(0.255 0.04 252);
  --sidebar-border: oklch(0.898 0.013 252);
  --sidebar-ring: oklch(0.565 0.09 200);
}

.dark {
  /* The primary mode. Background stays within a hair of the old neutral's
     lightness and spends its whole budget on hue instead, which is what makes
     the shell read as a single instrument rather than as a dark grey app. */
  --background: oklch(0.16 0.014 252);
  --foreground: oklch(0.97 0.006 252);
  /* Surfaces lift off the background in even steps, so a menu over a card over
     the page is legible as three planes without asking a shadow to do it.
     Popover no longer equals card, as it did before. */
  --card: oklch(0.205 0.016 252);
  --card-foreground: oklch(0.97 0.006 252);
  --popover: oklch(0.235 0.017 252);
  --popover-foreground: oklch(0.975 0.006 252);
  /* Near-white, and the brightest thing in the interface on purpose — see the
     note in :root about what primary is reserved for. */
  --primary: oklch(0.93 0.012 250);
  --primary-foreground: oklch(0.205 0.02 252);
  --secondary: oklch(0.27 0.016 252);
  --secondary-foreground: oklch(0.97 0.006 252);
  --muted: oklch(0.265 0.016 252);
  --muted-foreground: oklch(0.74 0.022 250);
  --accent: oklch(0.29 0.02 252);
  --accent-foreground: oklch(0.98 0.006 252);
  --destructive: oklch(0.7 0.185 22);
  /* --border keeps its alpha: it has to sit on four surface levels — page,
     sidebar, card, popover — and one translucent value adapts to all of them
     where four opaque ones would have to be maintained. It is a tinted white
     rather than a pure one so a hairline does not quietly desaturate the panel
     it divides. --input drops alpha for the opposite reason: a field boundary
     has to hold a fixed 3:1 whatever is behind it, and a value that floats
     with its backdrop cannot promise that. */
  --border: oklch(0.86 0.03 252 / 14%);
  --input: oklch(0.535 0.03 252);
  --ring: oklch(0.72 0.115 200);
  /* Same five hues as light, lifted and re-staggered for a dark backdrop. */
  --chart-1: oklch(0.76 0.12 200);
  --chart-2: oklch(0.7 0.15 152);
  --chart-3: oklch(0.82 0.16 78);
  --chart-4: oklch(0.66 0.17 300);
  --chart-5: oklch(0.72 0.165 18);
  --sidebar: oklch(0.19 0.016 252);
  --sidebar-foreground: oklch(0.97 0.006 252);
  --sidebar-primary: oklch(0.93 0.012 250);
  --sidebar-primary-foreground: oklch(0.205 0.02 252);
  --sidebar-accent: oklch(0.29 0.02 252);
  --sidebar-accent-foreground: oklch(0.98 0.006 252);
  --sidebar-border: oklch(0.86 0.03 252 / 14%);
  --sidebar-ring: oklch(0.72 0.115 200);
}
```

---

## What would make this decision worth revisiting

Recorded from the judge's own uncertainty list, so a future reader does not have to re-derive the
doubts along with the decision.

- **A middle path nobody proposed.** The shipped status layer over a warm spine at hue ~62, chroma
  ≤0.012, with `--primary` left at 264 so the brand does not join the warm family. Probably the best
  palette available; it was not on the ballot.
- **Folding `blocked` into `--warning` deletes a distinction production makes 32 times.** The merge
  was backed with Ember's own numbers (its `blocked` lands ΔE 0.069 from `destructive` in light),
  but nobody put the two states side by side in a real loom view. `god-view.tsx` uses
  `bg-orange-500` and `bg-amber-500` in the same file; whoever wrote that thought it mattered. A
  sixth token at hue ~42 is easy to add, and its separation from `--destructive` at the shipped
  lightnesses has not been verified.
- **The dark switch off-track is the graft's visible cost.** Opaque `--input` takes it from `#383838`
  to `#5a5a5a`. The argument is that a chromatic `--primary` carries the on/off read by hue
  (ΔE 0.258), but a lighter off-track can simply look *on* at a glance regardless of contrast maths.
  The one-class fix if it looks wrong is `data-unchecked:bg-muted-foreground/25` in `switch.tsx` —
  not applied, because that is a component change, not a palette change.
- **Light `--info` at chroma 0.09 will read washed.** sRGB has almost no cyan gamut at L 0.51,
  "running" is the state users see most, and it sits beside `--verify` and `--destructive` at 0.20.
  Moving it toward hue 235 was tested and is worse — 225–235 fall out of gamut at that lightness,
  and the move trades separation from `--success` for a bigger loss against `--primary`.
- **`--chart-4` at hue 120 is olive** (`#6b7f09` light). Even 72° spacing puts it there. Zero
  consumers today, so it costs nothing to defer, but it is the value most likely to be called ugly.
- **Three things no palette fixes.** `text-muted-foreground/50` (92 sites) and `/60` (188 sites)
  fail AA under every proposal and are component debt; the 469 hardcoded named-ramp utilities will
  sit beside the new tokens looking wrong until `state-badge.tsx` and `god-view.tsx` migrate — and a
  correct tokenised half makes that mismatch *more* visible, not less; and `text-border` renders a
  `·` separator at 13 sites, a decorative token used as text colour.
