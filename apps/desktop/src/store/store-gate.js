"use strict";

const {
  adoptStore,
  archiveActive,
  initialiseStore,
  noteOpened,
  readStamp,
  resolveStoreLocation,
} = require("./store-location");

async function awaitStore(input, deps = {}) {
  const present = deps.present ?? (async () => "quit");
  for (;;) {
    const outcome = resolveStoreLocation({ userData: input.userData, defaultRoot: input.defaultRoot }, deps);

    if (outcome.state === "first-run") {
      return { root: adoptAt(outcome.root, input.userData, deps), adopted: true };
    }

    if (outcome.state === "ready") {
      if (outcome.rewritten) adoptStore(input.userData, outcome.rewritten, deps);
      else noteOpened(input.userData, deps);
      return { root: outcome.root };
    }

    const action = await present(outcome);
    if (action === "quit") return { quit: true };
    if (action === "new-store") archiveActive(input.userData, deps);
  }
}

function adoptAt(root, userData, deps) {
  const existing = readStamp(root, deps);
  const stamp = existing ?? initialiseStore(root, deps);
  adoptStore(userData, { path: root, storeId: stamp.storeId }, deps);
  return root;
}

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
