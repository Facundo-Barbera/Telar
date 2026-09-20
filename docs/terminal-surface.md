# Telar's terminal surface — what shipped for #198 W2

Built. `apps/web/components/session/terminal-surface.tsx` is xterm.js in the
cockpit's right panel, on the PTYs W1 put in the Electron main process
(`docs/terminal-host.md`). `Terminal` sits in the strip beside Editor, Data,
LaTeX and Run, and you can have as many of them as you open.

This file records the decisions a future reader would otherwise re-litigate, and
the three places the brief for this work turned out to be wrong.

## 1. It is not shaped like the browser surface, and it should not be

The issue says to mirror it. Taken literally that costs days and produces the
wrong thing.

`apps/desktop/browser-manager.js` is 4,545 lines and
`apps/web/components/browser-live.tsx` another 2,617, because a page renders in
**another process** and a `WebContentsView` has to be positioned, zoomed,
clipped, popup-managed and profile-bound over our own window. An emulator
renders in this document. There is no native view to host, nothing to keep in
register with a scroll position, and no second process to authenticate.

What the browser surface has that this one genuinely needed is **one call** —
`claimChords` — and it is four lines. The reuse that mattered was the panel's
own: `SURFACES`, `MULTI_INSTANCE`, `nextPanelTabId` and the tab-params round
trip already did everything a second, third and fourth terminal needs.

## 2. Three colours and a font, and nothing else from the Look

`lib/terminal-theme.ts`. `--card` for the background (the panel draws on the
raised surface; the window's base colour would read as a hole in it),
`--foreground` for text, `--primary` for the caret. Font is `--app-font-mono`
and `--app-font-mono-size` — `appearance.ts:111` already documents that token as
covering "the terminal".

**The ANSI sixteen are constants, not Look tokens.** `looks.ts`,
`theme-palettes.ts` and `appearance.ts` carry no sixteen-colour set between
them, and the reason not to add one is the owner's own setup: oh-my-posh
catppuccin_frappe and his syntax highlighting are **truecolor** and bypass a
palette entirely. Sixteen more values to maintain that his terminal would never
draw with. They are xterm.js's own defaults so that other people's programs —
`ls --color`'s blue directory — render as they do everywhere else, and
`terminalTheme(read, overrides)` is how anything changes them.

### The canvas in `cssColorReader` is not decoration

The app's tokens are `oklch()`. xterm's colour parser handles `#rgb`,
`#rrggbb`, `rgb()` and `rgba()` and **throws** on anything else, which would
take the whole surface down at construction. Assigning to a canvas
`fillStyle` makes the browser's own CSS parser do the conversion and hand back
exactly the set xterm accepts.

It reads the value back through **two** sentinels because a `fillStyle` the
parser rejects is *silently ignored* — the previous value stays. One assignment
could not tell "converted" from "refused", and the refused case would have
handed back a sentinel and called it the Look's background.

### It is correct that a light Look makes his autosuggestions invisible

His `~/.zshrc` hardcodes `ZSH_AUTOSUGGEST_HIGHLIGHT_STYLE="fg=#666666"`. We were
asked for that colour and we drew that colour. No correction pass, no injected
shell config, no prompt wrapper — `docs/terminal-host.md` §1. Same for
`eza --icons` under a font that is not a Nerd Font: that is a choice in
Settings ▸ Appearance, not a bug for this surface to work around by substituting
a face he did not pick.

## 3. Three keys, two mechanisms — and the platform is not what eats them

`lib/terminal-keys.ts`. Escape (`bindkey -v`), `^W` (0x17,
`backward-kill-word`) and `^R` (0x12, history search) are taken back and written
to the PTY directly.

**The obvious culprit is the wrong one.** `main.js`'s menu carries
`role: "reload"` and `role: "windowMenu"`, and on macOS those are **⌘R and ⌘W —
Command, not Control**. A bare `^R` reaches the page here perfectly well. What
would actually have eaten it is the cockpit's own `useCommandKeys` window
listener: `resolveWebCommandKeyAction` treats any ctrl/meta press as "chorded",
so its focus rule — the one that protects a text field from a bare key —
deliberately does *not* protect a field from `^R`. Nothing is bound to these
chords in the shipped keymap, but the settings pane lets a person bind anything
to anything.

So two mechanisms, covering different halves:

- **`stopPropagation`**, from inside xterm's own key handler. That listener sits
  at the end of the bubble chain and never consults `defaultPrevented`, so
  `preventDefault` alone would not stop it. This is the load-bearing half.
- **`claimChords(TERMINAL_CHORD_CLAIMS)`**, which is the only thing that reaches
  the main process: a command carrying a `menu` becomes a macOS key equivalent,
  and macOS matches those before the page is asked at all. No bubble to stop
  there.

The handler **returns `false`** so xterm stands its own encoder down; otherwise
the byte would be sent twice.

One cost, stated: this repo's chord vocabulary folds Control and Command into
one `CommandOrControl` token, so claiming `^W` also stands ⌘W down while a
terminal tab is up. Nothing is bound to either by default.

### The panel and Escape

The brief called "the panel no longer closes on Escape" a consequence of this
work. **It never did.** `toggle-panel` is `CommandOrControl+\` and is the only
thing that opens or closes the panel; there is no Escape handler anywhere on
that path. Nothing had to change and nothing did.

## 4. A shell outlives a tab switch and dies with its tab

`PanelSurface` renders only the **active** tab, so this component unmounts every
time somebody looks at the Diff. Two consequences, and they are the whole
lifecycle:

- **Unmount does not kill.** A `cd` and a half-typed command are not something
  to throw away because of a glance.
- **Closing the tab does.** `endTerminalForTab` is called from
  `session-cockpit.tsx`'s `onCloseTab`, which is the only place that can tell a
  switch from a close, and it runs *outside* the reducer because a reducer runs
  twice under StrictMode.

Between those two, a remount **re-adopts**: the PTY's id round-trips through the
tab's own params (the trip the Diff's filter and the Editor's open file already
make), and `list()` — exactly the question W1 shipped for this — says whether it
is still alive. Without adoption every glance would leak a shell.

**The scrollback does not come back.** The host forwards bytes; it does not
record them. An adopted terminal arrives with a live shell and an empty screen,
and nothing is written into the buffer to explain that — the buffer belongs to
the program on the other end.

## 5. Images: SIXEL and IIP on. Kitty is not a switch that exists.

`TERMINAL_IMAGE_OPTIONS`. IIP is the one that matters: the owner's `~/.zshrc`
runs `fastfetch --logo-type iterm` when it detects an iTerm-ish terminal, so his
logo arrives as IIP on every new tab. `enableSizeReports` is on with it, because
a program that cannot ask the cell size in pixels (CSI 16 t) cannot scale an
image to the grid.

**The brief said to turn kitty off and to call it "alpha upstream, deliberately
not enabled". Both halves are wrong at `@xterm/addon-image@0.9.0.`**

- There is nothing to turn off. The addon implements SIXEL and IIP and nothing
  else: `IImageAddonOptions` carries no kitty key and `src/` contains no kitty
  handler. "kitty: disabled" would describe a switch that does not exist.
- What the README calls **alpha is IIP** — the protocol we depend on. Its
  §Status reads: *"Sixel support and image handling in xterm.js is considered
  beta quality. IIP support is in alpha stage."* So the least mature thing here
  is the one carrying his logo, and that is the first thing to suspect when one
  draws wrongly.

That is asserted against the installed package rather than written only here, so
the day the addon grows kitty support the test fails and somebody decides on
purpose.

## 6. How it is proven, and what is not proven

`bun run test:web`. **3636 tests across 287 files on `main`, 3699 across 292 on
this branch** — the +63 and +5 this adds, so the new tests demonstrably ran,
where a green suite would only show that nothing already there broke. Both
numbers were measured on the same checkout, on the same commit this branch is
based on, rather than carried over from an earlier base.

The two checks that carry the weight are in `lib/terminal-session.test.ts`,
against a **real** xterm.js (never `open()`ed — the parser and buffer need no
canvas):

- **Cell attributes, not text.** An SGR run is pushed through the bridge and the
  buffer's `getFgColor()` and `isBold()` are read back, *and* a plain cell
  beside it is asserted to carry neither. "The text appeared" is satisfied by an
  emulator that ignored every escape sequence; this is not. Truecolour and a CUP
  cursor move are checked the same way.
- **The octet, not the handler.** `^W` asserts `` arrived at the host's
  `write`, once, with `stopPropagation` called. "A handler ran" is satisfied by
  a handler that fires and swallows the byte — which is exactly the bug.

Both were **falsified before being committed**: dropping SGR on the way in fails
both colour tests while "RED plain" is still on screen; removing
`stopPropagation` fails the key test on that assertion alone; returning `true`
instead of writing fails all three key tests. Adoption was falsified by forcing
a fresh `open()`, and "unmount does not kill" by adding a kill to the teardown.

`lib/terminal-keys.test.ts` exercises the chord claim **in both directions**: a
command rebound to `^R` is suppressed while the claim is up, is live before it,
and is live again after release — a test that only checked today's keymap would
pass with the claim list empty.

### Not proven, and it cannot be from CI

**That an image renders.** The image addon decodes on a canvas and a worker and
this environment has neither — `@xterm/addon-webgl` does not even load here (no
WebGL2), which is how the DOM-renderer fallback path gets exercised. What the
tests assert is that the addon **activated** (`windowOptions` flips from `{}` to
three `true`s), which distinguishes "in the bundle" from "ran" and goes no
further.

The acceptance criterion is therefore the owner's own: **`fastfetch` rendering
correctly in a new tab** — image protocol, truecolour, Nerd Font glyphs and
cursor position at once. His shell cannot run in CI, and no check in this
repository is a substitute for looking at it.
