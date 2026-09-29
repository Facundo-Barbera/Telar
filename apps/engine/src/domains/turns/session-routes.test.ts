import { expect, test } from "bun:test";
import { sessionTurnRoutes } from "./session-routes";

function submitRoute(sequence: number, replayed = false) {
  const retitled: [string, string][] = [];
  const store = {
    claims: { claudeAdmissionNeedsCatalogue: () => false },
    catalogues: { prepareClaude: () => undefined },
    requestPath: {
      submitTurn: (sessionId: string, input: { runId: string; input: string }) =>
        Promise.resolve({ replayed, turn: { sessionId, runId: input.runId, input: input.input, sequence } }),
    },
  };
  const routes = sessionTurnRoutes(store as never, {
    execution: {} as never,
    requireWorker: () => undefined,
    activeWorker: () => undefined,
    retitle: (sessionId, input) => retitled.push([sessionId, input]),
  });
  const route = routes.find((candidate) => candidate.method === "POST" && String(candidate.path).includes("/turns$"))!;
  return { retitled, submit: (body: Record<string, unknown>) => route.handle({ params: ["session_phone"], body } as never) };
}

test("the phone's first turn, sent right after it creates the session, asks for a title", async () => {
  const { retitled, submit } = submitRoute(1);
  await submit({ runId: "run_one", input: "Hace poco implementamos el soporte de S3", attachments: [] });
  expect(retitled).toEqual([["session_phone", "Hace poco implementamos el soporte de S3"]]);
});

test("a later turn or a replayed first turn does not retitle", async () => {
  const later = submitRoute(2);
  await later.submit({ runId: "run_two", input: "and another thing" });
  const replay = submitRoute(1, true);
  await replay.submit({ runId: "run_one", input: "the first again" });
  expect([...later.retitled, ...replay.retitled]).toEqual([]);
});
