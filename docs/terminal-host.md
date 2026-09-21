# Telar's PTY host — what shipped for #198 W1

Built. `apps/desktop/terminal-host.js` owns real pseudo-terminals in the
Electron main process, `apps/desktop/preload.js` carries the bytes to the
renderer, and `apps/desktop/pty-host.electron-test.js` proves the thing is a
terminal rather than a pipe.

This file records the three decisions a future reader will otherwise re-litigate
and the two packaging facts that are not written down anywhere else.

## 1. Telar is a terminal emulator, not a shell configurator

We contribute the window, the tabs, the background, a font fallback chain, and
an honest identity. The user's dotfiles own everything else — **including when
the result looks wrong under our theme**. No colour fixes, no injected shell
config, no prompt wrapper.

The font is a chain, not a choice: the terminal prefers a Nerd Font the person
has installed (JetBrainsMono, CaskaydiaCove, FiraCode, Hack, Meslo, in that
order), then the cockpit's own mono face, then the platform monospace. A prompt
or `eza --icons` draws its glyphs with whatever the person already put on the
machine; the cockpit's Appearance font is what the terminal falls back to, not
what it imposes.

The whole of what Telar puts in a terminal's environment:

| Variable | Value | Why |
|---|---|---|
| `TERM` | `xterm-256color` | What the emulator (xterm.js) actually is |
| `COLORTERM` | `truecolor` | xterm.js paints 24-bit; `xterm-256color` cannot say so. Overwrites an inherited value: the emulator decides this, not the parent shell |
| `TERM_PROGRAM` | `Telar` | **Public API — see below** |
| `TERM_PROGRAM_VERSION` | the shell's `app.getVersion()` | The same number electron-builder stamps into the bundle |

And one variable it **removes**: `ELECTRON_RUN_AS_NODE`. That one is Telar's own
— `main.js`'s `childEnv` sets it for the processes it forks, so a shell opened
inside Telar inherits it and then every `electron` the person runs in that shell
silently becomes a bare node. `scripts/package-desktop.sh` carries a paragraph
about being bitten by exactly this. Taking our own marker back out is not
configuring someone's shell; it is not lying to it.

### `TERM_PROGRAM=Telar` is public API

People branch on `$TERM_PROGRAM` in their shell startup files — the owner's own
`~/.zshrc` does. The string is `Telar`, it is stable, and changing it silently
breaks dotfiles we never see. If it ever has to change, that is a release note,
not a refactor. It is exported as `TERM_PROGRAM` from `terminal-host.js` and
asserted from **inside a spawned shell** (`printenv TERM_PROGRAM`) by the
Electron test, so a rename cannot pass CI quietly.

## 2. The PTY lives in Electron main, not in the engine

The engine runs under **two** runtimes:

- `bun run src/main.ts` in development (`apps/engine/package.json`);
- **Electron-as-node** when packaged — `apps/desktop/main.js` forks it with
  `execPath: nodeExecPath()` and `ELECTRON_RUN_AS_NODE: "1"`.

A native addon over there would have to load under both. In Electron main there
is one ABI, and the browser host already lives in that process.

**Policy stays in the engine; the desktop host holds the handle.** The host owns
PTYs and reports facts about them. What a dead PTY means for a project's
deployment slot is `apps/engine/src/run/`'s question.

## 3. `unknown` is not a rounding of `exited`

`apps/engine/src/run/types.ts` defines `unknown` as *"we cannot vouch that this
is dead"*, and an `unknown` run **keeps holding its project's slot**. The host
mirrors that exactly, and the whole fate model exists to protect it:

| Fate | Produced by | Means |
|---|---|---|
| `exited` | **only** node-pty's own exit event | Observed, with a code |
| `failed` | the spawn threw, **or** Telar refused it before spawning | No process was ever created — and no exit code |
| `unknown` | everything else | We stopped being able to vouch — the slot stays held |

`unknown` is reported when the host is disposed with terminals still live (the
app quitting), when a kill could not be delivered, when a kill was delivered and
no exit was seen within five seconds, and when a pty's fd raises an error. The
pid is always named in the sentence so a human can go and look.

The failure being designed against is the quiet one: the shell process dies, and
something downstream frees a slot for a dev server that is still listening.

### One thing W4 must not assume

A **missing binary** does *not* produce `failed`. node-pty forks the pty
successfully and `execvp` fails inside the child, so it arrives as an ordinary
**nonzero `exited` with a real pid** (measured: exit 126). So "the command was
wrong" has to be read off an exit code, never off the fate.

An **unusable cwd** is different, and since #845 it is refused before anything
is spawned — `failed`, with a sentence naming the directory and **no exit
code**. It had to be: on macOS node-pty does not `chdir` in our process, it
hands the cwd to `spawn-helper`, whose entire handling of a `chdir` it cannot
make is `_exit(1)` with nothing written anywhere (1.1.0,
`src/unix/spawn-helper.cc`). Without the check, a person who opens a terminal
on a directory that has been moved or unmounted gets a blank terminal that
closes and no message. `unusableCwd()` is a *diagnostic*, not a gate: the
kernel's `chdir` in the child still enforces it, and a directory that
disappears between the check and the spawn ends the way it always did.

### Reading an `exited` — the exit code alone is not the answer

node-pty only assigns `exit_code` under `WIFEXITED` (`src/unix/pty.cc:110`,
`:189-194`), so a **signalled** child comes back as `{exitCode: 0, signal: 9}`.
On the code alone that is indistinguishable from a command that succeeded.
#845 was an hour of CI spent on exactly that: a stray ending from a SIGKILLed
shell read as "an unusable cwd exited 0". Look at `signal` before believing a 0.

## 4. Killing — one function, with `platform` injected

`killTerminalTree(pid, signal, { platform })`:

- **POSIX**: node-pty calls `setsid()`, so the child leads its own session and
  process group with `pgid === pid`. `kill(-pid)` reaches the `bun`/`node`/`vite`
  descendants a bare `kill(pid)` would strand.
- **win32**: there is no process group to signal. Terminating the shell orphans
  its children, which keep the port and the CPU; the ways out are `taskkill /T`
  or a Job Object.

**Windows packaging does not exist and this does not add it.** What the injected
platform buys is that the win32 branch is not dark until it does — the same
pattern as `volumes.ts:78`, `host-path.ts:192`, `git.ts:168`.

### Shape, for a later unification with the engine's killer

`apps/engine/src/run/manager.ts` injects `kill?: (pid, signal) => void` and calls
it with an **already-negated** pid (`this.kill(-pid, signal)`). This host takes
the **positive** pid and negates internally, because "the process group of `pid`"
is not expressible as a negative number on Windows — a shared signature has to
pick one, and only the positive pid can describe both platforms. If W4 unifies
them, the engine's call sites are the ones that move.

## 5. Two packaging facts, both measured

Neither is guessable and both fail at **runtime**, so `apps/desktop/after-pack.js`
asserts them on the built `.app` and a failure stops a package instead of
shipping one.

### node-pty must be outside the asar

`build.asar` is `true` and a `.node` cannot be loaded from inside an archive.
node-pty's own loader rewrites `app.asar` → `app.asar.unpacked` when it resolves
`spawn-helper`, which is the package stating the requirement. Hence
`build.asarUnpack: ["**/node_modules/node-pty/**"]`.

### `spawn-helper` ships mode 0644 and nothing ever chmods it

node-pty 1.1.0's npm tarball records **both** `prebuilds/darwin-arm64/pty.node`
and `prebuilds/darwin-arm64/spawn-helper` as `-rw-r--r--`. The package's
`install` script only decides whether to rebuild; `postinstall` only tidies
`build/Release` for Windows. Neither sets the bit. Without it every terminal
dies with `posix_spawnp failed` — an error naming neither the file nor the mode.

`ensureSpawnHelper()` repairs it at runtime for a dev checkout;
`after-pack.js` sets it at build time so a packaged Telar on a read-only volume
never has to write into its own bundle.

### What was *not* a problem, contrary to expectation

`apps/desktop/package.json` has `trustedDependencies: ["electron"]`, and bun
does not run an untrusted dependency's install scripts — so the expectation was
that node-pty would be silently skipped and fail at runtime. **It is not.**
node-pty ships its darwin prebuilds *inside the npm tarball*, so they are
extracted by a plain `bun install` with both of its scripts blocked, and the
loader falls back to `prebuilds/<platform>-<arch>/`. There is also no
`node-gyp` and no `electron-rebuild`: node-pty 1.1.0 is built on
`node-addon-api` (Node-API), so the prebuilt binary loads under Electron 43's
ABI unrebuilt. Verified by loading it under a real Electron 43.1.1.

The version is pinned **exact** (`"node-pty": "1.1.0"`) rather than caret-ranged,
because everything above is a fact about one published tarball.

There are no linux prebuilds in that tarball. This is fine — the product ships
macOS-only and the `electron` CI job runs on `macos-latest` — but it is why
`terminal-host.js` must never `require("node-pty")` at load: the desktop **unit**
suite runs on `ubuntu-latest`.

## 6. How it is proven

`bun run test:desktop:pty` (registered in CI's `electron` job) runs eleven cases
against real Electron, a real addon and a real shell. The central one:

```sh
test -t 1 && echo TTY_YES || echo TTY_NO
```

A pipe cannot answer `TTY_YES`. Every other way of starting a process in this
repository — `spawn`, `fork`, `Bun.spawn` — hands the child a pipe and would
fail this. **Case 2 runs the identical script through a pipe and requires the
opposite answer**, so a run where the PTY silently degraded cannot pass.

The CI marker is a **count plus those two opposite answers** —
`PTY_HOST_OK 11/11 pty=tty pipe=not-a-tty` — printed only after all eleven cases
pass. It is deliberately not a describe-name: a *skipped* test prints its own
name, which is how this repo's previous "prove it ran" guard was vacuous from
the day it was written (see `docs/operations/dispatch-board.md` §3). Both
directions were exercised before it was committed: the gate passes on a real run
and fails on **both** of its checks when the spawn-helper repair is removed.

`apps/desktop/terminal-host.test.js` covers the logic with an injected spawner,
including the `failed` and `unknown` states that cannot be staged against a real
shell. It never loads the native module, and asserts that it did not.
