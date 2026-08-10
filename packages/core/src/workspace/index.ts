// Workspace — the item store behind SPEC-organization-workspace's CAP-12
// ("items are not the Workspace surface's private data"). AD-5 gives
// TELAR_HOME/workspace exactly one owning module and this directory is it:
// schema.ts owns the persisted shapes, store.ts owns the subtree and every read
// and write of it.
//
// `schema` before `store`: store.ts is built on the shapes. `expert` last: it
// is built on both, and it is the one file here that reaches OUTSIDE the store
// (engine.ts's agent()) — story 5.8's per-call project expert, which reads its
// project's digest off disk, runs one model call, and hands what it learned
// back to store.ts's verbs. The direction the SPEC fixes ("experts write
// digests, the master only reads them") is a property of this dependency
// order: nothing in schema.ts or store.ts imports expert.ts.
export * from "./schema";
export * from "./store";
export * from "./expert";
