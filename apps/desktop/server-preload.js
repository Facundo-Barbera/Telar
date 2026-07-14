// Loaded via `--require` into the forked standalone Next server. Ties the
// server's lifetime to the Electron main process: main.js forks us with an
// 'ipc' channel, so when the parent dies for ANY reason — including SIGKILL or
// a native main-process crash, where no JS cleanup handler ever runs — the IPC
// channel closes and 'disconnect' fires here, so the server self-exits instead
// of orphaning to init and holding its LISTEN socket against ~/.telar.
process.on("disconnect", () => process.exit(0));
