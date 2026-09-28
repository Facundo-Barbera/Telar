import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionTurn } from "./session-turn";

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
    }),
  );
  expect(html).toContain("continued after Telar restarted to update");
  expect(html).not.toContain(PROMPT);
});

test("while the continuation is still answering, the marker sits above what it writes", () => {
  const base = { runId: "run_1", sessionId: "session_1", startedAt: 1, streamedText: "", openedBy: 0 } as const;
  const html = renderToStaticMarkup(
    createElement(SessionTurn, {
      turn: {
        runId: "run_1",
        origin: "restart",
        restartOrigin: { reason: "update", plannedAt: 1_800_000_000_000, interruptedRunId: "run_0" },
        prompt: PROMPT,
        state: "running",
        startedAt: 1,
        resultText: "",
        items: [{ ...base, id: "item_1", status: "inProgress", streamedText: "Picking up where I left off", detail: { type: "assistant_message", text: "" } }],
        tasks: [],
      },
      requests: [],
      sending: false,
      live: true,
      onDecide: () => {},
    }),
  );
  expect(html.indexOf("continued after Telar restarted to update")).toBeGreaterThan(-1);
  expect(html.indexOf("continued after Telar restarted to update")).toBeLessThan(html.indexOf("Picking up where I left off"));
});
