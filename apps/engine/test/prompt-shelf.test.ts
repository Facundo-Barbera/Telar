/**
 * THE PROMPT SHELF — the store's rules and the routes that expose them.
 *
 * What is under test is the set of decisions #87 forced, rather than the
 * getters:
 *   · `author` is provenance — stamped once, never patchable, and absent on the
 *     HTTP route means the HUMAN's, which is what keeps an agent's draft
 *     distinguishable from a prompt you set aside yourself;
 *   · a prompt may name the SESSION it was prepared for, and a composer offers
 *     the project's own plus its own session's and nobody else's;
 *   · a prompt with no text is refused, where a note with no body is allowed —
 *     the one place this store deliberately parts company with the notebook;
 *   · reads are tolerant per row, so a hand-edit that breaks one prompt costs
 *     one prompt and not the shelf;
 *   · `state.ts` is untouched, so the shelf's directory is derived and one
 *     project's file cannot be reached through another's id.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClient } from "@telar/engine-client";
import { startEngine, type EngineDaemon } from "../src/daemon";
import {
  createPrompt,
  deletePrompt,
  promptsForComposer,
  promptsPath,
  PROMPT_SHELF_LIMIT,
  readPrompts,
  sortPrompts,
  updatePrompt,
  PreparedPromptsError,
} from "../src/prompts";
import { statePaths } from "../src/state";
import { stubModels } from "./stub-models";

const roots: string[] = [];
const daemons: EngineDaemon[] = [];

const tmp = (prefix: string): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(directory);
  return directory;
};

/** A throwaway repository with one commit — the house idiom, so a project can
 *  actually be registered rather than stubbed. */
function repo(): string {
  const root = tmp("telar-shelf-repo-");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@telar.local");
  git("config", "user.name", "Telar Test");
  fs.writeFileSync(path.join(root, "README.md"), "hello\n");
  git("add", "-A");
  git("commit", "-qm", "initial");
  return root;
}

async function withProject(): Promise<{ client: EngineClient; projectId: string }> {
  const engineRoot = tmp("telar-shelf-");
  const daemon = await startEngine({ models: stubModels, engineRoot });
  daemons.push(daemon);
  const client = new EngineClient(daemon.discovery);
  const { project } = await client.registerProject({ name: "aurora", root: repo() });
  return { client, projectId: project.id };
}

afterEach(async () => {
  for (const daemon of daemons.splice(0).reverse()) await daemon.close();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("the store", () => {
  test("a prompt is stamped with its author at creation, and no patch can move it", () => {
    const paths = statePaths(tmp("telar-shelf-store-"));
    const prompt = createPrompt(paths, "p1", { title: "Ship it", text: "run the release", author: "session" });

    expect(prompt.author).toBe("session");
    expect(prompt.projectId).toBe("p1");
    expect(prompt.created.at).toBe(prompt.updated.at);

    // The runtime half, which a cast gets past where the type alone does not.
    // An agent's draft that could be relabelled as the person's own would erase
    // exactly the distinction this shelf exists to keep.
    expect(() => updatePrompt(paths, "p1", prompt.id, { author: "you" } as never)).toThrow(/author/);
    expect(() => updatePrompt(paths, "p1", prompt.id, { projectId: "p2" } as never)).toThrow(/identity/);
    expect(readPrompts(paths, "p1")[0]!.author).toBe("session");
  });

  test("a prompt with no text is refused, where a note with no body is not", () => {
    const paths = statePaths(tmp("telar-shelf-store-"));
    // The notebook allows an empty body because "+, type a title, come back to
    // it" is its gesture. A prompt with no text is a row that does nothing when
    // you press it, which is the one thing a list of things-to-send must not be.
    expect(() => createPrompt(paths, "p1", { title: "Later", text: "", author: "you" })).toThrow(/needs its text/);
    expect(() => createPrompt(paths, "p1", { title: "Later", text: "   ", author: "you" })).toThrow(/needs its text/);
    expect(() => createPrompt(paths, "p1", { title: "  ", text: "x", author: "you" })).toThrow(/needs a title/);
  });

  test("an edit moves `updated` and leaves `created` alone", () => {
    const paths = statePaths(tmp("telar-shelf-store-"));
    const prompt = createPrompt(paths, "p1", { title: "Ship", text: "old", author: "you" }, new Date(1_000_000));
    const edited = updatePrompt(paths, "p1", prompt.id, { text: "new" }, new Date(2_000_000))!;

    expect(edited.created.at).toBe(1_000_000);
    expect(edited.updated.at).toBe(2_000_000);
    expect(edited.text).toBe("new");
  });

  test("a reason patched to blank is removed rather than left as an empty line", () => {
    const paths = statePaths(tmp("telar-shelf-store-"));
    const prompt = createPrompt(paths, "p1", { title: "Ship", text: "go", reason: "the tests pass now", author: "session" });
    expect(prompt.reason).toBe("the tests pass now");

    expect(updatePrompt(paths, "p1", prompt.id, { reason: "  " })!.reason).toBeUndefined();
  });

  test("newest first, and that is the whole order", () => {
    const stamp = (at: number) => ({ label: "Thu 10:00", at });
    const prompt = (id: string, at: number) =>
      ({ id, projectId: "p1", title: id, text: "x", created: stamp(at), updated: stamp(at), author: "you", schemaVersion: 1 }) as never;

    // No pin and no hand-order, unlike the notebook: a shelf of unsent prompts
    // is a queue you are working off, not furniture you arrange.
    expect(sortPrompts([prompt("old", 1), prompt("new", 3), prompt("mid", 2)]).map((row) => row.id)).toEqual(["new", "mid", "old"]);
  });

  test("a composer is offered the project's own plus its own session's, and nobody else's", () => {
    const paths = statePaths(tmp("telar-shelf-store-"));
    createPrompt(paths, "p1", { title: "Anyone's", text: "x", author: "you" });
    createPrompt(paths, "p1", { title: "Mine", text: "x", sessionId: "s1", author: "session" });
    createPrompt(paths, "p1", { title: "Theirs", text: "x", sessionId: "s2", author: "session" });

    const mine = promptsForComposer(readPrompts(paths, "p1"), "s1").map((row) => row.title);
    expect([...mine].sort()).toEqual(["Anyone's", "Mine"]);

    // A composer with no session of its own — a fresh canvas — still sees the
    // project's, which is the generation case's whole point.
    expect(promptsForComposer(readPrompts(paths, "p1"), undefined).map((row) => row.title)).toEqual(["Anyone's"]);
  });

  test("at the cap the OLDEST goes, rather than the write being refused", () => {
    const paths = statePaths(tmp("telar-shelf-store-"));
    for (let index = 0; index <= PROMPT_SHELF_LIMIT; index += 1) {
      createPrompt(paths, "p1", { title: `p${index}`, text: "x", author: "you" }, new Date(1_000_000 + index * 1_000));
    }
    const shelf = readPrompts(paths, "p1");
    // Refusing would fail an agent's handoff at the moment the shelf is most in
    // use, and drop the prompt least likely to be wanted anyway.
    expect(shelf).toHaveLength(PROMPT_SHELF_LIMIT);
    expect(shelf[0]!.title).toBe(`p${PROMPT_SHELF_LIMIT}`);
    expect(shelf.some((row) => row.title === "p0")).toBe(false);
  });

  test("one broken row costs one prompt, not the shelf", () => {
    const paths = statePaths(tmp("telar-shelf-store-"));
    const kept = createPrompt(paths, "p1", { title: "Keep", text: "x", author: "you" });
    const raw = JSON.parse(fs.readFileSync(promptsPath(paths, "p1"), "utf8")) as unknown[];
    fs.writeFileSync(promptsPath(paths, "p1"), JSON.stringify([{ id: "broken" }, ...raw]));

    const read = readPrompts(paths, "p1");
    expect(read).toHaveLength(1);
    expect(read[0]!.id).toBe(kept.id);
  });

  test("a project id that is not a plain slug never becomes a path", () => {
    const paths = statePaths(tmp("telar-shelf-store-"));
    expect(() => promptsPath(paths, "../escape")).toThrow(PreparedPromptsError);
    expect(() => readPrompts(paths, "a/b")).toThrow(/not a project id/);
  });

  test("deleting what is already gone is the same state stated twice", () => {
    const paths = statePaths(tmp("telar-shelf-store-"));
    const prompt = createPrompt(paths, "p1", { title: "Ship", text: "x", author: "you" });
    expect(deletePrompt(paths, "p1", prompt.id)).toBe(true);
    // The ordinary way a prompt leaves this shelf is being sent, possibly from
    // the other window — a retried delete must not be an error.
    expect(deletePrompt(paths, "p1", prompt.id)).toBe(false);
  });
});

describe("the routes", () => {
  test("an undeclared author is the HUMAN's — only the tool wall says otherwise", async () => {
    const { client, projectId } = await withProject();
    const { prompt } = await client.createProjectPrompt(projectId, { title: "Mine", text: "ask about the migration" });
    expect(prompt.author).toBe("you");

    const declared = await client.createProjectPrompt(projectId, { title: "Theirs", text: "x", author: "session" });
    expect(declared.prompt.author).toBe("session");
  });

  test("the shelf round-trips through the routes, newest first", async () => {
    const { client, projectId } = await withProject();
    await client.createProjectPrompt(projectId, { title: "First", text: "a" });
    const { prompt: second } = await client.createProjectPrompt(projectId, { title: "Second", text: "b", reason: "because" });

    const { prompts } = await client.projectPrompts(projectId);
    expect(prompts.map((row) => row.title)).toEqual(["Second", "First"]);
    expect(prompts[0]!.reason).toBe("because");

    expect((await client.deleteProjectPrompt(projectId, second.id)).deleted).toBe(true);
    expect((await client.projectPrompts(projectId)).prompts.map((row) => row.title)).toEqual(["First"]);
  });

  test("a blank text is a sentence a person can act on, not a 500", async () => {
    const { client, projectId } = await withProject();
    await expect(client.createProjectPrompt(projectId, { title: "Empty", text: "" })).rejects.toThrow(/needs its text/);
  });

  test("an unknown project 404s rather than minting a shelf", async () => {
    const { client } = await withProject();
    await expect(client.projectPrompts("nope")).rejects.toThrow();
  });
});
