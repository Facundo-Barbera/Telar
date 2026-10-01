import { describe, expect, test } from "bun:test";
import { projectIconUrl } from "./project-avatar";

describe("projectIconUrl", () => {
  test("carries the content key as ?v=, which is what makes immutable caching honest", () => {
    expect(projectIconUrl("project_1", "abc123")).toBe("/api/projects/project_1/icon?v=abc123");
  });

  test("routes a remote host's icon through that host", () => {
    expect(projectIconUrl("project_1", "abc123", "mac.lan")).toBe("/api/hosts/mac.lan/projects/project_1/icon?v=abc123");
  });
});
