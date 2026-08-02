// @ts-expect-error -- bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { INTEGRATION_REGISTRY, integrationDefinition } from "./registry";

const WEB_ROOT = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, WEB_ROOT), "utf8");

describe("pluggable integration registry", () => {
  test("definitions have unique ids and remain optional capability adapters", () => {
    expect(new Set(INTEGRATION_REGISTRY.map((entry) => entry.definition.id)).size).toBe(
      INTEGRATION_REGISTRY.length,
    );
    expect(INTEGRATION_REGISTRY.every((entry) => entry.definition.optional)).toBe(true);
    expect(integrationDefinition("missing")).toBeUndefined();
  });

  test("provider, model, and session ownership do not import a concrete integration", () => {
    for (const path of [
      "lib/model-registry.ts",
      "lib/account-visibility.ts",
      "components/session/session-view.tsx",
      "app/api/chat/route.ts",
    ]) {
      expect(read(path)).not.toContain("INTEGRATION_REGISTRY");
    }
  });

  test("server adapters stay behind a separate server-only registry", () => {
    const clientRegistry = read("lib/integrations/registry.ts");
    const serverRegistry = read("lib/integrations/server-registry.ts");
    expect(clientRegistry).toContain("INTEGRATION_REGISTRY");
    expect(serverRegistry).toContain("INTEGRATION_SERVER_REGISTRY");
  });

  test("settings renders the registry without requiring an installed adapter", () => {
    const settings = read("components/settings/accounts-settings.tsx");
    expect(settings).toContain("INTEGRATION_REGISTRY.map");
    expect(settings).toContain("No integrations installed");
  });
});
