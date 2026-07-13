// M4 — the ephemeral-database seam for the frozen-lane verify. The frozen lane
// runs the integration verify against an IMMUTABLE snapshot: a worktree pinned
// at the root's baseSha (M3 machinery) + an ephemeral DB clone of a template
// database. The clone is an INJECTABLE SEAM so every unit test mocks it and no
// test ever touches a real Postgres/network. Cloner selection is a project FACT,
// not a behavior switch: the engine uses the real LiveDbCloner ONLY when the
// project DECLARES a template DB in its telar.yaml (manifest.templateDb);
// absent, the no-op NullDbCloner. Tests inject a FakeDbCloner via the seam.

// Clone a template DB into a throwaway one and hand back an ephemeral
// DATABASE_URL the frozen lane injects into its services' env; drop it in the
// verify's finally. `clone` returning "" means "no clone" — the lane then keeps
// the ambient env with no DATABASE_URL override (exactly today's behavior).
export interface DbCloner {
  clone(templateDb: string, snapshotId: string): Promise<string>; // → ephemeral DATABASE_URL, or "" for no override
  drop(ephemeralDb: string): Promise<void>; // best-effort teardown
}

// No template DB declared: no clone at all. The frozen lane inherits the
// ambient DATABASE_URL (or none). This is the default when a project declares
// no template DB.
export class NullDbCloner implements DbCloner {
  async clone(): Promise<string> {
    return ""; // "" ⇒ no DATABASE_URL override; lane keeps ambient env
  }
  async drop(): Promise<void> {}
}

// Tests: a scripted, side-effect-free cloner that records what it was asked to
// drop so a test can assert clone/drop pairing without any DB. It NEVER opens a
// connection — it is pure bookkeeping.
export class FakeDbCloner implements DbCloner {
  public cloned: Array<{ templateDb: string; snapshotId: string; url: string }> = [];
  public dropped: string[] = [];
  constructor(private urlFor: (id: string) => string = (id) => `postgres://fake/telar_frozen_${id}`) {}
  async clone(templateDb: string, snapshotId: string): Promise<string> {
    const url = this.urlFor(snapshotId);
    this.cloned.push({ templateDb, snapshotId, url });
    return url;
  }
  async drop(ephemeralDb: string): Promise<void> {
    this.dropped.push(ephemeralDb);
  }
}

// The ONE real-Postgres implementation — selected by resolveDbCloner ONLY when
// the project declares a template DB (a FACT). Its clone/drop bodies are DEFERRED
// to a human-in-the-seat session (M4 spec §8): when that live piece is built,
// this class gains a real `CREATE DATABASE telar_frozen_<id> TEMPLATE <templateDb>`
// clone and a best-effort `DROP DATABASE` teardown (terminating connections
// first). Until then, clone/drop throw loudly rather than silently pretend to
// clone. Tests never select it (they declare no templateDb and inject FakeDbCloner).
export class LiveDbCloner implements DbCloner {
  async clone(): Promise<string> {
    // Deferred (M4 spec §8, item 1): implement WITH a real Postgres in front of
    // you — CREATE DATABASE … TEMPLATE, handling template-in-use locks,
    // connection limits, and orphan cleanup.
    throw new Error("LiveDbCloner.clone is not implemented — build it in a live-validation session (M4 §8).");
  }
  async drop(): Promise<void> {
    throw new Error("LiveDbCloner.drop is not implemented — build it in a live-validation session (M4 §8).");
  }
}

// Pick the cloner for a run from a project FACT: the real LiveDbCloner when the
// project declares a template DB in its telar.yaml (manifest.templateDb), else
// the no-op NullDbCloner — never implicit, never an env switch. Tests declare no
// templateDb and inject FakeDbCloner directly.
export function resolveDbCloner(templateDb?: string): DbCloner {
  return templateDb ? new LiveDbCloner() : new NullDbCloner();
}
