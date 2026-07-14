import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LoginEvent } from "../src/login";

// Throwaway TELAR_HOME so nothing touches the real registry. No real provider
// CLI is ever spawned: every driver test injects a `bash -c` script that mimics
// the provider's OUTPUT shape (URL / device code / paste prompt / exit code)
// and writes into the throwaway config dir handed to it via accountEnv.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-login-"));
process.env.TELAR_HOME = home;
beforeEach(() => {
  process.env.TELAR_HOME = home;
});
afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const { spawnProviderLogin, classifyLoginLine, stripAnsi, loginCommand } = await import(
  "../src/login"
);

const bash = (script: string) => ({ cmd: "bash", args: ["-c", script] });
const throwDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "telar-cfg-"));

async function drain(
  session: ReturnType<typeof spawnProviderLogin>,
  onEvent?: (e: LoginEvent) => void,
): Promise<LoginEvent[]> {
  const events: LoginEvent[] = [];
  for await (const e of session.events) {
    events.push(e);
    onEvent?.(e);
  }
  return events;
}

describe("pure classifiers", () => {
  test("stripAnsi removes color codes", () => {
    expect(stripAnsi("\x1b[94mhttps://x\x1b[0m")).toBe("https://x");
  });

  test("a URL line classifies as url (ANSI-wrapped)", () => {
    const e = classifyLoginLine("  visit \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m");
    expect(e).toEqual({ type: "url", url: "https://auth.openai.com/codex/device" });
  });

  test("a bare device code classifies as code", () => {
    expect(classifyLoginLine("   6NQL-48VCU  ")).toEqual({ type: "code", code: "6NQL-48VCU" });
  });

  test("claude's paste prompt classifies as needCode", () => {
    const e = classifyLoginLine("Paste code here if prompted > ");
    expect(e?.type).toBe("needCode");
  });

  test("plain output classifies as null", () => {
    expect(classifyLoginLine("Opening browser to sign in…")).toBeNull();
  });

  test("a URL that contains 'code=' is not mistaken for a device code", () => {
    const e = classifyLoginLine("https://claude.com/oauth?code=true&x=1");
    expect(e?.type).toBe("url");
  });
});

describe("loginCommand argv", () => {
  test("claude drives the pasteable subscription flow", () => {
    expect(loginCommand({ name: "p", provider: "claude" })).toEqual({
      cmd: "claude",
      args: ["auth", "login", "--claudeai"],
    });
  });
  test("codex drives the device-code flow", () => {
    expect(loginCommand({ name: "c", provider: "codex", configDir: "~/.codex" })).toEqual({
      cmd: "codex",
      args: ["login", "--device-auth"],
    });
  });
});

describe("driving a login (fake CLI, throwaway config dir)", () => {
  test("codex device flow: url + code, then exit 0 flips health to ok", async () => {
    const dir = throwDir();
    const account = { name: "codex-t", provider: "codex" as const, configDir: dir };
    // Mimics `codex login --device-auth`: prints URL + code, then the poll
    // "succeeds" — it writes auth.json into $CODEX_HOME and exits 0.
    const script =
      'printf "open https://auth.openai.com/codex/device\\n"; ' +
      'printf "code ABCD-1234\\n"; ' +
      ': > "$CODEX_HOME/auth.json"; exit 0';
    const events = await drain(spawnProviderLogin(account, { command: bash(script) }));

    expect(events.find((e) => e.type === "url")).toEqual({
      type: "url",
      url: "https://auth.openai.com/codex/device",
    });
    expect(events.find((e) => e.type === "code")).toEqual({ type: "code", code: "ABCD-1234" });
    const done = events.at(-1);
    expect(done?.type).toBe("done");
    expect(done && done.type === "done" && done.health.status).toBe("ok");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("claude paste flow: needCode → submitCode writes to stdin → exit 0", async () => {
    const dir = throwDir();
    const account = { name: "claude-t", provider: "claude" as const, configDir: dir };
    // Mimics claude waiting on stdin: print the prompt, read one line, exit 0
    // only if a non-empty code arrived.
    const script =
      'printf "Paste code here if prompted > "; read line; ' +
      '[ -n "$line" ] && exit 0 || exit 7';
    const session = spawnProviderLogin(account, { command: bash(script) });
    const events = await drain(session, (e) => {
      if (e.type === "needCode") session.submitCode("WXYZ-5678");
    });

    expect(events.some((e) => e.type === "needCode")).toBe(true);
    expect(events.at(-1)?.type).toBe("done");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("non-zero exit surfaces a failed event with a health re-check", async () => {
    const dir = throwDir();
    const account = { name: "codex-f", provider: "codex" as const, configDir: dir };
    const events = await drain(
      spawnProviderLogin(account, { command: bash('echo "boom" 1>&2; exit 3') }),
    );
    const last = events.at(-1);
    expect(last?.type).toBe("failed");
    expect(last && last.type === "failed" && last.error).toContain("3");
    // No auth.json was written → health is honestly not "ok".
    expect(last && last.type === "failed" && last.health.status).not.toBe("ok");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("cancel() kills the child and settles as failed", async () => {
    const dir = throwDir();
    const account = { name: "codex-c", provider: "codex" as const, configDir: dir };
    const session = spawnProviderLogin(account, { command: bash("sleep 30") });
    setTimeout(() => session.cancel(), 80);
    const events = await drain(session);
    const last = events.at(-1);
    expect(last?.type).toBe("failed");
    expect(last && last.type === "failed" && last.error).toContain("cancel");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("a hard timeout kills a hung login", async () => {
    const dir = throwDir();
    const account = { name: "codex-to", provider: "codex" as const, configDir: dir };
    const events = await drain(
      spawnProviderLogin(account, { command: bash("sleep 30"), timeoutMs: 120 }),
    );
    const last = events.at(-1);
    expect(last?.type).toBe("failed");
    expect(last && last.type === "failed" && last.error).toContain("timed out");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("an unspawnable command fails cleanly instead of throwing", async () => {
    const account = { name: "nope", provider: "codex" as const, configDir: throwDir() };
    const events = await drain(
      spawnProviderLogin(account, {
        command: { cmd: "telar-no-such-binary-xyz", args: [] },
      }),
    );
    expect(events.at(-1)?.type).toBe("failed");
  });
});
