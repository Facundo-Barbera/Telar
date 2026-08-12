/**
 * vNext engine protocol v2.
 *
 * The model is `docs/vnext-engine-contract-v2.md`; read that before changing
 * shapes here, because several of them encode decisions rather than data.
 *
 * Module map, in dependency order:
 *   common    ids, timestamps, providers, runtime modes, usage, raw payloads
 *   entities  Project, Session, Runtime, Turn — the durable things
 *   items     timeline rows; the data protocol v1 discarded
 *   requests  approvals and questions, plus the auto-resolution policy
 *   tasks     sub-agents, background work, Warp linkage
 *   events    the journal: one discriminated union, plus transport shapes
 *
 * v1 (`../contract.ts`) is still exported from the package root during the
 * cutover and is deleted in the commit that migrates the engine. Nothing new
 * should import it.
 */
export * from "./common";
export * from "./entities";
export * from "./items";
export * from "./requests";
export * from "./tasks";
export * from "./events";
