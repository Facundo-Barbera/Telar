"use strict";

/**
 * THE GATE THE ENGINE IS NOT SPAWNED THROUGH UNTIL THE STORE IS REALLY THERE —
 * issue #630.
 *
 * WHY IT IS IN THE SHELL AND NOT THE ENGINE. The engine's answer to "my state
 * root is not reachable" can only be to fail to start, and a daemon that exits
 * during boot is a window full of errors at best (`startEngineChild`'s exit
 * handler quits the app). The shell is the process that outlives the engine and
 * owns a screen, so it is the only one that can turn "your drive is not here"
 * into something a person can act on. Hence: resolve first, spawn second.
 *
 * WHY IT IS A LOOP RATHER THAN A CHECK. An absent volume is the DESIGNED-FOR
 * case, not an error path — the drive is meant to be plugged in, and the
 * ordinary resolution is that somebody plugs it in. So this waits, is told when
 * the mount roots change (`volume-watch.js`, which needs no engine and is
 * already a pure module taking an `onChanged`), and re-resolves. Polling would
 * have been a second mechanism for a question the shell can already be told the
 * answer to.
 *
 * WHAT IT WILL NOT DO, AND THIS IS THE WHOLE POINT: initialise. Exactly one
 * branch below creates a store, and it is the one `store-location.js` answers
 * `first-run` for — no marker at all. Every other unreachable state waits or
 * refuses. An absent drive can never, by any path through this function, end up
 * having a fresh empty store written where somebody's history was.
 *
 * THE PRESENTER IS INJECTED, which is what makes every one of those states a
 * unit test rather than a thing you find out about by unplugging a disk.
 */

const {
  adoptStore,
  archiveActive,
  initialiseStore,
  noteOpened,
  readStamp,
  resolveStoreLocation,
} = require("./store-location");

/**
 * Settle on a store root, however long that takes.
 *
 * Resolves `{ root }` once there is a store to open, or `{ quit: true }` when
 * the person chose to stop rather than continue without one.
 *
 * `present(outcome)` is shown a `waiting` or `refuse` answer and resolves to
 * one of:
 *   "retry"      look again — a drive arrived, or they pressed the button
 *   "quit"       stop; Telar does not open
 *   "new-store"  the deliberate act: archive what is recorded and start over
 *                at the default. Never automatic, never a default button.
 */
async function awaitStore(input, deps = {}) {
  const present = deps.present ?? (async () => "quit");
  for (;;) {
    const outcome = resolveStoreLocation({ userData: input.userData, defaultRoot: input.defaultRoot }, deps);

    if (outcome.state === "first-run") {
      return { root: adoptAt(outcome.root, input.userData, deps), adopted: true };
    }

    if (outcome.state === "ready") {
      // The drive came back somewhere new: the store did not move, its path
      // did. Record the new one before anything opens it.
      if (outcome.rewritten) adoptStore(input.userData, outcome.rewritten, deps);
      else noteOpened(input.userData, deps);
      return { root: outcome.root };
    }

    const action = await present(outcome);
    if (action === "quit") return { quit: true };
    if (action === "new-store") archiveActive(input.userData, deps);
    // "retry" and "new-store" both fall through to another resolution rather
    // than acting on a stale one.
  }
}

/**
 * Take a root as this install's store — stamping it if it has never been
 * stamped.
 *
 * AN EXISTING INSTALL LANDS HERE ON ITS FIRST LAUNCH AFTER THE UPGRADE, and
 * nothing about that is destructive: a store full of somebody's history but
 * with no stamp and no marker reads as `first-run`, and "initialising" it means
 * writing a single small file beside what is already there. The alternative —
 * treating an unmarked store as suspicious — would have every existing install
 * refuse to start on the day this ships.
 */
function adoptAt(root, userData, deps) {
  const existing = readStamp(root, deps);
  const stamp = existing ?? initialiseStore(root, deps);
  adoptStore(userData, { path: root, storeId: stamp.storeId }, deps);
  return root;
}

/**
 * The sentence and the choices for a state somebody has to look at.
 *
 * SEPARATED FROM THE WINDOW so the wording is testable and so there is one
 * place it lives. `retry` is offered everywhere because it costs nothing and is
 * right surprisingly often; `newStore` is offered only where starting over is a
 * coherent response, and never where the store is present but unrecognised —
 * "there is a different store here" is not answered by making a third one.
 */
function describeOutcome(outcome) {
  if (outcome.state === "waiting") {
    return {
      title: "Waiting for your Telar store",
      message: outcome.message,
      detail: "Nothing has been opened or created. Plug the drive in and Telar will continue on its own.",
      retry: true,
      newStore: true,
      severity: "waiting",
    };
  }
  const byReason = {
    "marker-unreadable": {
      title: "Telar cannot tell where your store is",
      detail: "The record of your store's location could not be read. Nothing has been opened or created.",
      newStore: false,
    },
    "marker-version": {
      title: "Telar cannot tell where your store is",
      detail: "That record was written by a newer version of Telar. Nothing has been opened or created.",
      newStore: false,
    },
    "store-missing": {
      title: "Telar's store is not where it should be",
      detail: "It has not created a new one. If the store was moved, point Telar at it; if it was deleted, you can start a new one.",
      newStore: true,
    },
    "store-foreign": {
      title: "That is a different Telar store",
      detail: "It has not been opened or changed. Check you have the right drive.",
      newStore: false,
    },
  };
  const arm = byReason[outcome.reason] ?? {
    title: "Telar could not open its store",
    detail: "Nothing has been opened or created.",
    newStore: false,
  };
  return { ...arm, message: outcome.message, retry: true, severity: "refuse" };
}

module.exports = { awaitStore, describeOutcome };
