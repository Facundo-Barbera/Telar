// M5 flags — mirror isolationEnabled/autoRepairEnabled (vcs.ts) verbatim: a
// manifest boolean (default false) OR-ed with a TELAR_*=1 env override, so
// flag-off every code path is byte-identical to today.

// Own loom execution in a standalone telar-runner process (out-of-process
// dispatch). Flag-off, dispatch stays in the calling (web) process.
export function runnerEnabled(manifest: { outOfProcessRunner?: boolean }): boolean {
  return manifest.outOfProcessRunner === true || process.env.TELAR_RUNNER === "1";
}

// Run the scoped setup agent in the `preparing` window (bring the lane up /
// author a missing servers.yaml). Flag-off, preparing→running is unchanged.
export function setupAgentEnabled(manifest: { setupAgent?: boolean }): boolean {
  return manifest.setupAgent === true || process.env.TELAR_SETUP_AGENT === "1";
}
