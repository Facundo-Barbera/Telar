# What the desktop shell's main process holds — read, 2026-09-12

Issue #296: `/Applications/Telar.app/Contents/MacOS/Telar` (the Electron MAIN
process, not the engine child) climbed from 0.1% CPU / 190 MB RSS at launch to
99% CPU / 2.5 GB RSS / 16.7 GB physical footprint over five hours with ten
cockpit sessions, then died with EXC_BREAKPOINT / SIGTRAP on thread 0.

**This document is read, not measured.** The app could not be run for it (no dev
shell, no long-running process), so every row below is an add/remove audit of the
source. The one thing the `sample` in #296's comment gives us is a shape, and the
audit is scored against it:

> All 2,111 samples on `com.apple.main-thread`, inside one
> `__CFRUNLOOP_IS_CALLING_OUT_TO_A_SOURCE0_PERFORM_FUNCTION__` callback, ~30
> frames of JIT'd JS. Continuous, not periodic. `mach_msg2_trap` appears as a
> leaf 7 times in 3 s — the main thread never went back to its event wait.

In Electron's main process the Node/libuv event loop is pumped from a CFRunLoop
Source0, so *any* main-process JS appears under that frame. The signal is not
*where* it is, it is that it never stops: JS is running essentially all the time.
That rules out one-shot and periodic work (the updater's 6-hour interval, the
appearance poll, a single expensive tick) and points at a handler driven by a
stream — page events and CDP messages are the only two — whose **per-event cost
grew over the evening**.

---

## The audit

Every collection, listener registration and array push in the main process,
against where the matching removal is.

| # | What | Added | Removed | Verdict |
|---|---|---|---|---|
| 1 | `tabs[]` records | `createTab`, `restoreInventory` | `closeTabRef`, `removeTab`, `destroyed` | **Grows with every scope ever shown.** Nothing calls `releaseScope` — it is on the preload bridge and no renderer uses it — so a session the human visits and leaves keeps up to 12 tab records for the life of the process. |
| 2 | `scopeProfiles`, `scopeProjects`, `scopeProfileOverrides` | `declareProfile` (the engine re-declares **every turn**), `setScopeProfile`, `restoreInventory`, `adoptScope` | never | **Unbounded in scope count.** `adoptScope` moves `activeTabIds`/`agentTabIds`/`agentTabClosed` off the source scope and leaves these three behind; `releaseScope(destroy)` clears the first three and not these. |
| 3 | `boundsByScope` | `setBounds`, per scope | never | **Unbounded in scope count.** |
| 4 | `lastAgentInputAt` | `stampAgentInput`, `callToolInner`, `runOnTab` | never | **Unbounded in scope count.** |
| 5 | `activeTabIds` | `createTab`, `selectTab`, `restoreInventory` | `removeTab`, `closeTabRef`, `releaseScope(destroy)` | Bounded *if* a scope is released. Nothing releases one. |
| 6 | `tab.expectedReports[]` | `stampAgentInput` — one per agent click/keypress | consumed by `noteHumanInput`; TTL-filtered **only there** | **Unbounded per tab.** An expectation whose preload echo never arrives (hidden view, a page that reports nothing, a subframe) is never pruned, because the prune only runs on the path that consumes one. |
| 7 | `tab.console[]`, `tab.network[]` | `debug.on("message")`, per `Runtime.consoleAPICalled` / `Log.entryAdded` / `Network.requestWillBeSent` | `slice(-200)` after **every** push | Capped at 200 **entries**, uncapped in **bytes**: an entry holds `arg.value ?? arg.description` (a console.log of a large object or string, whole) or `request.url` (a `data:`/`blob:` URL, whole). 200 × multi-MB is gigabytes, per tab. And `slice` allocates a fresh 200-element array **per message**. |
| 8 | `bindTab`'s 11 `wc.on(...)` | `createViewForTab` | never explicitly | Safe: they are on the WebContents, which `hibernateTab` destroys. Asserted now by a test that hibernate/wakes five times and checks the listener count is unchanged. |
| 9 | `debug.on("message")`, `debug.on("detach")` | `ensureDebugger`, behind `tab.debuggerListenersBound` | never explicitly | Safe for the same reason; the flag is reset in `createViewForTab`, where the debugger is a new object. |
| 10 | `loadAllowingReplacement`'s 6 `wc.on(...)` | per load | all six in one `finally` | Balanced. This is the 6 in "17 registrations against 6 removals" — the pair is complete. |
| 11 | `healthListeners` (module-level, extension-host.js) | `observeHealth()`, per host | **never** | Grows with host count. A host is per partition per manager, and a manager is rebuilt on a translucency change, so each rebuild strands one host per partition — holding its session and window. |
| 12 | `session.serviceWorkers.on("console-message")` | `observeHealth()`, per host | **never** | Worse than #11: `session.fromPartition(p)` is a process-lifetime singleton, so a rebuilt host adds a *second* listener to the *same* emitter. |
| 13 | `extensionHosts` Map | `extensionHostFor` | never; `destroy()` does not clear it | Bounded by partition count. |
| 14 | `installPromises`, `liveHelpers` (extension-host.js) | install / helper spawn | `finally` / the pid's own `exit` | Balanced. |
| 15 | `pendingPopupTabs` | `trackPopupTab` | on settle, both ways | Balanced. |
| 16 | `uiHolds` | `addUiHold` | `removeUiHold` on the window's `closed` | Balanced. |
| 17 | `activeToolCalls` | `dispatch` | `delete` at zero | Balanced. |
| 18 | `agentTabClosed` | `noteAgentTabClosed` | `agentTab` (reports and clears), `releaseScope(destroy)`, `adoptScope` | Bounded per scope; grows with scope count for a scope that never calls again. |
| 19 | `tab.refs` | `snapshot` | `clear()` on the next snapshot and on `did-start-loading` | Bounded. |
| 20 | `profiles.migrations` | `resolve()` | `drainProfileMigrations` splices unconditionally | Balanced. |
| 21 | `applyGeometry`'s promise chain | every geometry trigger | `scheduled` coalesces; at most one run in flight and one queued | Bounded. The comment is accurate. |
| 22 | `applyExternalLinkPolicy`'s `did-create-window` | recursively, per child window | never | Bounded by window count. |
| 23 | ipcMain handlers, `autoUpdater.on`, the update `setInterval` | module top level / `configureAutoUpdater` once | n/a | Registered once. |

## The cost that grows

Rows 1–5 are not, by themselves, much memory — a scope's leftovers are a few
map entries. They matter because of what walks them.

**`emitState` does two O(all tabs) passes and is on every page event.** It is
called from `did-start-loading`, `did-stop-loading`, `did-navigate`,
`did-navigate-in-page`, `page-title-updated`, `page-favicon-updated`,
`destroyed`, and from `noteHumanInput` — i.e. once per report of a human's hands
in any page. Each call:

1. `state(scope)` — serialises that scope's tabs and the whole profile list, and
   structured-clones it across the IPC boundary to the renderer;
2. `persist()` → `inventory()` → **every tab of every scope**, with a
   `webContents.getURL()` into Chromium for each live one, then
   `serializeInventory` over the lot — and hands it to a store that throws all
   but the last away within 150 ms.

So the per-event cost of an SPA calling `pushState`, or of a human typing, is
proportional to the number of tabs the process has ever held. That is the
"handler whose work grew over the evening" the sample's shape asks for.

**Row 7 is the memory, and plausibly the CPU too.** Every tab attaches the
debugger at creation (`createViewForTab` → `ensureViewport` → `applyGeometry` →
`ensureDebugger`) and enables `Network`, `Runtime`, `Log` and `Page`. Every
request and every console line of every open page in every session is therefore
deserialised into the main process for the life of the tab, whether or not an
agent ever asks for the logs — and each one reallocates a 200-element array. A
page with a chatty console or heavy telemetry is a continuous main-thread JS
load arriving on the CDP IPC source: the sample's shape exactly. The retained
bytes are unbounded because the entry text is.

## What was fixed

Rows 2, 3, 4, 6, 7, 11, 12 and the `emitState` cost above. Rows 8, 9, 10, 14–17,
19–23 needed nothing. Row 1 is left alone deliberately: releasing a scope is a
lifecycle decision for whoever owns the cockpit's session list, not something the
manager may take on its own, and with the persist walk coalesced its cost is no
longer per-event.

## What is still unproven

**Which of these was the 16.7 GB.** Nothing here was measured against a running
app; the byte cap in row 7 is the only fix with a magnitude large enough to
explain the footprint on its own, and that is an argument from the shape of the
data, not a heap snapshot. The instrumentation landed alongside these fixes
(`TELAR_SHELL_HEAP_LOG=1`) is what settles it: run a loaded evening, read the
per-minute series in `shell.log`, and if the heap still passes 1 GB the snapshot
in `<userData>/diagnostics` names the retaining path.

**The next lever, if it is still row 7.** `Network`/`Log`/`Runtime` are enabled
for emulation's sake on tabs no agent will ever ask for logs from. Enabling them
lazily would cost the history before the first `browser_console_messages` call,
which is a real regression, so it was not done blind.
