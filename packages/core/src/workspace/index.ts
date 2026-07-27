// Workspace — the item store behind SPEC-organization-workspace's CAP-12
// ("items are not the Workspace surface's private data"). AD-5 gives
// TELAR_HOME/workspace exactly one owning module and this directory is it:
// schema.ts owns the persisted shapes, store.ts owns the subtree and every read
// and write of it.
//
// `schema` before `store`: store.ts is built on the shapes.
export * from "./schema";
export * from "./store";
