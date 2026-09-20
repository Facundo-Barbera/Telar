# Run on a terminal — what shipped for #198 W4

Run is not a button with a log pane. It is a detached session on a real
pseudo-terminal, and the terminal is a first-class cockpit surface that Run is
one client of.

This file records the decisions a future reader will otherwise re-litigate, and
**one product limit that is easy to break by accident** — §5, which is the part
worth reading even if nothing else here is.

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
