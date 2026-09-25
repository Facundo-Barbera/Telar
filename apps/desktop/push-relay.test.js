// PROVISIONING THE PUSH RELAY — issue #579.
//
// Two claims, and both are about a credential. The write must REFUSE anything
// that is not a relay config, because a Keychain item written from unchecked
// input is a credential this Mac would hand to whatever host string got in.
// And the token must never reach argv: `security -w <value>` is readable out of
// `ps` by every other process this user runs, so the value goes on stdin.
//
// Every exec here is a fake. Nothing in this file touches the real Keychain,
// and the shape it accepts is pinned against the cockpit's own parser so the
// pane cannot validate one thing and the shell write another.
const { describe, expect, test } = require("bun:test");
const { provisionPushRelay, normalizeRelayConfig, SERVICE, ACCOUNT } = require("./push-relay");
const { parseRelayConfig } = require("../web/lib/mobile/relay-config.ts");

const TOKEN = "a".repeat(64);
const good = { url: "https://relay.example.com", token: TOKEN };

/** Records what `security` was asked to do, and answers success. */
function recordingExec(code = 0) {
  const calls = [];
  const exec = async (args, stdin) => {
    calls.push({ args, stdin });
    return { code };
  };
  return { calls, exec };
}

describe("what counts as a relay config", () => {
  test("the shell agrees with the cockpit's own parser, shape for shape", () => {
    for (const input of [
      good,
      { url: "https://relay.example.com/", token: TOKEN },
      { url: "https://relay.example.com:8443", token: TOKEN },
      { ...good, id: "host_1-A" },
      { ...good, id: "not an id" },
      { ...good, id: "x".repeat(129) },
      { ...good, id: 7 },
      // Every one of these is a plausible paste that must not be stored.
      { url: "http://relay.example.com", token: TOKEN },
      { url: "https://relay.example.com/v1", token: TOKEN },
      { url: "https://relay.example.com?x=1", token: TOKEN },
      { url: "https://relay.example.com#f", token: TOKEN },
      { url: "https://user:pw@relay.example.com", token: TOKEN },
      { url: "not a url", token: TOKEN },
      { url: "https://relay.example.com", token: "a".repeat(63) },
      { url: "https://relay.example.com", token: "z".repeat(64) },
      { url: "https://relay.example.com" },
      { token: TOKEN },
      null,
      "https://relay.example.com",
      [good],
    ]) {
      expect(normalizeRelayConfig(input) ?? null).toEqual(parseRelayConfig(input) ?? null);
    }
  });

  test("what is stored is the ORIGIN, not the string that was typed", () => {
    // The relay's routes are appended to this, so a trailing path would
    // silently retarget every one of them.
    expect(normalizeRelayConfig({ url: "https://relay.example.com/", token: TOKEN })).toEqual({
      url: "https://relay.example.com",
      token: TOKEN,
    });
  });

  test("the host id survives the paste, so one Mac stays the sender per phone", () => {
    expect(normalizeRelayConfig({ ...good, id: "host_1" })).toEqual({ ...good, id: "host_1" });
  });
});

/**
 * macOS ONLY, AND IT HAS TO BE SAID OUT LOUD. `provisionPushRelay` refuses off
 * darwin before it looks at anything — "the credential lives in the macOS
 * Keychain" — so every test below would be asking about a code path the
 * platform never reaches.
 *
 * WITHOUT THIS GATE, TWO FAILED AND THREE PASSED FOR THE WRONG REASON, which is
 * the worse half. The refusals still refused, so "a bad config is refused" and
 * "a refusal never quotes what was pasted" went green against a message that
 * had nothing to do with the config; and "a keychain that refused the write is
 * reported" asserts the error contains "Keychain", which the off-darwin
 * sentence also contains. Three green tests that could not fail.
 *
 * Nothing goes dark: `bun run test:desktop` runs this file on the `macos` leg of
 * Verify, which is the same reason that job exists for `dev-update`'s `ditto`
 * block. Never run on Linux is not the same as never run.
 *
 * Every exec is still a fake. This gate is about the platform check inside the
 * function under test, not about reaching a real Keychain.
 */
describe.skipIf(process.platform !== "darwin")("writing the Keychain item", () => {
  test("the token goes on stdin and never into argv", async () => {
    const { calls, exec } = recordingExec();
    expect(await provisionPushRelay(good, exec)).toEqual({ ok: true });
    expect(calls).toHaveLength(1);

    const [call] = calls;
    // `-w` WITH NO VALUE is the whole point: it makes `security` read the
    // password from stdin rather than from a command line other processes can
    // see. A regression here would be invisible in the happy path.
    expect(call.args).toEqual(["add-generic-password", "-U", "-s", SERVICE, "-a", ACCOUNT, "-w"]);
    expect(call.args.join(" ")).not.toContain(TOKEN);
    // Twice, because `security` asks for the password and then its
    // confirmation, and reads both from stdin when it is not a terminal.
    expect(call.stdin).toBe(`${JSON.stringify(good)}\n${JSON.stringify(good)}\n`);
  });

  test("the item is the one the cockpit's reader looks for", () => {
    expect(SERVICE).toBe("com.telar.push-relay");
    expect(ACCOUNT).toBe("host");
  });

  test("a bad config is refused before anything is run", async () => {
    const { calls, exec } = recordingExec();
    const answer = await provisionPushRelay({ url: "http://relay.example.com", token: TOKEN }, exec);
    expect(answer.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  test("a refusal never quotes what was pasted", async () => {
    const { exec } = recordingExec();
    const answer = await provisionPushRelay({ url: "https://relay.example.com/v1", token: TOKEN }, exec);
    expect(answer.ok).toBe(false);
    expect(answer.error).not.toContain(TOKEN);
    expect(answer.error).not.toContain("relay.example.com");
  });

  test("a keychain that refused the write is reported, not swallowed", async () => {
    const { exec } = recordingExec(1);
    const answer = await provisionPushRelay(good, exec);
    expect(answer.ok).toBe(false);
    expect(answer.error).toContain("Keychain");
    expect(answer.error).not.toContain(TOKEN);
  });

  test("a security binary that could not be run is reported, not swallowed", async () => {
    const answer = await provisionPushRelay(good, async () => {
      throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    });
    expect(answer.ok).toBe(false);
    expect(answer.error).toContain("/usr/bin/security");
  });
});
