/**
 * Every scenario, in order, with one verdict at the end. What a person runs to
 * regenerate the evidence table in REPORT.md.
 *
 * Run: `bun run scenarios`
 */
import { runScenario1 } from "./1-own-state";
import { runScenario2 } from "./2-streaming-read";
import { runScenario3 } from "./3-approval-restart";
import { runScenario4 } from "./4-delegation";
import { runScenario5 } from "./5-cancellation";
import { runScenario6 } from "./6-no-duplicate-delegation";
import { runScenario7 } from "./7-growing-context";

const scenarios: Array<[string, () => Promise<boolean>]> = [
  ["1 own state, no Telar session", runScenario1],
  ["2 streaming + read tool", runScenario2],
  ["3 permission interrupt survives restart", runScenario3],
  ["4 delegation round trip", runScenario4],
  ["5 cancellation", runScenario5],
  ["6 no duplicate delegation on retry", runScenario6],
  ["7 growing context", runScenario7],
];

const results: Array<[string, boolean]> = [];
for (const [name, run] of scenarios) {
  console.log(`\n${"═".repeat(78)}\nSCENARIO ${name}\n${"═".repeat(78)}`);
  results.push([name, await run()]);
}

console.log(`\n${"═".repeat(78)}\nA. LangGraph — all scenarios\n${"═".repeat(78)}`);
for (const [name, passed] of results) console.log(`  ${passed ? "PASS" : "FAIL"}  ${name}`);
if (results.some(([, passed]) => !passed)) process.exitCode = 1;
