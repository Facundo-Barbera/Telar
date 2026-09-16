/**
 * The adapter's two claims, asserted rather than assumed: the REAL walls build
 * over the fixture, and their zod shapes survive the trip to LangChain even
 * though this package installs its own copy of zod.
 */
import { describe, expect, test } from "bun:test";
import { createLab, toolNames } from "../src/harness/lab";
import { flatten } from "../src/harness/adapter";

const script = { name: "unused", steps: [] };

describe("tool adapter", () => {
  test("both real walls build, with every tool the engine ships", () => {
    const lab = createLab({ label: "adapter", model: { mode: "recorded", script } });
    const names = toolNames(lab.tools);
    expect(names).toEqual([
      "sessions_list",
      "sessions_create",
      "sessions_send",
      "sessions_read",
      "sessions_status",
      "sessions_stop",
      "sessions_settle",
      "sessions_diff",
      "sessions_subscribe",
      "sessions_unsubscribe",
      "sessions_subscriptions",
      "sessions_requests",
      "sessions_resolve_request",
      "notes_projects",
      "notes_list",
      "notes_read",
      "notes_write",
      "notes_delete",
    ]);
    lab.close();
  });

  test("a wall's zod shape converts to the JSON schema a model is shown", async () => {
    const lab = createLab({ label: "adapter", model: { mode: "recorded", script } });
    const create = lab.tools.find((one) => one.name === "sessions_create");
    expect(create).toBeDefined();
    // The two copies of zod meet here: the shape's fields were built by the
    // workspace's zod, the z.object() wrapper by this package's.
    const { toJsonSchema } = await import("@langchain/core/utils/json_schema");
    const schema = toJsonSchema(create!.schema) as { properties?: Record<string, unknown>; required?: string[] };
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(["driver", "envMode", "projectId", "title"]);
    expect(schema.required?.sort()).toEqual(["envMode", "projectId"]);
    lab.close();
  });

  test("a wall's refusal comes back as text the model can read, not a throw", async () => {
    const lab = createLab({ label: "adapter", model: { mode: "recorded", script } });
    const create = lab.tools.find((one) => one.name === "sessions_create")!;
    const answer = await create.invoke({ projectId: "nope", envMode: "local" });
    expect(String(answer)).toContain('Could not create a session on "nope"');
    lab.close();
  });

  test("flatten reports a non-text content part rather than dropping it", () => {
    expect(flatten({ content: [{ type: "text", text: "one" }, { type: "image", data: "x" }] })).toBe(
      'one\n[non-text tool content: {"type":"image","data":"x"}]',
    );
  });

  test("the meter counts every tool call", async () => {
    const lab = createLab({ label: "adapter", model: { mode: "recorded", script } });
    const list = lab.tools.find((one) => one.name === "sessions_list")!;
    await list.invoke({});
    await list.invoke({});
    expect(lab.meter.toolCalls.get("sessions_list")).toBe(2);
    expect(lab.meter.totalToolCalls).toBe(2);
    lab.close();
  });
});
