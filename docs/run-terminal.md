# Run on a terminal — #198 W4, and #890

Run is not a button with a log pane. It is a detached session on a real
pseudo-terminal, and the terminal is a first-class cockpit surface that Run is
one client of. **Since #890 it is not merely a client of that surface — it is IN
it**: a run is a chip in the Terminal tab's strip, beside the person's own
shells. §1–§6 are W4's; §7 is that merge, the transport it changed, and the
tools it added.

This file records the decisions a future reader will otherwise re-litigate, and
**one product limit that is easy to break by accident** — §5, which is the part
worth reading even if nothing else here is.

> **Superseded in part by "Run = a new terminal".** Everything below about ONE
> deployment per project — the slot, `replace`, the `unknown` state that held the
> slot, `release`, the liveness journal and the group probe after every exit — is
> gone. A run is now a terminal owned by the SESSION: each start opens a new one
> ("web dev", "web dev #2"), a busy port only warns, closing the terminal is the
> host's `/close` (SIGTERM to every group, SIGKILL a second later) and records who
> closed it, and Telar tracks no liveness — it records what the host reports. A
> restarted engine re-lists the terminals the host kept (`GET /state`). The
> headers of `manager.ts`, `launcher.ts`, `terminal-client.ts` and `journal.ts`
> carry the current reasoning; the transport, redaction and §5 below still hold.

The three modules it spans each carry their own reasoning in a header:
`apps/desktop/run-terminal-server.js`, `apps/engine/src/run/terminal-client.ts`,
`apps/engine/src/run/launcher.ts`. Read `docs/terminal-host.md` first — it is
W1's, and everything here sits on it.

## 1. What changed, and what deliberately did not

`apps/engine/src/run/manager.ts` used to `spawn` a child with two pipes. It now
launches through a **port** (`launcher.ts`) with two implementations:

| | `pipes` | `pty` |
|---|---|---|
| Where the process is held | this process, as a `ChildProcess` | Electron main, as a node-pty terminal |
| When it is used | no desktop shell — `bun run src/main.ts`, a test, a headless deployment | the packaged app |
| Streams | `stdout` and `stderr`, separately | **one** — a PTY is one device |
| Redaction | `stream.ts`, line by line | `pty-stream.ts`, escape-aware and width-preserving |

**The pipe launcher is the floor, not the old way.** There is genuinely no
pseudo-terminal to be a client of when there is no Electron, and a run still has
to work there.

Everything the singleton rests on is untouched: `reserve()` still claims the slot
in one synchronous block, `release()` is still the only way to clear an
`unknown`, and the journal still records a run before it starts.

## 2. Two servers, two tokens, on purpose

`browser-control-server.js` was the template — loopback only, bearer token, a
closed route set checked before a body is read — and the obvious economy would
have been four more routes on it.

**The closed route set is the security property, not decoration.** Adding "start
a process with this command line" to the browser surface would turn a leaked
browser token, which today buys driving a tab, into arbitrary code execution.
Two ports and two tokens cost about twenty lines in `main.js` and buy that the
blast radius of each is what its name says.

The run channel takes an **ephemeral port and a fresh token every launch**, with
no environment override. The browser channel has one because an installed app
exports it into every shell it opens; nothing has ever needed to predict this
one, so there is nothing to keep compatible and one less secret in a shell.

## 3. `unknown` had to be rebuilt, not restated

`manager.ts` could previously say: *the pid is only ever used while our own
`ChildProcess` has not yet fired `exit`.* Once the handle lives in another
process that sentence is false, and it is load-bearing — an `unknown` run keeps
holding its project's slot, and the failure being designed against is a host
that dies quietly while something downstream frees a slot for a dev server that
is still listening.

It is rebuilt out of four parts:

1. **The engine never names a pid.** `launcher.ts` hands back a `RunHandle` that
   knows how to stop what it started. Over the wire that is a **terminal id**,
   minted by the host and never reused, and the host honours an id only while it
   still holds the handle it names. A pid is reused by the kernel; an id is not.
2. **Only the host may say `exited`**, and only when node-pty's own exit event
   fired with a code. Nothing downstream manufactures one.
3. **A lost channel is `unknown`.** Stream ended, stream errored, attach refused,
   request unanswered — all of them settle the run `unknown` with the slot held.
   *There is no path from a lost channel to `exited`.*
4. **Silence is not health.** A TCP connection survives a process that has
   stopped answering, so the stream heartbeats and the engine runs a watchdog on
   it. Three missed beats, not one: a single miss is a busy event loop, and
   calling a healthy host dead costs a human a `release()`.

**Loss is not undone by a reconnect.** A run marked `unknown` stays `unknown`
even if the host turns out to have been fine, because `unknown` means "a human
has not checked yet" and only `release()` is a human checking.

### The one question still asked about a pid

`settle()` still asks whether the process **group** is gone, because `bun run dev
&` exits 0 with a server alive behind it. That question is `kill(-pid, 0)` — it
**delivers nothing**; it is a question, not a shot — and it is asked about a pid
that was never this process's.

The honest reading, which is at the call site too: the only way the answer can be
wrong is by reporting `alive` for a pid the kernel has re-handed to a stranger,
and that **holds the slot**. Wrong in the direction the singleton exists to be
wrong in.

It is *not* asked when the channel is lost. A dead channel tells us nothing about
the process behind it, and a `gone` from a pid we are no longer entitled to reason
about would free a slot on a coincidence.

## 4. Two things W1 measured that stayed true, and one that bites

- **A bad command is not `failed`.** A missing binary and an unusable cwd both
  fork successfully and fail *inside* the child, arriving as a nonzero `exited`
  with a real pid (126 and 1). `failed` is reachable only when the fork itself
  throws. So "the command was wrong" is read off the **exit code**, never off the
  fate — and that `failed` is terminal and frees the slot, because the end was
  observed.
- **The killer takes the positive pid.** "The process group of `pid`" is not
  expressible as a negative number on Windows. This change did not unify the two
  killers after all: the engine now stops through a `RunHandle` and never holds a
  pid to negate, so there is no longer a shared signature to agree on.
- **A PTY merges stdout and stderr.** They went into the same file descriptor
  and nothing downstream can un-merge them, so on the terminal path every
  captured line is recorded as `stdout`. `RunOutputLine.stream` is still honest
  on the pipe path.

## 5. The limit: a terminal is wider than its captured output

**This narrows what the word "secret" promises, and it is stated here rather
than discovered in a log.**

The promise attached to `secret` in `run/types.ts` is *"you will not see this
value in Telar"*, and it is kept by redacting **what the process writes**.
`pty-stream.ts` does that correctly over a byte stream now: never cutting inside
an escape sequence, never emitting a partial secret, and replacing a value with
mask cells of the same width so a positioned screen is not scrambled.

A terminal widens what a person can *do* inside that output, and redaction does
not reach two of those things:

- **A terminal echoes what is typed into it.** A secret a person types into a
  Run terminal — or that `env`, `printenv` or a shell's history expansion prints
  in that tab — is not something this redactor can recognise. It only knows the
  values a *configuration* marked secret, and it sees the process's output, not
  the keyboard.
- **The emulator's scrollback holds raw bytes, client-side.** xterm.js keeps
  what it was given. Redaction happens before the bytes leave the engine, so a
  configuration's secrets never reach it — but nothing the engine did not
  redact is redactable after the fact.

**Neither is a regression** — a log pane never protected against a person typing
a token either — and neither is silently accepted. The scope that is actually
kept: *a value a configuration marks secret does not appear in what Telar
captures, stores, or hands back.* That is what §3 of `run/types.ts` claimed on
day one and it still holds; what a terminal adds is a surface where a human can
put a secret somewhere Telar was never told about.

Making that stronger means either recognising secrets Telar was not given —
which is pattern-matching on other people's tokens, with a false-positive cost
paid on every line — or refusing to echo, which is refusing to be a terminal.
Both are product decisions rather than bugs, which is why this is a paragraph
and not a TODO.

### A run's terminal is writable, and read-only would not have narrowed this

**Decided by the owner, 2026-09-20.** A person can type into a run's terminal.

The question read as *"is there a shell behind a run"*, and there is not:
`resolveShell` spawns `/bin/sh -c "<command>"` — non-login, non-interactive, no
dotfiles, no prompt, no history. Keystrokes reach **the program the recipe
named**. But that does not make a run non-interactive, for two reasons:

- **A recipe can pin its shell.** `resolveShell` takes `config.shell` literally,
  so `{ program: "/bin/zsh", args: ["-lc"] }` is a legitimate saved recipe — and
  then it *is* a login shell.
- **Ordinary recipes are interactive anyway.** `psql`, `node`, an installer
  asking `Proceed (Y/n)`, a dev server waiting on `r`, a migration asking for a
  passphrase. Read-only makes every one of those a screen that watches you and
  cannot be answered.

The escape hatch read-only would have left — stop the run, open a Terminal tab,
do it by hand — takes the process **outside the slot, the journal and the
singleton** this issue's first milestone is made of. That is what settled it.

**And read-only would not have bought what it looks like it buys.** Everything
above this heading is true in both branches: redaction covers what the *process
writes* and never covered what a person types. Read-only narrows who can reach
the keyboard; it does not close this section.

**The cost that is not about secrets, and it is the sharper one: a run is a
project singleton that every session sees.** Two sessions with that chip open
are two keyboards on one process, with no ownership model and no indication to
either that the other is there. The panel already says the run belongs to the
project and already warns when it came from another worktree; nothing pretends
the second keyboard is not there.

### What the cockpit reads, and why not the obvious channel

> **Superseded in part by §7.** The cockpit does now read a run's terminal over
> `telar:terminal:data` — but it is still never given the frames this section is
> about. The renderer gets the engine's **redacted mirror** of them, so the
> reasoning below is what §7 had to satisfy rather than what it overturned.

The Run panel's emulator is fed by **`GET /run/bytes`, over the engine's HTTP
surface** — never by `telar:terminal:data`. Two independent reasons, one answer:

- `main.js` fans **raw node-pty bytes** to the IPC bridge. Redaction is
  engine-side, with one non-test call site in `manager.ts`. An xterm attached to
  the bridge would draw a run's secrets **unredacted**, silently undoing the
  work above.
- `terminalBridge()` returns `undefined` unless the host is local, deliberately
  — *a terminal that lies about which computer it is on is worse than no
  terminal*. A session on a **paired Mac** has no bridge, and its run is on the
  other machine anyway. The HTTP path is the only one that works there.

**`GET /run/output` is not retired by this**, and retiring it would cost two
readers: `run_output` is an agent tool, and an agent wants lines rather than a
stream with `CSI H` in it. The two windows share one cursor contract; `dropped`
counts lines in one and chunks in the other.

**The byte ring is kept as chunks rather than one buffer**, because eviction has
to be escape-safe: half a `CSI 1;31 m` is not a shorter escape, it is a parser
desync that eats whatever text follows. Every chunk left `createPtyRedactor`
whole, so dropping whole chunks cannot produce one.

### Who may reach a terminal, now that it matters

`TerminalHost.open` records an **owner** — `renderer` or `engine` — and
`write`, `resize` and `kill` refuse an id whose owner is not the caller, while
`list` does not mention one. Before this, `telar:terminal:list` handed the
cockpit every id in the process and `telar:terminal:write` checked only that the
sender was the cockpit's top frame.

That was latent rather than exploitable, because nothing surfaced a run's id.
Drawing a run's terminal in the panel is exactly the change that would have
stopped it being latent, so the guard is part of the same work rather than a
follow-up. It is also what makes the paragraph above a property rather than a
convention: the cockpit reaches a run's terminal through the engine, where the
bytes have been redacted, because there is no other way to reach it.

The default is `renderer`, which is the fail-closed direction — a caller that
forgets is refused an engine terminal rather than handed one — and an owner that
is neither **throws** rather than being rounded to one.

## 6. How it is proven

`apps/engine/test/run-terminal-channel.test.ts` drives the **real** desktop
server, because two hand-rolled ends of a protocol agree with each other by
construction and with nothing else.

Its central pair is the same setup with the opposite answer, which is the shape
W1's PTY-versus-pipe check used:

- the channel is killed → the run is `unknown`, a second `start` is refused
  `conflict`, and `activeRun` is still that run;
- the channel is healthy → the same run settles `exited`, `activeRun` is
  `undefined`, and a second `start` **succeeds**.

A test that only asserted the healthy half would prove nothing about the half
that matters. Three load-bearing clauses were removed in turn to confirm the
guards are not vacuous — rounding a lost channel to `exited`, ignoring the
stream ending, and disabling the watchdog — and each time the failure-path tests
failed while the healthy control kept passing.

`apps/desktop/run-terminal-server.test.js` covers what only that side can get
wrong: the token, the closed route set, the body cap, that the stream
**heartbeats** (a frame count, which an idle stream cannot produce), and that
frames emitted before anyone attached are still delivered — without which a
command that dies instantly leaves a run `starting` forever, holding its project.

## 7. A run is a shell in the Terminal strip — #890

W4 shipped a Run **tab**: its own panel surface, its own xterm, its own poll.
#889 gave the Terminal tab a strip of shells. That left the cockpit with two
surfaces for one idea — a person looking for *the thing that is running* had two
places to look — and with two emulators drawing the same kind of bytes through
the same `ptyByteWriter`.

**A run is a terminal the desktop holds, exactly as a person's shell is.** What
is different about it is not its bytes: it is that the process belongs to the
**project** rather than to whoever opened it. That is a property of one chip, not
a reason for a second surface. So the Run tab, `run-panel.tsx`, `run-terminal.tsx`
and `run-control.tsx` are gone, and a run is a chip in the Terminal strip with
its configuration's glyph and a state dot.

Everything that follows is that one difference, made enforceable:

- **`terminalIds` does not list a run's terminal.** That list is what
  `endTerminalForTab` kills when a Terminal tab closes. A run's id on it would
  stop another session's dev server because somebody here closed a tab.
- **Closing the chip stops nothing**, and its label says so
  (*"Close this chip — the run keeps going"*). The chip has its own stop and
  restart; the header menu keeps its own.
- **The active run always has a chip.** That is how a run an agent started
  appears, and how a live one you closed comes back on the next visit. An exited
  one stays closable and gone.
- **A renderer may read a run's terminal and may not address one.**
  `telar:terminal:adopt` grants being sent frames; `write`, `resize` and `kill`
  still refuse a renderer an engine id, so typing into a run and stopping it stay
  on the engine's routes, where the singleton and the journal are.

### The redaction decision

§5 said the cockpit must not read `telar:terminal:data` for a run, because
`main.js` fans **raw node-pty bytes** and redaction is engine-side with one call
site. Drawing a run in the strip is exactly the change that would have broken
that, and there were two ways out:

1. run the redactor **on the desktop side** for run terminals — the config's
   secret values already cross to the host at launch; or
2. keep ONE redactor in the engine and **mirror its output back** to the desktop
   for the renderer.

**Telar does (2).** A second copy of `pty-stream.ts` is a second place for the
promise in §5 to be broken, and it would be broken quietly: the desktop has no
run journal to compare against, so a drift between the two redactors would show
up as a screen that differs from the record, which nobody reads twice. With the
mirror there is exactly one redactor, and the renderer sees **byte-for-byte what
the journal holds** — which is a property a test can state, and
`run-terminal-channel.test.ts` does.

Concretely: `main.js` sends a run's raw frames only to the engine (it asks the
host `ownerOf(id)`, so this is a property of the terminal rather than of who
happened to register as a reader); the engine's `manager.ts` mirrors each
redacted slice back over `POST /mirror` on `run-terminal-server.js`; `main.js`
delivers those to whichever renderer adopted that id. `telar:terminal:adopt` is
gated on the host's own list of `TerminalOwner.ENGINE` terminals, so it cannot be
turned into a way to reach a person's shell.

**The frame carries the ring's cursor**, and that is what makes the join exact. A
chip attaching to a run that has been going for ten minutes needs the scrollback
the engine kept *and* the frames arriving while it reads it: it subscribes first
(buffering, drawing nothing), reads `/run/bytes` from the top, draws that, then
draws only the buffered frames the read did not already contain. Reading first
loses whatever lands in between; drawing the buffer first puts it above the
history it belongs after.

### Stream, not poll

- **Bytes.** With a bridge, the chip draws frames as the engine produces them.
  Nothing is on a timer. The poll survives for the one case with no IPC — a
  session whose Mac is not this one — at the cadence it had; making the iPad
  stream is out of scope. A settled run is read once and never again.
- **Status.** `RunManager.watch()` emits `run.status` on every transition,
  `GET /v2/sessions/:id/run/stream` carries them, and `useRunStatusFeed` reads
  `/run/status` **once per mount** and then follows. The masthead's pill used to
  ask every 4 s live / 12 s idle, for ever, in every open window; the Run tab's
  emulator asked for bytes every 500 ms on top. There is no `setInterval` and no
  poll cadence left anywhere under `components/run/`.
- **The frames carry the whole `RunView`**, unlike the session and agent feeds,
  because there is nothing to page back to: a run's status lives in the engine's
  memory and the only read of it is the poll this feed replaced. A reader that
  missed a frame is corrected by the next one rather than having to reconcile.
  `active` rides on the event rather than on the view, because no client can
  derive it — `release()` frees the slot while the run stays `unknown` for ever.

### How a persisted Run tab migrates

`migratePanelTab` maps `run` to `terminal`, which is what stops a saved Run tab
restoring as a pane nothing renders. Folding it into the Terminal somebody also
had open is **`collapseTerminalTabs`** — #889's reducer, unchanged: it collapses
every terminal-kind tab into one at the first one's position, folds their params
together so no running shell is orphaned, moves the active selection if it was on
a folded tab, and returns the **same object** when nothing changed, so a session
migrated once is not rewritten on every mount.

The chip is deliberately **not** seeded into the params. The surface reads
`/run/status` once on mount and gives the project's live run a chip — the same
path a run started by an agent or by another session takes — so there is one rule
rather than a migration that has to agree with it.

### The tools

`run_output` gains `tail`, `grep` and `stream`. **None of them moves the
cursor**: they narrow what comes back within the window `after` opened, so a
caller that greps has still read past what did not match and can resume over
everything later. An empty answer says *which* empty it is, because "no output
yet" told to a model whose filter simply matched nothing is how it concludes the
process is silent.

```
run_output  { runId?, after?, tail?: 1..1000, grep?: string, stream?: "stdout"|"stderr" }
run_wait    { runId?, pattern?: string, ready?: boolean, exit?: boolean, timeoutMs: 0..60000 }
            → { fired: "pattern"|"ready"|"exit"|"timeout", cursor, lines }
run_stop    { runId?, signal?: "SIGTERM"|"SIGINT"|"SIGKILL" }
run_status  → … terminalId, so an agent can say where in the cockpit the output is
run_start   → the same
```

**`run_wait` is the one that changes what an agent can do.** Every agent given
this feature did the same thing: started a server, slept a guess, curled, and
reported the connection refusal as the project's bug. The answer says WHICH
condition fired because *"it came back"* and *"the server is up"* are not the
same fact. It is decided **engine-side over state the daemon already holds** —
the lines, the readiness verdict, the status — so nothing about waiting reaches
the desktop; a wait that polled the host would be the poll this milestone deleted
wearing a tool's name. `ready` on a recipe with no `readinessUrl` is **refused**
rather than waited out, since it could only ever arrive at a `timeout` an agent
would read as "it did not come up". `exit` fires on the run being **settled**,
not on its shell being gone: the window between those two is where a run can
still become `unknown` with the slot held.

It is on `RUN_READ_ONLY_TOOLS`. It blocks, which is not what "read" usually
suggests — but it signals nothing, starts nothing and changes nothing, and behind
an approval prompt the deterministic path would be the expensive one.

**`run_stop`'s `signal` is the polite attempt's only.** A dev server that traps
SIGTERM to drain connections stops the way Ctrl-C stops it and no other way; the
escalation stays SIGKILL whatever was asked for, because a second attempt that
can be refused is not a second attempt. A closed set of three, not a free field.
On Windows a requested signal is ignored and `platform.ts` says so, rather than
pretending `taskkill` has one.
