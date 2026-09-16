/**
 * The one recording that is generated rather than written by hand: scenario 7's
 * forty turns. Eighty steps typed out would be eighty chances to get the
 * alternation wrong, and the thing under test is the CURVE, not the prose.
 *
 * Run: `bun run src/tools/make-recordings.ts`
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { RECORDINGS_DIR } from "../harness/recordings";
import { GATED_TURN, TURNS } from "../scenarios/7-shape";
import type { RecordedScript } from "../harness/recorded";

function growingContext(): RecordedScript {
  const steps: RecordedScript["steps"] = [];
  for (let turn = 1; turn <= TURNS; turn += 1) {
    if (turn === GATED_TURN) {
      steps.push({
        text: "",
        toolCalls: [
          {
            name: "sessions_send",
            args: { sessionId: "ses_1", intent: "task", input: "Take the backlog sweep while I keep watch." },
          },
        ],
      });
      steps.push({ text: `Turn ${turn}: the sweep is delegated and approved.` });
      continue;
    }
    steps.push({ text: "", toolCalls: [{ name: "sessions_status", args: { sessionId: "ses_1" } }] });
    steps.push({ text: `Turn ${turn}: ses_1 is idle and its last turn completed.` });
  }
  return { name: "7-growing-context", steps, fallback: { text: "Nothing further." } };
}

const file = path.join(RECORDINGS_DIR, "7-growing-context.json");
writeFileSync(file, `${JSON.stringify(growingContext(), null, 2)}\n`);
console.log(`wrote ${file} (${growingContext().steps.length} steps)`);
