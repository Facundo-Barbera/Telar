// @ts-expect-error bun:test has no types in this app's tsconfig
import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionTurn } from "./session-cockpit";

const PROMPT = "Telar restarted to install an update in the middle of your last turn.";

test("the continuation is not the person's bubble, and says it continued after the update", () => {
  const html = renderToStaticMarkup(
    createElement(SessionTurn, {
      turn: {
        runId: "run_1",
        origin: "restart",
        restartOrigin: { reason: "update", plannedAt: 1_800_000_000_000, interruptedRunId: "run_0" },
        prompt: PROMPT,
        state: "queued",
        resultText: "",
        items: [],
        tasks: [],
      },
      requests: [],
      sending: false,
      live: false,
      onDecide: () => {},
      onRetry: () => {},
    }),
  );
  expect(html).toContain("continued after Telar restarted to update");
  expect(html).not.toContain(PROMPT);
});
