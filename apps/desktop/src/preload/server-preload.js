// Loaded via `--require` into the two children main.js forks: the standalone
// Next server and the engine daemon. Two jobs.
//
// 1. Ties the child's lifetime to the Electron main process: main.js forks us
//    with an 'ipc' channel, so when the parent dies for ANY reason — including
//    SIGKILL or a native main-process crash, where no JS cleanup handler ever
//    runs — the IPC channel closes and 'disconnect' fires here, so the child
//    self-exits instead of orphaning to init and holding its LISTEN socket
//    against ~/.telar.
process.on("disconnect", () => process.exit(0));

// 2. NAMES THE PROCESS, AND KEEPS THE NAME (#835). Next sets
//    `process.title = "next-server (vX)"` inside its own `startServer`, which
//    runs AFTER this preload — so a plain assignment here would be overwritten,
//    and the cockpit's UI process would sit in `ps` under the same generic name
//    as every dev server on the machine. An agent's routine
//    `pkill -f next-server` then matches Telar itself, and main.js quits the
//    app when its server dies (by design: a window with no server behind it is
//    worse). The fix is upstream of that: set the real title once (Node
//    rewrites the argv region on macOS, which is what `ps` and `pkill -f`
//    read), then replace the property with a getter/setter pair whose setter
//    ignores every later assignment. Measured on Node 24.20 / macOS: the child
//    prints and `ps` reports the guarded name after Next's assignment.
//
//    KEYED ON AN ENVIRONMENT VARIABLE, NOT A DEFAULT, because this same
//    preload loads into the engine daemon (main.js `startEngineChild`), and an
//    unconditional "telar-ui" would rename that too — two processes with one
//    name is the problem in a different coat. main.js sets `telar-ui` /
//    `telar-ui-dev` for the server and `telar-engine` / `telar-engine-dev` for
//    the engine; a child forked without the variable keeps whatever name it
//    would have had.
const title = process.env.TELAR_PROCESS_TITLE;
if (typeof title === "string" && title.trim() !== "") {
  process.title = title;
  Object.defineProperty(process, "title", {
    configurable: true,
    enumerable: true,
    get: () => title,
    set: () => {
      // Next's `process.title = "next-server (…)"` lands here and goes nowhere.
    },
  });
}
