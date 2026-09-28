const { describe, expect, test } = require("bun:test");
const fs = require("node:fs");
const path = require("node:path");

const {
  REMOTE_FILE_VERSION,
  readRemotePosture,
  serverBindHost,
  tailscaleServeRequested,
  gateWillRequireAuth,
} = require("./remote-file");

const HOME = "/tmp/telar-test-home";

const serving = (text) => () => {
  if (text === undefined) {
    const error = new Error("ENOENT");
    error.code = "ENOENT";
    throw error;
  }
  return text;
};
const file = (value) => serving(JSON.stringify(value));

const WIDE_OPEN = { version: 1, requireAuth: true, exposure: "network-accessible", tailscaleServe: true, devices: [] };

describe("an unknown version never widens", () => {
  const rolledBack = file({ ...WIDE_OPEN, version: 2 });

  test("a version:2 file binds loopback", () => {
    expect(serverBindHost(HOME, rolledBack)).toBe("127.0.0.1");
  });

  test("a version:2 file publishes no tailscale serve", () => {
    expect(tailscaleServeRequested(HOME, rolledBack)).toBe(false);
  });

  test("and it is reported as untrusted, with the gate falling open", () => {
    const posture = readRemotePosture(HOME, rolledBack);
    expect(posture.state).toBe("unknown-version");
    expect(posture.trusted).toBe(false);

    expect(posture.requireAuth).toBe(false);
    expect(gateWillRequireAuth(HOME, rolledBack)).toBe(false);
  });

  test("version 0, a string version and a missing version are all unknown", () => {
    for (const version of [0, "1", undefined, null]) {
      const reader = file({ ...WIDE_OPEN, version });
      expect(serverBindHost(HOME, reader)).toBe("127.0.0.1");
      expect(tailscaleServeRequested(HOME, reader)).toBe(false);
    }
  });
});

describe("a damaged file never widens either", () => {
  test("unparseable text", () => {
    const damaged = serving("{ not json");
    expect(readRemotePosture(HOME, damaged).state).toBe("unreadable");
    expect(serverBindHost(HOME, damaged)).toBe("127.0.0.1");
    expect(tailscaleServeRequested(HOME, damaged)).toBe(false);
  });

  test("valid JSON that is not an object", () => {
    for (const value of [[], "remote", 7, null]) {
      const reader = serving(JSON.stringify(value));
      expect(readRemotePosture(HOME, reader).trusted).toBe(false);
      expect(serverBindHost(HOME, reader)).toBe("127.0.0.1");
    }
  });
});

describe("a missing file is a fresh store, which requires pairing", () => {
  const missing = serving(undefined);

  test("pairing on, nothing published", () => {
    const posture = readRemotePosture(HOME, missing);
    expect(posture.state).toBe("fresh");
    expect(posture.requireAuth).toBe(true);
    expect(posture.exposure).toBe("local-only");
    expect(serverBindHost(HOME, missing)).toBe("127.0.0.1");
    expect(tailscaleServeRequested(HOME, missing)).toBe(false);
  });

  test("and the gate requires auth", () => {
    expect(gateWillRequireAuth(HOME, missing)).toBe(true);
  });
});

describe("a known version is honoured, with both conditions", () => {
  test("widening needs the gate on", () => {
    expect(serverBindHost(HOME, file(WIDE_OPEN))).toBe("0.0.0.0");
    expect(serverBindHost(HOME, file({ ...WIDE_OPEN, requireAuth: false }))).toBe("127.0.0.1");
  });

  test("serve needs the gate on", () => {
    expect(tailscaleServeRequested(HOME, file(WIDE_OPEN))).toBe(true);
    expect(tailscaleServeRequested(HOME, file({ ...WIDE_OPEN, requireAuth: false }))).toBe(false);
  });

  test("anything but the one widening value reads as loopback", () => {
    for (const exposure of ["local-only", "network", "", undefined, true]) {
      expect(serverBindHost(HOME, file({ ...WIDE_OPEN, exposure }))).toBe("127.0.0.1");
    }
  });

  test("a truthy-but-not-true tailscaleServe does not publish", () => {
    for (const tailscaleServe of ["yes", 1, {}]) {
      expect(tailscaleServeRequested(HOME, file({ ...WIDE_OPEN, tailscaleServe }))).toBe(false);
    }
  });
});

describe("the version tracks the store's", () => {
  test("store.ts declares the version this module knows", () => {
    const storeTs = path.join(__dirname, "..", "..", "..", "web", "lib", "remote", "store.ts");
    const source = fs.readFileSync(storeTs, "utf8");
    const declared = source.match(/version:\s*(\d+);/)?.[1];
    expect(declared).toBeDefined();
    expect(Number(declared)).toBe(REMOTE_FILE_VERSION);
  });
});
