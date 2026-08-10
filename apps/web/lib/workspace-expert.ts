// The expert-consultation layer (story 5.8, CAP-9) — the thin thing that stands
// between a caller (the master's tool call, or an HTTP route) and core's
// `runExpertPass`.
//
// WHAT IT ADDS, AND IT IS EXACTLY TWO THINGS:
//   1. IT RESOLVES THE PROJECT'S WORKING ROOT. core's workspace subtree knows
//      nothing about the project registry — it stores a project as a slug on an
//      item and that is deliberate (an item may name a project this machine has
//      never checked out, and a mirrored project may have no local tree at all).
//      Turning that slug into a directory is registry work, and the registry
//      lives in manifest.ts, so the join belongs in a layer above both. THE
//      LOOKUP IS ALLOWED TO FAIL: CAP-9's claim is that the DIGEST is enough, so
//      an unregistered project still gets its expert — with no cwd, reasoning
//      from the digest and the packet alone. Refusing there would make "the
//      expert can work cold" false for exactly the projects that need it most.
//   2. IT ANSWERS IN SENTENCES. Every refusal below is a line the model reads
//      back to the user or a route returns verbatim — the same rule
//      workspace-handoff.ts's HandoffRefused states ("the message IS the
//      product").
//
// WHAT IT DELIBERATELY DOES NOT ADD: no second definition of what a pass writes.
// Every write still happens inside core (applyExpertPass / writeExpertDigest),
// so the tool path and the HTTP path cannot drift about what an enrichment pass
// means — the reason weaveItems exists in one file with two callers.
import {
  floatingExpertRefusal,
  getProject,
  getWorkspaceItem,
  listProjects,
  runExpertPass,
  type AccountProfile,
  type ExpertDeps,
  type ExpertPassOutcome,
} from "@telar/core";

export type ConsultOpts = {
  // The caller's resolved account, so the pass bills the human who is here
  // rather than the manifest default — the identity rule weave_batch states for
  // `account`. Server-resolved; never tool input.
  account?: AccountProfile;
  // Test seam, handed straight through to core. Absent means the real model.
  deps?: ExpertDeps;
  abort?: AbortController;
};

// The project's checkout, or undefined when this machine has none.
//
// UNDEFINED FOR AN UNREGISTERED PROJECT ONLY, AND IT USED TO BE UNDEFINED FOR
// EVERYTHING (fix-round correction). A bare `try { getProject(...) } catch {
// return undefined }` is right about the case it was written for — a slug typed
// into an item, a mirrored tracker with no local clone; CAP-9 says the DIGEST is
// enough, so refusing there would break the capability for exactly the projects
// it exists for — but `getProject` throws for a SECOND reason, and manifest.ts
// says of it in so many words: "A present-but-malformed/schema-invalid manifest
// is a real config error and must still throw (loadManifest surfaces it) — never
// mask that." The blanket catch masked it, and a project with a broken telar.yaml
// degraded silently to a cwd-less expert that still wrote a digest, with nothing
// on any surface saying it never saw the tree.
//
// SO THE DISCRIMINATOR IS REGISTRY MEMBERSHIP, read through `listProjects` —
// the registry's own non-throwing reader — and NOT a match on the error's
// message, which would be a second copy of manifest.ts's wording living in
// another package. A name the registry does not hold is the supported state and
// returns undefined; for a name it does hold, `getProject` runs unguarded, so a
// malformed manifest throws (and its telar.yaml-was-wiped self-heal still
// happens, which is why this does not read the manifest out of `listProjects`).
export function projectRoot(project: string): string | undefined {
  if (!listProjects().some((p) => p.entry.name === project)) return undefined;
  return getProject(project).manifest.root;
}

// One consultation. `scope` is the CALLER'S scope — a project session may only
// consult about its own items, the master (undefined) about any — and it is
// checked here, before core is reached, with the anti-oracle wording the rest of
// the workspace surface uses: an out-of-scope id answers identically to an id
// that does not exist, so this never becomes a way to learn what another project
// holds.
//
// THE EXPERT'S PROJECT IS THE ITEM'S, NOT THE CALLER'S, and that is the whole
// inverted-scope rule made concrete: the master has no project, so a pass it
// dispatches would be project-less if the scope came from the caller. It comes
// from the packet.
export async function consultExpert(
  itemId: string,
  scope: string | undefined,
  opts: ConsultOpts = {},
): Promise<ExpertPassOutcome> {
  const item = getWorkspaceItem(itemId);
  if (!item || (scope !== undefined && item.project !== scope)) {
    return { ok: false, reason: `No workspace item found with id "${itemId}".` };
  }
  if (!item.project) {
    // core refuses this too; refusing here as well saves a registry lookup for an
    // item that has no project to look up — and THE SENTENCE IS CORE'S OWN
    // FUNCTION, not a copy of its words (fix-round correction). Two identical
    // string literals either side of a package boundary, each pinned only by a
    // substring check, is a seam where rewording one layer leaves every suite
    // green and the two layers saying different things.
    return { ok: false, reason: floatingExpertRefusal(item.title) };
  }
  const cwd = projectRoot(item.project);
  const req = {
    itemId,
    project: item.project,
    ...(cwd ? { cwd } : {}),
    ...(opts.account ? { account: opts.account } : {}),
    ...(opts.abort ? { abort: opts.abort } : {}),
  };
  // Two call forms rather than a spread, so the default `deps` stays core's own
  // and this layer never has to name the live model call.
  return opts.deps ? runExpertPass(req, opts.deps) : runExpertPass(req);
}

// What a caller SAYS about a finished pass. One composer, so the tool's JSON and
// any surface that narrates a pass agree — and so the held-verdict case is
// stated out loud in every one of them: a pass that reports "verdict: loom" when
// the stored verdict is the human's "session" would be a lie the model repeats.
export function passSummary(out: Extract<ExpertPassOutcome, { ok: true }>): string {
  const parts = [`The ${out.project} expert${out.cold ? " (first pass — it had no digest)" : ""} re-read this item.`];
  if (out.verdictHeld) {
    parts.push(
      `It reads this as ${out.verdict}, but the user's own verdict (${out.applied.item.verdict}) stands and was not changed — say so rather than reporting a new verdict.`,
    );
  } else if (out.verdict) {
    parts.push(`Its advisory verdict is ${out.verdict}; the user can override it and their choice is final.`);
  }
  if (out.applied.commitments > 0) {
    parts.push(
      `It mined ${out.applied.commitments} time-commitment${out.applied.commitments === 1 ? "" : "s"} out of the capture.`,
    );
  }
  if (!out.cwd) {
    // THE OTHER HALF OF "COLD". `cold` reports whether the expert had a digest;
    // this reports whether it had the project's files, and they are independent —
    // an unregistered or un-cloned project (the mirrored case CAP-9 is built for)
    // gets an expert with a digest and no tree. Said out loud because a master
    // that reads a consultation and tells the user "the expert looked at the
    // repo" would be inventing the one thing this pass could not do.
    parts.push(`This machine has no checkout of ${out.project}, so it read the digest and the packet alone — not the project's files.`);
  }
  parts.push("Nothing was started, accepted or completed.");
  return parts.join(" ");
}
