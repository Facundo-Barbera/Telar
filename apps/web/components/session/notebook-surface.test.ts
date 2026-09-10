/**
 * WHY A NOTEBOOK READ FAILED — the distinction a screenshot caught us getting
 * wrong.
 *
 * `demos/exoplanet/exoplanet_transit_demo.ipynb` was selected in the Editor, on
 * disk, with a working kernel, and the surface showed **"No notebook here yet"
 * with a Create button**. The read had 404'd because the engine had no route
 * for `notebook/read` — not because the file was absent — and both arrive as
 * `not_found`. Offering to create a notebook over a file nobody managed to read
 * is the failure mode; these cases pin the rule that prevents it.
 *
 * The engine's own sentences are used verbatim: `state.ts` says "no such file in
 * this workspace" for a missing file, and the two doors say "no data-science
 * method notebook/read", "data-science has no notebook/read" and "engine
 * endpoint does not exist" for a missing route.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { EngineApiError } from "@/lib/engine/client";
import { classifyNotebookRead } from "./notebook-surface";

const engineSaid = (code: string, message: string, status = 404) => new EngineApiError(code as never, message, status);

describe("classifyNotebookRead", () => {
  test("the engine's own missing-file sentence is the ONLY thing that offers Create", () => {
    // `readFenced` in state.ts, verbatim.
    expect(classifyNotebookRead(engineSaid("not_found", "no such file in this workspace"))).toEqual({ kind: "missing" });
  });

  test("a route 404 is unreadable, never missing — the live bug", () => {
    // The plugin route table had no notebook keys; this is what came back.
    for (const message of [
      "no data-science method notebook/read",
      "data-science has no notebook/read",
      "engine endpoint does not exist",
      "no plugin data-science",
    ]) {
      const failure = classifyNotebookRead(engineSaid("not_found", message));
      expect(failure.kind).toBe("unreadable");
      // And the engine's sentence is kept, because it is the one that tells a
      // person to look at the build rather than at their file.
      expect(failure.kind === "unreadable" && failure.message).toBe(message);
    }
  });

  test("a 404 that mentions a file AND a method is still unreadable", () => {
    // Ambiguity resolves AWAY from Create: the destructive-looking offer needs
    // an unambiguous "the file is not there".
    const failure = classifyNotebookRead(engineSaid("not_found", "no data-science method notebook/read for no such file in this workspace"));
    expect(failure.kind).toBe("unreadable");
  });

  test("every other engine refusal is unreadable, with its own words", () => {
    for (const [code, message] of [
      ["plugin_error", "data-science: this engine has no kernel host"],
      ["invalid_request", "data science is not enabled for this session's project"],
      ["engine_unavailable", "The cockpit cannot reach its local adapter."],
      ["internal_error", "something went wrong"],
    ] as const) {
      const failure = classifyNotebookRead(engineSaid(code, message, code === "invalid_request" ? 400 : 503));
      expect(failure).toEqual({ kind: "unreadable", message });
    }
  });

  test("a not_found that says nothing useful is unreadable, not missing", () => {
    // Silence is not evidence that the file is absent.
    expect(classifyNotebookRead(engineSaid("not_found", ""))).toEqual({ kind: "unreadable", message: "The engine did not answer." });
    expect(classifyNotebookRead(new Error("fetch failed"))).toEqual({ kind: "unreadable", message: "fetch failed" });
    expect(classifyNotebookRead(undefined)).toEqual({ kind: "unreadable", message: "The engine did not answer." });
  });

  test("a missing file reported with the wrong code is not treated as missing", () => {
    // The allowlist needs BOTH: the code and the sentence. A 500 that happens
    // to contain those words is a bug in the engine, not an absent notebook.
    expect(classifyNotebookRead(engineSaid("internal_error", "no such file in this workspace", 500)).kind).toBe("unreadable");
  });
});
