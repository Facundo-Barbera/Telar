/**
 * engine protocol v2.
 *
 * The model is `docs/engine-contract-v2.md`; read that before changing
 * shapes here, because several of them encode decisions rather than data.
 *
 * Module map, in dependency order:
 *   common    ids, timestamps, providers, runtime modes, usage, raw payloads
 *   entities  Project, Session, Runtime, Turn — the durable things
 *   items     timeline rows; the data protocol v1 discarded
 *   requests  approvals and questions, plus the auto-resolution policy
 *   tasks     sub-agents, background work, Warp linkage
 *   tools     Telar's own MCP namespace: one server, capability-prefixed names
 *   github    issues and pull requests, as the `gh` CLI reports them
 *   events    the journal: one discriminated union, plus transport shapes
 */
export * from "./common";
export * from "./entities";
export * from "./items";
export * from "./requests";
export * from "./tasks";
export * from "./tools";
export * from "./github";
export * from "./events";
export * from "./observations";
