import { describe, expect, test } from "bun:test";
import { createEngineApi, EngineApiError } from "./client";

describe("the package's domain methods over the cockpit's /api proxy", () => {
  test("a package domain method reaches the engine through the same /api route", async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    const api = createEngineApi(async (url, init) => {
      calls.push({ url: String(url), ...(init?.method ? { method: init.method } : {}) });
      return Response.json({ git: { repository: true, branch: "main" } });
    });
    await expect(api.projectGit("project a")).resolves.toEqual({ git: { repository: true, branch: "main" } });
    await api.commitSessionWork("session_a", "save");
    expect(calls).toEqual([
      { url: "/api/projects/project%20a/git", method: "GET" },
      { url: "/api/sessions/session_a/git/commit", method: "POST" },
    ]);
  });

  test("a refusal from a domain method arrives as an EngineApiError", async () => {
    const api = createEngineApi(async () => Response.json({ error: { code: "not_found", message: "No such project." } }, { status: 404 }));
    const refusal = await api.projectGit("gone").catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(EngineApiError);
    expect((refusal as EngineApiError).message).toBe("No such project.");
  });
});
