import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { loadContract } from "./config.ts";
import { projectIdentity } from "./id.ts";
import { sidecarConfigPath, sidecarDir } from "./paths.ts";

const TEMPLATE = `# Environment contract v1 — see docs/env-contract-v1.md in the Telar repo.
# This sidecar is personal: it never lives in the project's own repository.
# Fill the verbs with the project's OWN commands; add private glue scripts in
# ./scripts/ only for verbs the repo genuinely lacks.
version: 1
env:
  # none  = library, tests need no services   (never leases)
  # light = a process or two, no containers   (per-project pool, cap 4)
  # heavy = containers / databases / real RAM (machine-global pool, k=1)
  cost: heavy
  # Bring THIS slot up. Must be idempotent; must not touch other slots.
  # Injected: $TELAR_SLOT $TELAR_PORT_BASE $TELAR_WORKTREE $TELAR_PROJECT_ID
  up: echo "TODO" && false
  # Exit 0 when usable. Polled with a timeout after up.
  ready: echo "TODO" && false
  # Tear this slot down. Must be safe when already down.
  down: echo "TODO" && false
  # Optional: clean data state without a full down/up.
  # reset: ...
  # Optional verification tiers: unit runs unleased, others inside a lease.
  # tiers:
  #   unit: bun test
  #   live: bun run test:e2e
`;

export interface InitResult {
  projectId: string;
  root: string;
  sidecarPath: string;
  /** An existing contract (sidecar or repo telar.yaml); init never overwrites one. */
  existing?: { source: string; path: string };
  written: boolean;
  template?: string;
  next: string;
}

/**
 * Scaffold a sidecar contract for the project at cwd. Safe by default: prints
 * the template unless `write` is set, and never overwrites an existing contract.
 * The onboarding agent (see ONBOARDING.md) fills the verbs and proves them
 * with `telar-env conform`.
 */
export function init(cwd: string, opts: { write?: boolean } = {}): InitResult {
  const identity = projectIdentity(cwd);
  const path = sidecarConfigPath(identity.id);
  const loaded = loadContract(identity.id, identity.root);
  const base = { projectId: identity.id, root: identity.root, sidecarPath: path };
  if (loaded) {
    return {
      ...base,
      existing: { source: loaded.source, path: loaded.path },
      written: false,
      next: "a contract already exists — run `telar-env conform` to prove it",
    };
  }
  if (!opts.write) {
    return {
      ...base,
      written: false,
      template: TEMPLATE,
      next: "re-run with --write to create the sidecar, then fill the verbs and run `telar-env conform`",
    };
  }
  mkdirSync(sidecarDir(identity.id), { recursive: true });
  if (!existsSync(path)) writeFileSync(path, TEMPLATE);
  return {
    ...base,
    written: true,
    next: `fill the verbs in ${path}, then run \`telar-env conform\` until all steps pass`,
  };
}
