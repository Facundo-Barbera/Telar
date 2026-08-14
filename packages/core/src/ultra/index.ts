// Ultra — a deterministic script harness inside the engine (doc
// docs/plans/ultra-harness.md). Cut U1: sandbox + executor core. Cut U2:
// journal + ordinal resume. Cut U3: validate-and-retry + pipeline/phase/log.
// Cut U4: the real agent runner (runner.ts) + storage/launch (storage.ts).
//
// THIS DIRECTORY IS THE LEGACY IMPLEMENTATION AND KEEPS THE LEGACY NAME.
//
// Telar calls the same concept WARP — the set of parallel threads held under
// tension on a loom — because "ultra" had been taken for other things. That
// rename is done where it counts: `packages/engine-client/src/protocol/tasks.ts`
// defines `WarpLinkage` and `WarpPhase`, and Telar fan-out rides the session
// event stream as `task.*` rather than owning the separate storage, journal,
// event bus and wake loop these ten modules do.
//
// Renaming here was considered and deliberately not done. Its only consumers
// are this package's own tests and `apps/web_old`, which is FROZEN and cannot
// be edited to follow — so the rename would break the frozen reference app to
// tidy the vocabulary of an architecture Telar replaces rather than carries
// forward. The script-authoring surface (`agent()`, `parallel()`, `pipeline()`,
// `phase()`) is the good part and is what a Telar Warp should port; where its
// observations GO is what changes.
export * from "./signals";
export * from "./surface";
export * from "./sandbox";
export * from "./journal";
export * from "./runner";
export * from "./executor";
export * from "./storage";
// Story 4.1 — the declared event catalogue (AD-21) and the durable completion
// wake it feeds. `events` before `wake`: wake.ts is built on the catalogue.
export * from "./events";
export * from "./wake";
