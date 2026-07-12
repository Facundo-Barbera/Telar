// M5 runner-resolution decider — pure precedence, every branch.
import { describe, expect, test } from "bun:test";
import { resolveRunner } from "../src/runner/resolve";

describe("resolveRunner", () => {
  test("TELAR_RUNNER_URL set → connect (never spawn)", () => {
    expect(resolveRunner({ runnerUrl: "http://host:9", healthOk: false })).toBe("connect");
    // URL wins even over a healthy runner.json / a bin.
    expect(
      resolveRunner({ runnerUrl: "http://host:9", runnerBin: "/bin/r", runnerJson: { port: 1, token: "t" }, healthOk: true }),
    ).toBe("connect");
  });

  test("healthy runner.json → reuse", () => {
    expect(resolveRunner({ runnerJson: { port: 1, token: "t" }, healthOk: true })).toBe("reuse");
  });

  test("TELAR_RUNNER_BIN set (no url, dead/absent runner.json) → spawn-bin", () => {
    expect(resolveRunner({ runnerBin: "/bin/r", healthOk: false })).toBe("spawn-bin");
    expect(resolveRunner({ runnerBin: "/bin/r", runnerJson: { port: 1, token: "t" }, healthOk: false })).toBe("spawn-bin");
  });

  test("nothing set → spawn-dev", () => {
    expect(resolveRunner({ healthOk: false })).toBe("spawn-dev");
    expect(resolveRunner({ runnerJson: { port: 1, token: "t" }, healthOk: false })).toBe("spawn-dev");
  });

  test("empty-string env vars are treated as unset", () => {
    expect(resolveRunner({ runnerUrl: "  ", runnerBin: "", healthOk: false })).toBe("spawn-dev");
  });
});
