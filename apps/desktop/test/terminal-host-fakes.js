const { TerminalHost } = require("../src/terminal/terminal-host");

function fakePty(pid = 4242, ptsName) {
  const calls = { writes: [], resizes: [] };
  const handlers = {};
  return {
    pid,
    ptsName,
    calls,
    write: (data) => calls.writes.push(data),
    resize: (cols, rows) => calls.resizes.push([cols, rows]),

    on: (event, handler) => {
      (handlers[event] ??= []).push(handler);
    },
    listenerCount: (event) => (handlers[event] ?? []).length,
    onData: (handler) => {
      handlers.data = [handler];
    },
    onExit: (handler) => {
      handlers.exit = [handler];
    },
    emitData: (data) => handlers.data.forEach((handler) => handler(data)),
    emitExit: (ending) => handlers.exit.forEach((handler) => handler(ending)),
    emitError: (error) => handlers.error.forEach((handler) => handler(error)),
  };
}

const anyCwdIsFine = {
  statSync: () => ({ isDirectory: () => true }),
  accessSync: () => {},
};

function fakeClock() {
  let now = 0;
  const timers = [];
  return {
    setTimeout: (fn, ms) => {
      const timer = { fn, at: now + ms, done: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => {
      if (timer) timer.done = true;
    },
    advance(ms) {
      now += ms;
      for (const timer of timers) {
        if (!timer.done && timer.at <= now) {
          timer.done = true;
          timer.fn();
        }
      }
    },
    pending: () => timers.filter((timer) => !timer.done).length,
  };
}

function hostWith(pty, options = {}) {
  const spawned = [];
  const endings = [];
  const data = [];
  const clock = fakeClock();
  const host = new TerminalHost({
    platform: "darwin",
    version: "9.9.9",
    fs: options.fs ?? anyCwdIsFine,
    killTree: options.killTree ?? (() => {}),

    listProcesses: options.listProcesses ?? (async () => []),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    spawnPty: (file, args, opts) => {
      spawned.push({ file, args, opts });
      if (options.throws) throw options.throws;
      return pty;
    },
    onData: (id, chunk) => data.push([id, chunk]),
    onExit: (id, ending) => endings.push([id, ending]),
    ...options.host,
  });
  return { host, spawned, endings, data, clock };
}

module.exports = { fakePty, anyCwdIsFine, fakeClock, hostWith };
