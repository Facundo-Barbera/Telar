// Spec Bundle storage substrate (docs/loom-model.md §2, §M) — a Loom weaves
// from `<loomDir>/spec/`, not the repo. Bundle files are free-form context
// plus exactly one required, falsifiable artifact: spec/contract.json (the
// Verification Contract, §M.1). This module owns bundle I/O, the deterministic
// content-hash version, the per-tick snapshot, and the non-agentic quick-bundle
// lane (§M.6 / D9) — no `agent()` call, provenance-stamped.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getLoom, loomDir } from "./looms";
import {
  assertProvenance,
  contractLoosenings,
  validateContract,
  VerificationContract,
  type ContractAssertion,
  type Provenance,
} from "./schemas";

export const CONTRACT_FILE = "contract.json";

export const specDir = (id: string): string => path.join(loomDir(id), "spec");

// Resolves relPath against specDir and rejects absolute paths or any path
// that normalizes outside of it (blocks "..", a leading "/", symlink-free
// traversal via segments). Throws rather than silently clamping.
function resolveInBundle(id: string, relPath: string): string {
  if (path.isAbsolute(relPath)) {
    throw new Error(`bundle path must be relative: ${relPath}`);
  }
  // An empty or self-referential relPath ("" / ".") resolves to specDir
  // itself — writing there would turn spec/ into a regular file instead of a
  // directory, silently corrupting the bundle for every later read.
  if (!relPath || path.normalize(relPath) === ".") {
    throw new Error(`bundle path must not be empty: ${JSON.stringify(relPath)}`);
  }
  const base = specDir(id);
  const resolved = path.resolve(base, relPath);
  const withSep = base.endsWith(path.sep) ? base : base + path.sep;
  if (resolved !== base && !resolved.startsWith(withSep)) {
    throw new Error(`bundle path escapes spec dir: ${relPath}`);
  }
  return resolved;
}

export function writeBundleFile(id: string, relPath: string, contents: string): void {
  const file = resolveInBundle(id, relPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

export function readBundleFile(id: string, relPath: string): string | null {
  const file = resolveInBundle(id, relPath);
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

// Recursive, sorted relative paths under spec/; [] if the bundle has no files.
export function listBundleFiles(id: string): string[] {
  const base = specDir(id);
  const out: string[] = [];
  function walk(dir: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(path.relative(base, full));
    }
  }
  walk(base);
  return out.sort();
}

// Deterministic short hex content hash — sha256 over each sorted relPath +
// its contents, so it is stable when unchanged and changes on any edit
// (including a rename, since the path is part of the hashed input).
export function bundleVersion(id: string): string {
  const hash = crypto.createHash("sha256");
  for (const relPath of listBundleFiles(id)) {
    hash.update(relPath);
    hash.update("\0");
    hash.update(readBundleFile(id, relPath) ?? "");
  }
  return hash.digest("hex").slice(0, 16);
}

export type BundleSnapshot = {
  version: string;
  files: { path: string; contents: string }[];
};

// The immutable per-tick view (§2) — the weaver binds to this, never to
// a live directory it could re-read mid-thread.
export function snapshotBundle(id: string): BundleSnapshot {
  const files = listBundleFiles(id).map((p) => ({ path: p, contents: readBundleFile(id, p) ?? "" }));
  return { version: bundleVersion(id), files };
}

export function readContract(id: string): { contract: VerificationContract | null; errors: string[] } {
  const raw = readBundleFile(id, CONTRACT_FILE);
  if (raw === null) return { contract: null, errors: [`${CONTRACT_FILE} not found in bundle`] };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return { contract: null, errors: [`${CONTRACT_FILE} is not valid JSON: ${(err as Error).message}`] };
  }
  const parsed = VerificationContract.safeParse(json);
  if (!parsed.success) {
    return { contract: null, errors: parsed.error.issues.map((i) => i.message) };
  }
  const errors = validateContract(parsed.data, { existingFiles: new Set(listBundleFiles(id)) });
  return { contract: errors.length ? null : parsed.data, errors };
}

// Validates FIRST (never persists a prose-only/unfalsifiable contract) and
// throws with every violation joined, mirroring validateCharter's style.
//
// §M.2 loosening co-sign: once a loom has STARTED (startLoomFromBundle
// flipped draft:false), weakening its already-committed contract — removing
// an assertion, downgrading a blocker, or content-changing a still-blocking
// one (contractLoosenings) — requires an explicit human co-sign, the same
// override/cosignedBy shape acceptLoom uses for a non-ready accept. A draft
// loom still being authored (or a loom's first-ever contract write) is
// unrestricted: there is nothing yet to loosen.
export function writeContract(id: string, contract: VerificationContract, opts?: { cosignedBy?: string }): void {
  const errors = validateContract(contract, { existingFiles: new Set(listBundleFiles(id)) });
  if (errors.length) {
    throw new Error(`invalid verification contract: ${errors.join("; ")}`);
  }
  const loom = getLoom(id);
  if (loom && loom.draft === false) {
    const { contract: existing } = readContract(id);
    if (existing) {
      const loosened = contractLoosenings(existing, contract);
      if (loosened.length && !opts?.cosignedBy?.trim()) {
        throw new Error(
          `contract loosening requires a human co-sign (weakened assertions: ${loosened.join(", ")})`,
        );
      }
    }
  }
  writeBundleFile(id, CONTRACT_FILE, JSON.stringify(contract, null, 2));
}

export const PROVENANCE_FILE = "provenance.json";

// Validates (assertProvenance — throws on a blank approver, §M.6) then
// persists provenance.json. The durable counterpart to readProvenance, and
// the write side quickBundle / dispatcher.startLoomFromBundle both use.
export function writeProvenance(id: string, provenance: Provenance): void {
  assertProvenance(provenance);
  writeBundleFile(id, PROVENANCE_FILE, JSON.stringify(provenance, null, 2));
}

// Reads back the provenance a quickBundle (or equivalent) call stamped onto
// the bundle — the durable, checkable counterpart to assertProvenance's
// in-memory-only check. Never throws: absent/corrupt/invalid provenance is
// reported via `errors`, mirroring readContract's shape.
export function readProvenance(id: string): { provenance: Provenance | null; errors: string[] } {
  const raw = readBundleFile(id, PROVENANCE_FILE);
  if (raw === null) return { provenance: null, errors: [`${PROVENANCE_FILE} not found in bundle`] };
  try {
    const parsed = JSON.parse(raw);
    assertProvenance(parsed);
    return { provenance: parsed, errors: [] };
  } catch (err) {
    return { provenance: null, errors: [err instanceof Error ? err.message : String(err)] };
  }
}

// The non-agentic quick-bundle lane (§M.6 / D9): templates a minimal
// falsifiable contract for trivial fixes — no agent() call, still
// provenance-stamped. Validates provenance AND the contract before writing
// anything, so a rejected call leaves no half-committed bundle content
// behind (objective.md/provenance.json never appear without a valid
// contract to go with them).
export function quickBundle(
  id: string,
  opts: { objective: string; assertions: ContractAssertion[]; provenance: Provenance },
): string {
  assertProvenance(opts.provenance);
  const contract: VerificationContract = { version: 1, assertions: opts.assertions };
  const errors = validateContract(contract, { existingFiles: new Set(listBundleFiles(id)) });
  if (errors.length) {
    throw new Error(`invalid verification contract: ${errors.join("; ")}`);
  }
  writeBundleFile(id, PROVENANCE_FILE, JSON.stringify(opts.provenance, null, 2));
  writeBundleFile(id, "objective.md", opts.objective);
  writeContract(id, contract);
  return bundleVersion(id);
}
