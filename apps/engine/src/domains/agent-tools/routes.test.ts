import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startEngine, type EngineDaemon } from "../../daemon";
import { stubModels } from "../../../test/stub-models";

const roots: string[] = [];
const daemons: EngineDaemon[] = [];

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function engine() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-mcp-oauth-"));
  roots.push(home);
  const daemon = await startEngine({ models: stubModels, engineRoot: path.join(home, "engine") });
  daemons.push(daemon);
  return async (method: string, route: string, body?: unknown, token = daemon.discovery.token) => {
    const response = await fetch(`http://127.0.0.1:${daemon.discovery.port}${route}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
}

const redirectOf = (answer: { body: Record<string, any> }) => new URL(answer.body.redirect, "http://cockpit");

test("the callback answers where the browser should land, whatever went wrong", async () => {
  const call = await engine();

  const denied = redirectOf(await call("GET", "/v2/mcp-oauth/callback?error=access_denied&error_description=You+said+no"));
  expect(denied.pathname).toBe("/settings");
  expect(Object.fromEntries(denied.searchParams)).toEqual({ section: "tools", mcpOAuthError: "You said no" });

  const incomplete = redirectOf(await call("GET", "/v2/mcp-oauth/callback?state=abc"));
  expect(incomplete.searchParams.get("mcpOAuthError")).toMatch(/incomplete/);

  const unknown = redirectOf(await call("GET", "/v2/mcp-oauth/callback?state=never-minted&code=c"));
  expect(unknown.searchParams.get("mcpOAuthError")).toBe("this sign-in link has expired or was already used");
});

test("connect refuses an unknown server, and disconnect is idempotent", async () => {
  const call = await engine();
  expect((await call("GET", "/v2/mcp-oauth")).body).toEqual({ statuses: [] });
  expect((await call("POST", "/v2/mcp-oauth/connect", { serverId: "ghost", redirectOrigin: "http://localhost:3000" })).status).toBe(404);
  expect((await call("POST", "/v2/mcp-oauth/connect", { serverId: "ghost" })).status).toBe(400);
  expect((await call("POST", "/v2/mcp-oauth/disconnect", { serverId: "ghost" })).body).toEqual({ removed: false });
});

test("the sign-in routes answer only to the engine token", async () => {
  const call = await engine();
  expect((await call("GET", "/v2/mcp-oauth/callback?state=s&code=c", undefined, "wrong")).status).toBe(401);
});
