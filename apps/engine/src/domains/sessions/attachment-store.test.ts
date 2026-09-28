import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { EngineStateError } from "../../platform/kernel";
import { summariseTurn } from "../turns";
import { useTempStores } from "../../../test/temp-store";

const { readyStore } = useTempStores();

test("an attachment is stored under the engine's own name and a turn may only reference one that exists", () => {
  const { store, root: stateRoot } = readyStore();
  const attachment = store.attachments.put("session_one", {
    name: "../../escape.png",
    mediaType: "image/png",
    data: new Uint8Array([1, 2, 3, 4]),
  });

  // THE HUMAN'S NAME NEVER REACHES THE FILESYSTEM. It is kept for display and
  // the path is minted from the engine's own id, so a name full of `..` is a
  // label rather than a traversal.
  expect(attachment.name).toBe("../../escape.png");
  expect(attachment.path.startsWith(path.join(stateRoot, "sessions", "session_one", "attachments"))).toBe(true);
  expect(path.basename(attachment.path)).toBe(`${attachment.id}.png`);
  expect(fs.readFileSync(attachment.path)).toEqual(Buffer.from([1, 2, 3, 4]));

  const { turn } = store.intake.submitTurn("session_one", { runId: "run_one", input: "Look", attachments: [attachment.id] });
  expect(turn.attachments).toEqual([attachment]);

  // Loud rather than silent: a message that says "look at this" and arrives
  // with nothing attached is worse than one that fails to send.
  expect(() => store.intake.submitTurn("session_one", { runId: "run_two", input: "Look", attachments: ["att_missing"] })).toThrow(
    EngineStateError,
  );
});

test("an image-only message is a message; a blank one with only a PDF, or nothing, is not", () => {
  const { store } = readyStore();
  const png = (name: string) => store.attachments.put("session_one", { name, mediaType: "image/png", data: new Uint8Array([1, 2, 3, 4]) });
  const pdf = store.attachments.put("session_one", { name: "spec.pdf", mediaType: "application/pdf", data: new Uint8Array([1]) });

  const shot = png("Screenshot.png");
  const { turn } = store.intake.submitTurn("session_one", { runId: "run_image", input: "", attachments: [shot.id] });
  expect(turn).toMatchObject({ input: "", state: "queued", attachments: [shot] });
  // Its outline line names the picture rather than going blank.
  expect(summariseTurn(turn, store.queries.items("session_one")).input).toBe("[Screenshot.png]");
  // Idempotent like any other send.
  expect(store.intake.submitTurn("session_one", { runId: "run_image", input: "", attachments: [shot.id] }).replayed).toBe(true);

  // A file alone gives the agent a path and no reason; nothing at all is nothing.
  for (const attempt of [
    { runId: "run_pdf", input: " ", attachments: [pdf.id] },
    { runId: "run_empty", input: "" },
    { runId: "run_compact", input: "", kind: "compact" as const, attachments: [png("b.png").id] },
  ]) {
    expect(() => store.intake.submitTurn("session_one", attempt)).toThrow(EngineStateError);
  }
  expect(store.queries.turns("session_one").map((row) => row.runId)).toEqual(["run_image"]);
});

test("a browser draft promoted by an image-only message is titled by its picture", () => {
  const { store } = readyStore();
  store.lifecycle.createSession({ id: "session_draft", projectId: "project_one", draft: true, title: "Browser draft" });
  const shot = store.attachments.put("session_draft", { name: "Screenshot.png", mediaType: "image/png", data: new Uint8Array([1]) });
  store.intake.submitTurn("session_draft", { runId: "run_first", input: "", attachments: [shot.id] });
  expect(store.records.get("session_draft").title).toBe("Screenshot.png");
});
