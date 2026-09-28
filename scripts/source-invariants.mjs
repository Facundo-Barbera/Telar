#!/usr/bin/env bun
// Invariants of the source text, checked without running any app. Each CHECKS
// entry is a name, what it protects, and a `run` returning actionable failures.
import { CHECKS_SCANS } from "./source-invariants-checks-a.mjs";
import { CHECKS_GATES } from "./source-invariants-checks-b.mjs";
import { SOURCE_CHECKS } from "./source-checks/index.mjs";

const CHECKS = [...CHECKS_SCANS, ...CHECKS_GATES, ...SOURCE_CHECKS];

let failed = 0;
for (const check of CHECKS) {
  const failures = await check.run();
  if (failures.length === 0) {
    console.log(`  ok  ${check.name} — ${check.protects}`);
    continue;
  }
  failed += 1;
  console.error(`FAIL  ${check.name} — ${check.protects}`);
  for (const line of failures) console.error(`        ${line}`);
}

if (failed > 0) {
  console.error(`\n${failed} of ${CHECKS.length} source invariants failed.`);
  process.exit(1);
}
